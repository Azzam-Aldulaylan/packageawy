import semver from 'semver';
import { fetchBulkAdvisories } from '../core/advisories/bulk.js';
import type { HttpClient } from '../core/registry/http.js';
import type { PackageRow, Severity } from '../core/types.js';
import type { UpdateAdvisoryResult } from './webviewProtocol.js';
import { updateAdvisoryKey } from './updateAdvisoryState.js';

export type UpdateVersionPair = { name: string; version: string };
const severityRank: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

export function offeredVersionPairs(rows: readonly PackageRow[]): UpdateVersionPair[] {
  return rows.flatMap(row => [row.upgradeTo, row.latest, row.wanted]
    .filter((version): version is string => version !== null)
    .map(version => ({ name: row.registryName ?? row.name, version })));
}

/** Panel memory only. One queue shares the bulk client's two-worker budget with picker requests. */
export class UpdateAdvisories {
  private abort = new AbortController();
  private settled = new Map<string, UpdateAdvisoryResult>();
  private pending = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly client: HttpClient, private readonly enabled: () => boolean) {}

  clear(keepSettled = false): void {
    this.abort.abort();
    this.abort = new AbortController();
    if (!keepSettled) this.settled.clear();
    this.pending.clear();
    this.queue = Promise.resolve();
  }

  results(): UpdateAdvisoryResult[] { return [...this.settled.values()]; }

  enrich(pairs: readonly UpdateVersionPair[],
    isCurrent: () => boolean, publish: (results: UpdateAdvisoryResult[]) => void): Promise<void> {
    if (!this.enabled() || !isCurrent()) return Promise.resolve();
    const signal = this.abort.signal;
    const missing = pairs.filter(pair => {
      const key = updateAdvisoryKey(pair.name, pair.version);
      if (this.settled.has(key) || this.pending.has(key)) return false;
      this.pending.add(key);
      return true;
    });
    if (missing.length === 0) return this.queue;
    const run = async (): Promise<void> => {
      if (signal.aborted || !this.enabled() || !isCurrent()) return;
      const body: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
      const valid = missing.filter(pair => semver.valid(pair.version) !== null);
      for (const { name, version } of valid) (body[name] ??= []).push(version);
      let results: UpdateAdvisoryResult[];
      try {
        // Strict evidence parsing prevents malformed entries/ranges from implying a clean version.
        const advisories = await fetchBulkAdvisories(this.client, body, signal, this.enabled, true);
        results = missing.map(pair => {
          if (semver.valid(pair.version) === null) return { ...pair, status: 'unavailable' };
          const matching = (advisories.get(pair.name) ?? []).filter(advisory =>
            semver.satisfies(pair.version, advisory.vulnerableVersions, { includePrerelease: true }));
          const unique = [...new Map(matching.map(advisory => [advisory.id, advisory])).values()];
          const highestSeverity = unique.reduce<Severity | null>((highest, advisory) => highest === null ||
            severityRank.indexOf(advisory.severity) > severityRank.indexOf(highest) ? advisory.severity : highest, null);
          return { ...pair, status: 'checked', count: unique.length, highestSeverity };
        });
      } catch {
        results = missing.map(pair => ({ ...pair, status: 'unavailable' }));
      }
      if (signal.aborted || !this.enabled() || !isCurrent()) return;
      for (const result of results) {
        const key = updateAdvisoryKey(result.name, result.version);
        this.pending.delete(key);
        this.settled.set(key, result);
      }
      publish(this.results());
    };
    // Dispatch on a later microtask, after the caller has posted the rows or picker options.
    this.queue = this.queue.then(run);
    return this.queue;
  }
}
