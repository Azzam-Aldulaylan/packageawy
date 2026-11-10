/**
 * `npm audit --json`: OPTIONAL enrichment for `fixAvailable` only.
 *
 * Per the spec's Vulnerability Scope, the bulk advisories endpoint is primary:
 * it returns the same advisory set 4.5x faster with no subprocess. Audit earns
 * its keep for exactly one field the bulk endpoint doesn't return,
 * `fixAvailable`, which is the only source that knows whether bumping a direct
 * dependency re-resolves a transitive advisory. Everything here is therefore
 * best-effort: if audit is missing, slow, or unparseable, the caller degrades to
 * the self-computed range check rather than failing.
 *
 * Three traps this file exists to avoid:
 *
 *  1. **The exit-code trap.** `npm audit --json` exits 1 when it finds
 *     vulnerabilities: the normal, successful outcome. Confirmed live against
 *     two scratch projects: exit code 1 alongside a complete, valid report on
 *     stdout. Branching on the exit code discards the enrichment on exactly the
 *     projects that have something to enrich, so nothing here reads it.
 *  2. **`fixAvailable.name` is not the entry's name.** The object form names
 *     the DIRECT dependency to bump, not the vulnerable package. Confirmed
 *     live: the `body-parser` entry (isDirect: false) carries
 *     `fixAvailable: { name: 'express', ... }`. Attributing a fix by the
 *     top-level key would put express's fix on body-parser's row.
 *  3. **The Windows `.cmd` trap (CVE-2024-27980).** npm resolves to `npm.cmd`
 *     on Windows, and patched Node throws `EINVAL` spawning a `.bat`/`.cmd`
 *     without `shell: true`. See `resolveAuditSpawnConfig` below for why that
 *     is safe here specifically because `AUDIT_ARGS` never carries anything
 *     user-controlled.
 */

import { spawn } from 'node:child_process';

import semver from 'semver';
import { terminateProcessTree } from '../async/processTree.js';
import type { FixAvailable } from '../types.js';

/**
 * Injectable seam, matching how HttpClient is injected rather than reaching for
 * node:https directly: it keeps the parsing and attribution logic testable
 * without spawning a real npm.
 */
export interface AuditRunner {
  run(cwd: string, signal?: AbortSignal): Promise<{ stdout: string; exitCode: number | null }>;
}

const AUDIT_ARGS = [
  'audit',
  '--json',
  // Confirmed in the spec: audit works from a lockfile alone, no install needed.
  '--package-lock-only',
  // Audit otherwise POSTs the dependency tree to whatever registry the project
  // .npmrc configures. Pin it to npm's advisory infrastructure.
  '--registry=https://registry.npmjs.org/',
];

/**
 * The platform-dependent half of the spawn call, pulled out so it can be unit
 * tested against a simulated `platform` without touching a real child process
 * or requiring an actual Windows machine.
 *
 * CVE-2024-27980: Node.js now throws EINVAL if a `.bat`/`.cmd` file is spawned
 * on Windows without `shell: true`: this is not optional/defensive, it is a
 * hard runtime error on patched Node (confirmed against the officially
 * documented fix: https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2,
 * "If the input to spawn/spawnSync is sanitized, users can now pass
 * `{ shell: true }`"). The documented guidance is explicit that this is only
 * safe when the input is sanitized: `AUDIT_ARGS` is a fixed literal array
 * with no interpolated or user-controlled content, which is what "sanitized"
 * means here. Never add a dynamic value to `AUDIT_ARGS` without re-reading
 * this comment. `cwd` is passed as a separate spawn option (the process's
 * working directory), never folded into the shell command line, so it is not
 * part of this trust boundary regardless of its contents.
 */
export function resolveAuditSpawnConfig(
  platform: NodeJS.Platform
): { command: string; shell: boolean } {
  const isWindows = platform === 'win32';
  return { command: isWindows ? 'npm.cmd' : 'npm', shell: isWindows };
}

/**
 * How long a single `npm audit` may run before the scan gives up on it. Audit
 * only adds `fixAvailable`, and the rows wait on it, so a proxy that silently
 * drops traffic must not hold the dashboard for minutes. One minute covers a
 * cold audit of a large monorepo on a slow link.
 */
export const DEFAULT_AUDIT_TIMEOUT_MS = 60_000;
/** Large monorepo reports run to a few MB. Anything past this is not a report. */
export const DEFAULT_AUDIT_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_AUDIT_TERMINATION_GRACE_MS = 1_000;

export interface NodeAuditRunnerOptions {
  timeoutMs?: number;
  stdoutLimitBytes?: number;
  terminationGraceMs?: number;
  /**
   * Run this command instead of the platform npm: the host's resolved node
   * executable with npm-cli.js as a prefix arg, or a fake npm in tests.
   * `prefixArgs` come before the fixed audit arguments. Never fed from user
   * input.
   */
  spawnConfig?: { command: string; prefixArgs?: readonly string[]; shell?: boolean };
}

export class NodeAuditRunner implements AuditRunner {
  constructor(private readonly options: NodeAuditRunnerOptions = {}) {}

  run(cwd: string, signal?: AbortSignal): Promise<{ stdout: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const abortError = (): Error =>
        Object.assign(new Error('npm audit was cancelled.'), { name: 'AbortError' });
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      // The extension host passes a resolved `<node> <npm-cli.js>` pair with no
      // shell (src/host/npmAuditRunner.ts). The platform default below is only
      // the fallback when no spawnConfig is given.
      const platformConfig = resolveAuditSpawnConfig(process.platform);
      const override = this.options.spawnConfig;
      const command = override?.command ?? platformConfig.command;
      const shell = override?.shell ?? (override === undefined ? platformConfig.shell : false);
      const child = spawn(command, [...(override?.prefixArgs ?? []), ...AUDIT_ARGS], {
        cwd,
        shell,
        windowsHide: true,
        // Audit never reads stdin. An open stdin pipe could leave it waiting.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own POSIX process group, so a timeout or cancel can stop npm and
        // everything npm started without signalling the extension host.
        detached: process.platform !== 'win32',
      });

      const stdoutLimit = this.options.stdoutLimitBytes ?? DEFAULT_AUDIT_STDOUT_LIMIT_BYTES;
      const grace = this.options.terminationGraceMs ?? DEFAULT_AUDIT_TERMINATION_GRACE_MS;
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let failure: Error | undefined;
      let settled = false;
      let treeTermination: Promise<void> = Promise.resolve();
      const timers: ReturnType<typeof setTimeout>[] = [];

      const cleanup = (): void => {
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const settleWithFailure = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void treeTermination.then(() => reject(error));
      };
      const stop = (error: Error): void => {
        if (failure !== undefined || settled) return;
        failure = error;
        treeTermination = terminateProcessTree(child, 'SIGTERM');
        const forceKill = setTimeout(() => {
          treeTermination = terminateProcessTree(child, 'SIGKILL');
          // A child stuck in uninterruptible I/O may never emit close. The
          // scan still moves on: the result is "audit unavailable" either way.
          const giveUp = setTimeout(() => settleWithFailure(error), grace);
          giveUp.unref();
          timers.push(giveUp);
        }, grace);
        forceKill.unref();
        timers.push(forceKill);
      };
      const abort = (): void => stop(abortError());

      const deadline = setTimeout(
        () => stop(Object.assign(new Error('npm audit timed out.'), { name: 'TimeoutError' })),
        this.options.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS
      );
      deadline.unref();
      timers.push(deadline);
      signal?.addEventListener('abort', abort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (failure !== undefined) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutLimit) {
          stop(new AuditUnavailableError('npm audit output exceeded the size limit.'));
          return;
        }
        stdoutChunks.push(chunk);
      });
      // Always drained and discarded: a full stderr pipe blocks the child, and
      // nothing here reads audit's progress or warning text.
      child.stderr.resume();

      // Only a genuine spawn failure (ENOENT: npm isn't on PATH at all) is a
      // rejection. A non-zero exit is the expected outcome. See trap 1 above.
      child.on('error', (error) => {
        failure ??= error;
        if (child.pid === undefined) settleWithFailure(error);
      });
      child.on('close', (exitCode) => {
        if (failure !== undefined) {
          // A leader can exit before a descendant that ignored SIGTERM.
          if (!settled) treeTermination = terminateProcessTree(child, 'SIGKILL');
          settleWithFailure(failure);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf8'), exitCode });
      });
    });
  }
}

/** One `vulnerabilities` entry, narrowed to the fields this feature uses. */
export interface AuditVulnerability {
  name: string;
  isDirect: boolean;
  fixAvailable: FixAvailable;
}

export class AuditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

function parseFixAvailable(raw: unknown): FixAvailable | null {
  if (raw === true || raw === false) return raw;
  if (typeof raw !== 'object' || raw === null) return null;

  const r = raw as Record<string, unknown>;
  const name = r['name'];
  const version = r['version'];
  const isSemVerMajor = r['isSemVerMajor'];
  if (typeof name !== 'string' || typeof version !== 'string' || typeof isSemVerMajor !== 'boolean') {
    return null;
  }
  return { name, version, isSemVerMajor };
}

/**
 * Parse `npm audit --json` stdout.
 *
 * Branches only on whether stdout is valid JSON of the expected shape: the
 * exit code is deliberately not a parameter here. A malformed individual entry
 * is dropped rather than thrown, matching bulk.ts's parseAdvisory: one bad
 * package must not discard the rest of the batch.
 */
export function parseNpmAuditOutput(stdout: string): AuditVulnerability[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new AuditUnavailableError('npm audit did not produce valid JSON');
  }
  if (typeof json !== 'object' || json === null) {
    throw new AuditUnavailableError('npm audit output was not a JSON object');
  }

  const block = (json as Record<string, unknown>)['vulnerabilities'];
  if (typeof block !== 'object' || block === null) {
    throw new AuditUnavailableError('npm audit output has no vulnerabilities block');
  }

  const out: AuditVulnerability[] = [];
  for (const [key, raw] of Object.entries(block as Record<string, unknown>)) {
    if (key === '__proto__') continue;
    if (typeof raw !== 'object' || raw === null) continue;

    const entry = raw as Record<string, unknown>;
    const name = entry['name'];
    const isDirect = entry['isDirect'];
    if (typeof name !== 'string' || typeof isDirect !== 'boolean') continue;

    const fixAvailable = parseFixAvailable(entry['fixAvailable']);
    if (fixAvailable === null) continue;

    out.push({ name, isDirect, fixAvailable });
  }
  return out;
}

/** Run audit and parse its output. The exit code is never inspected. */
export async function runNpmAudit(
  runner: AuditRunner,
  cwd: string,
  signal?: AbortSignal
): Promise<AuditVulnerability[]> {
  const result = await runner.run(cwd, signal);
  return parseNpmAuditOutput(result.stdout);
}

/** Non-throwing semver.gt: `version` is subprocess output, not a checked type. */
function isHigherVersion(candidate: string, current: string): boolean {
  if (semver.valid(candidate) === null) return false;
  if (semver.valid(current) === null) return true;
  return semver.gt(candidate, current);
}

/**
 * Map audit's fix information onto the direct dependencies it actually applies
 * to, keyed by direct-dependency name.
 *
 * The object form of `fixAvailable` already names the direct dependency to
 * bump, so that name (never the entry's own) is the candidate, and it is only
 * trusted when it matches a known direct dependency. The boolean form carries
 * no name, so it is only attributable when the entry is itself direct.
 * Anything else is dropped: misattributing a fix to the wrong row is worse than
 * offering no fix at all.
 */
export function mapFixAvailableToDirectDependencies(
  vulnerabilities: readonly AuditVulnerability[],
  directDependencyNames: ReadonlySet<string>
): Map<string, FixAvailable> {
  const result = new Map<string, FixAvailable>();

  for (const entry of vulnerabilities) {
    const fix = entry.fixAvailable;

    if (typeof fix === 'boolean') {
      // No name to validate, only the entry's name can be meant, and only
      // when the entry is a direct dependency. A transitive entry's boolean is
      // unattributable. Guessing a parent would be a fabrication.
      if (!entry.isDirect || !directDependencyNames.has(entry.name)) continue;
      // An object is strictly more informative. Never clobber one.
      if (typeof result.get(entry.name) === 'object') continue;
      result.set(entry.name, fix);
      continue;
    }

    if (!directDependencyNames.has(fix.name)) continue;

    const existing = result.get(fix.name);
    // Two vulnerabilities can resolve to the same direct bump at different
    // versions. The higher one satisfies both. An object always beats a prior
    // boolean, which carries no version at all.
    if (typeof existing === 'object' && !isHigherVersion(fix.version, existing.version)) continue;
    result.set(fix.name, fix);
  }

  return result;
}
