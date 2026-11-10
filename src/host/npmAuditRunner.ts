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
 * Resolution runs a few short probes, so it is cached per project root for
 * this runner's lifetime (one dashboard panel). A cached pair whose run
 * fails (other than a cancel or timeout) is dropped so the next scan resolves
 * again.
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
  type AuditRunner,
  type NodeAuditRunnerOptions,
} from '../core/audit/npmAudit.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation, type NpmResolutionResult } from './npmResolver.js';

type AuditSpawnConfig = NonNullable<NodeAuditRunnerOptions['spawnConfig']>;

export interface ResolvedNpmAuditRunnerDeps {
  platform: NodeJS.Platform;
  resolve(cwd: string): NpmResolutionResult;
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

export class ResolvedNpmAuditRunner implements AuditRunner {
  private readonly runners = new Map<string, AuditRunner>();

  constructor(private readonly deps: ResolvedNpmAuditRunnerDeps = defaultDeps()) {}

  async run(cwd: string, signal?: AbortSignal): Promise<{ stdout: string; exitCode: number | null }> {
    const runner = this.runnerFor(cwd);
    if (runner === null) {
      throw new AuditUnavailableError('npm could not be located for npm audit.');
    }
    try {
      return await runner.run(cwd, signal);
    } catch (error) {
      if (!isAbortOrTimeout(error)) this.runners.delete(cwd);
      throw error;
    }
  }

  private runnerFor(cwd: string): AuditRunner | null {
    const cached = this.runners.get(cwd);
    if (cached !== undefined) return cached;
    const spawnConfig = auditSpawnConfigFor(this.deps.resolve(cwd));
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
  }
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function defaultDeps(): ResolvedNpmAuditRunnerDeps {
  return {
    platform: process.platform,
    resolve: (cwd) => resolveNpmInvocation(createNodeNpmResolverDeps(cwd)),
    createRunner: (spawnConfig) => new NodeAuditRunner(spawnConfig === undefined ? {} : { spawnConfig }),
  };
}
