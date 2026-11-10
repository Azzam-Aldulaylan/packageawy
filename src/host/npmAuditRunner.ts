/**
 * The dashboard's `npm audit` runner, launched the same way every other npm
 * call in the extension is: `<node> <npm-cli.js> audit ...` with no shell,
 * using the pair `resolveNpmInvocation` finds (see npmResolver.ts).
 *
 * Without this, NodeAuditRunner falls back to the platform default, which on
 * Windows is `npm.cmd` with `shell: true`. Newer Node (Node 24, in current
 * VS Code builds) logs DEP0190 for every spawn that passes args with a shell,
 * so every scan and Refresh printed a deprecation warning.
 *
 * Resolution is asynchronous and cancellable (npmResolverAsync.ts): it
 * starts when the scan starts audit, which the pipeline already runs alongside
 * the registry requests, so it never blocks the event loop, cancellation or
 * RPC. The result is cached per project root for this runner's lifetime (one
 * dashboard panel). A cached pair is dropped so the next scan resolves again
 * when its run fails (other than a cancel or timeout) or its output is not an
 * audit report (for example npm-cli.js was removed and node printed only an
 * error). npm audit exits 1 when it finds vulnerabilities, so the exit code
 * alone never invalidates.
 *
 * When resolution fails:
 *   - Windows: audit is reported unavailable. Upgrades already require the
 *     resolved pair on Windows, and falling back to `npm.cmd` would bring the
 *     shell (and the warning) back for exactly the installs npm cannot be
 *     located on. Audit is optional enrichment; the scan degrades as it does
 *     today when npm is missing.
 *   - POSIX: the previous behaviour, `npm` from PATH with no shell.
 */

import {
  AuditUnavailableError,
  NodeAuditRunner,
  parseNpmAuditOutput,
  type AuditRunner,
  type NodeAuditRunnerOptions,
} from '../core/audit/npmAudit.js';
import type { NpmResolutionResult } from './npmResolver.js';
import { createNodeNpmResolverAsyncDeps, resolveNpmInvocationAsync } from './npmResolverAsync.js';

type AuditSpawnConfig = NonNullable<NodeAuditRunnerOptions['spawnConfig']>;
type AuditResult = { stdout: string; exitCode: number | null };

export interface ResolvedNpmAuditRunnerDeps {
  platform: NodeJS.Platform;
  /** Must not block; rejects with an AbortError when `signal` aborts. */
  resolve(cwd: string, signal?: AbortSignal): Promise<NpmResolutionResult>;
  /** `spawnConfig` undefined means the platform default (POSIX fallback only). */
  createRunner(spawnConfig: AuditSpawnConfig | undefined): AuditRunner;
}

/** The spawn config for a resolved pair: node runs npm-cli.js directly, no shell. */
export function auditSpawnConfigFor(resolution: NpmResolutionResult): AuditSpawnConfig | undefined {
  if (!resolution.ok) return undefined;
  return {
    command: resolution.invocation.node,
    prefixArgs: [resolution.invocation.npmCliJs],
    shell: false,
  };
}

/** True when stdout is an audit report the scan can use. */
export function isUsableAuditOutput(stdout: string): boolean {
  try {
    parseNpmAuditOutput(stdout);
    return true;
  } catch {
    return false;
  }
}

export class ResolvedNpmAuditRunner implements AuditRunner {
  private readonly runners = new Map<string, AuditRunner>();
  private readonly pending = new Map<string, Promise<AuditRunner | null>>();

  constructor(private readonly deps: ResolvedNpmAuditRunnerDeps = defaultDeps()) {}

  async run(cwd: string, signal?: AbortSignal): Promise<AuditResult> {
    if (signal?.aborted) throw abortError();
    const runner = await this.runnerFor(cwd, signal);
    if (runner === null) {
      throw new AuditUnavailableError('npm could not be located for npm audit.');
    }
    let result: AuditResult;
    try {
      result = await runner.run(cwd, signal);
    } catch (error) {
      if (!isAbortOrTimeout(error)) this.invalidate(cwd, runner);
      throw error;
    }
    if (!isUsableAuditOutput(result.stdout)) this.invalidate(cwd, runner);
    return result;
  }

  private invalidate(cwd: string, runner: AuditRunner): void {
    if (this.runners.get(cwd) === runner) this.runners.delete(cwd);
  }

  private async runnerFor(cwd: string, signal: AbortSignal | undefined): Promise<AuditRunner | null> {
    const cached = this.runners.get(cwd);
    if (cached !== undefined) return cached;
    const inFlight = this.pending.get(cwd);
    if (inFlight !== undefined) {
      try {
        return await raceAbort(inFlight, signal);
      } catch (error) {
        // Another scan's cancel stopped the shared resolution; this one goes on.
        if (signal?.aborted || !isAbortOrTimeout(error)) throw error;
      }
    }
    return this.resolveRunner(cwd, signal);
  }

  private resolveRunner(cwd: string, signal: AbortSignal | undefined): Promise<AuditRunner | null> {
    const promise = (async () => {
      const spawnConfig = auditSpawnConfigFor(await this.deps.resolve(cwd, signal));
      const runner =
        spawnConfig !== undefined
          ? this.deps.createRunner(spawnConfig)
          : this.deps.platform === 'win32'
            ? null
            : this.deps.createRunner(undefined);
      // A failed Windows resolution is not cached: with no Node install the
      // probes are plain existence checks, and a later install is picked up.
      if (runner !== null) this.runners.set(cwd, runner);
      return runner;
    })();
    this.pending.set(cwd, promise);
    const clear = (): void => {
      if (this.pending.get(cwd) === promise) this.pending.delete(cwd);
    };
    promise.then(clear, clear);
    return promise;
  }
}

/**
 * Waits on a lookup another scan started, but lets this caller's own cancel
 * end its wait at once. The shared lookup keeps running for the others.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function abortError(): Error {
  return Object.assign(new Error('npm audit was cancelled.'), { name: 'AbortError' });
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function defaultDeps(): ResolvedNpmAuditRunnerDeps {
  return {
    platform: process.platform,
    resolve: (cwd, signal) => resolveNpmInvocationAsync(createNodeNpmResolverAsyncDeps(cwd, signal)),
    createRunner: (spawnConfig) => new NodeAuditRunner(spawnConfig === undefined ? {} : { spawnConfig }),
  };
}
