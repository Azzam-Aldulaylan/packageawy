import semver from 'semver';
import { fetchBulkAdvisories } from '../core/advisories/bulk.js';
import type { HttpClient } from '../core/registry/http.js';
import type { PackageRow, Severity } from '../core/types.js';
import type { UpdateAdvisoryResult } from './webviewProtocol.js';
import { isInstalledVersion, updateAdvisoryKey } from './updateAdvisoryState.js';

export type UpdateVersionPair = { name: string; version: string };
const severityRank: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * Only the offered upgrade is checked: it is the one version the table
 * marks. The installed version is skipped (the Vulnerabilities column
 * covers it), and the upgrade review checks its own version list.
 */
export function offeredVersionPairs(rows: readonly PackageRow[]): UpdateVersionPair[] {
  // Older alias rows may lack a registry identity. Leave their versions
  // unchecked until a scan supplies it rather than checking the installed name.
  return rows.filter(row => row.registryName !== undefined ||
    (row.unresolvable !== 'alias' && !row.range.trim().startsWith('npm:')))
    .flatMap(row => row.upgradeTo === null || isInstalledVersion(row.current, row.upgradeTo) ? []
      : [{ name: row.registryName ?? row.name, version: row.upgradeTo }]);
}

/** Panel memory only. One queue shares the bulk client's two-worker budget with picker requests. */
export class UpdateAdvisories {
  private abort = new AbortController();
  private settled = new Map<string, UpdateAdvisoryResult>();
  private pending = new Set<string>();
  /** Settled but not yet delivered to anyone who asked (the asker left first). */
  private unpublished = new Set<string>();
  /** Always settles: a failing job never blocks the jobs queued after it. */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by clear(), so a job failing after a clear does not touch the new state. */
  private generation = 0;

  constructor(
    private readonly client: HttpClient,
    private readonly enabled: () => boolean,
    /** Told about an unexpected failure inside a job. Must not throw; a throw is ignored. */
    private readonly report: (error: unknown) => void = () => undefined
  ) {}

  clear(keepSettled = false): void {
    this.abort.abort();
    this.abort = new AbortController();
    if (!keepSettled) this.settled.clear();
    this.pending.clear();
    this.unpublished.clear();
    this.queue = Promise.resolve();
    this.generation += 1;
  }

  results(): UpdateAdvisoryResult[] { return [...this.settled.values()]; }

  /**
   * `wanted` lets a caller that no longer needs the answer (a closed version
   * list) skip its work. Skipped versions are released, and results fetched
   * for a caller that left are kept but marked unpublished, so the next
   * caller asking for them (a reopened list) still receives them.
   */
  enrich(pairs: readonly UpdateVersionPair[],
    isCurrent: () => boolean, publish: (results: UpdateAdvisoryResult[]) => void,
    wanted: () => boolean = () => true): Promise<void> {
    if (!this.enabled() || !isCurrent()) return Promise.resolve();
    const signal = this.abort.signal;
    const keyOf = (pair: UpdateVersionPair): string => updateAdvisoryKey(pair.name, pair.version);
    const claim = (): UpdateVersionPair[] => pairs.filter(pair => {
      const key = keyOf(pair);
      if (this.settled.has(key) || this.pending.has(key)) return false;
      this.pending.add(key);
      return true;
    });
    const missing = claim();
    // Versions another caller is still checking: that caller may leave and
    // release them, so this caller looks again once its turn comes.
    const heldElsewhere = pairs.some(pair => this.pending.has(keyOf(pair)) && !missing.includes(pair));
    const owed = pairs.some(pair => this.unpublished.has(keyOf(pair)));
    if (missing.length === 0 && !heldElsewhere && !owed) return this.queue;
    const generation = this.generation;
    let claimed = missing;
    const run = async (): Promise<void> => {
      if (signal.aborted || !this.enabled() || !isCurrent()) return;
      const work = heldElsewhere ? [...missing, ...claim()] : missing;
      claimed = work;
      if (!wanted()) {
        for (const pair of work) this.pending.delete(keyOf(pair));
        return;
      }
      if (work.length > 0) {
        const results = await this.check(work, signal);
        if (signal.aborted || !this.enabled() || !isCurrent()) return;
        for (const result of results) {
          const key = updateAdvisoryKey(result.name, result.version);
          this.pending.delete(key);
          this.settled.set(key, result);
          this.unpublished.add(key);
        }
      }
      if (!wanted()) return;
      if (!pairs.some(pair => this.unpublished.has(keyOf(pair)))) return;
      publish(this.results());
      // Every settled result went out in that snapshot, so nothing is owed any
      // more. Cleared only after a publish that did not throw.
      this.unpublished.clear();
    };
    const guarded = async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        // Release this job's claims so a later caller can check those versions.
        // Skipped when clear() ran in between (for example wanted() threw, and
        // the panel cleared and a new caller claimed the same version before
        // this catch ran): those keys now belong to the new state.
        if (this.generation === generation) {
          for (const pair of claimed) {
            const key = keyOf(pair);
            if (!this.settled.has(key)) this.pending.delete(key);
          }
        }
        try {
          this.report(error);
        } catch {
          // The reporter must not break the queue either.
        }
      }
    };
    // Dispatch on a later microtask, after the caller has posted the rows or picker options.
    const task = this.queue.then(guarded);
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async check(work: readonly UpdateVersionPair[], signal: AbortSignal): Promise<UpdateAdvisoryResult[]> {
    const body: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    const valid = work.filter(pair => semver.valid(pair.version) !== null);
    for (const { name, version } of valid) (body[name] ??= []).push(version);
    try {
      // Strict evidence parsing prevents malformed entries/ranges from implying a clean version.
      const advisories = await fetchBulkAdvisories(this.client, body, signal, this.enabled, true);
      return work.map(pair => {
        if (semver.valid(pair.version) === null) return { ...pair, status: 'unavailable' };
        const matching = (advisories.get(pair.name) ?? []).filter(advisory =>
          semver.satisfies(pair.version, advisory.vulnerableVersions, { includePrerelease: true }));
        const unique = [...new Map(matching.map(advisory => [advisory.id, advisory])).values()];
        const highestSeverity = unique.reduce<Severity | null>((highest, advisory) => highest === null ||
          severityRank.indexOf(advisory.severity) > severityRank.indexOf(highest) ? advisory.severity : highest, null);
        return { ...pair, status: 'checked', count: unique.length, highestSeverity };
      });
    } catch {
      return work.map(pair => ({ ...pair, status: 'unavailable' }));
    }
  }
}
