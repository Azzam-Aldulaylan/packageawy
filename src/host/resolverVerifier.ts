/**
 * Package-manager resolver verification in an isolated temporary project.
 *
 * The safety boundary is the temporary directory, not a package manager's
 * interpretation of "dry run": only a host-owned manifest and active
 * lockfile are copied, workspace configuration is deliberately not copied,
 * lifecycle scripts are disabled, and the real project is never the cwd.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type {
  ResolverVerification,
  ResolverVerifier,
  SupportedPackageManager,
  UpgradeProposal,
} from '../core/compatibility/types.js';
import type { PeerResolutionPolicy } from '../core/compatibility/types.js';
import { buildDependencyGraph } from '../core/lockfile/build.js';
import { parseManifest } from '../core/manifest/parse.js';
import { buildTransitiveRemediationArgs } from '../core/upgrade/plan.js';
import { buildStagedManifest } from '../core/upgrade/stagedManifest.js';
import type { DependencyGraph, ResolvedRegistry } from '../core/types.js';
import { stripUrlCredentials } from '../core/cache/keys.js';
import { NodePackageManagerProcessRunner } from './packageManagerProcessRunner.js';

export interface PackageManagerInvocation {
  executable: string;
  prefixArgs: readonly string[];
  /** May be captured by the invocation resolver's existing health probe. */
  version?: string;
}

export interface ResolverProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ResolverProcessRunner {
  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult>;
}

export class NodeResolverProcessRunner implements ResolverProcessRunner {
  private readonly runner: NodePackageManagerProcessRunner;

  constructor(options: { timeoutMs?: number; terminationGraceMs?: number } = {}) {
    // Only opt-in callers impose a deadline. Mutation/cleanup policies stay
    // unchanged; Upgrade Review can select its bounded analysis budget.
    this.runner = new NodePackageManagerProcessRunner({ description: 'Package-manager analysis', ...options });
  }

  run(
    invocation: PackageManagerInvocation,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<ResolverProcessResult> {
    return this.runner.run(invocation, args, cwd, signal);
  }
}

export interface IsolatedResolverVerifierOptions {
  packageManager: SupportedPackageManager;
  packageManagerVersion: string | null;
  invocation: PackageManagerInvocation;
  manifestText: string;
  lockfile?: { name: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml'; text: string };
  registry: string;
  /** Full .npmrc routing. Its scoped registries become `--@scope:registry=` flags. */
  resolvedRegistry?: ResolvedRegistry;
  policy: PeerResolutionPolicy;
  runner?: ResolverProcessRunner;
  /** Upgrade Review shares this materialization with its deferred security check. */
  retainResolvedGraph?: boolean;
}

const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9._-]*$/i;

/**
 * One `--@scope:registry=<url>` flag per scope, sorted by scope. These become
 * command-line arguments, so a scope or URL that is not plainly valid is
 * skipped rather than passed through. Both npm and pnpm accept this form.
 */
export function buildScopedRegistryArgs(scoped: Readonly<Record<string, string>> = {}): string[] {
  const args: string[] = [];
  for (const scope of Object.keys(scoped).sort()) {
    const raw = scoped[scope];
    if (raw === undefined || !SCOPE_PATTERN.test(scope) || /\s/.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    args.push(`--${scope}:registry=${stripUrlCredentials(raw)}`);
  }
  return args;
}

export function buildResolverArgs(
  manager: SupportedPackageManager,
  registry: string,
  policy: PeerResolutionPolicy,
  scoped: Readonly<Record<string, string>> = {}
): string[] {
  const policyArgs: string[] = [];
  if (policy.legacyPeerDeps && manager === 'npm') policyArgs.push('--legacy-peer-deps');
  else if (policy.strictPeerDeps) {
    policyArgs.push(manager === 'pnpm' ? '--strict-peer-dependencies' : '--strict-peer-deps');
  }

  if (manager === 'npm') {
    return [
      'install',
      '--dry-run',
      '--ignore-scripts',
      '--package-lock=false',
      '--audit=false',
      '--fund=false',
      '--json',
      `--registry=${registry}`,
      ...buildScopedRegistryArgs(scoped),
      ...policyArgs,
    ];
  }
  return [
    'install',
    '--ignore-scripts',
    '--lockfile=false',
    '--reporter=silent',
    `--registry=${registry}`,
    ...buildScopedRegistryArgs(scoped),
    ...policyArgs,
  ];
}

/**
 * Argv for the "materialize a real lockfile" step used by
 * `materializeResolvedGraph`: `--package-lock-only`/`--lockfile-only` runs
 * the real resolver and writes a real lockfile without downloading
 * `node_modules` content. This is deliberately a separate argv builder from
 * `buildResolverArgs`: that one is a dry-run that writes nothing, this one
 * must actually produce a lockfile to parse.
 */
export function buildLockfileMaterializationArgs(
  manager: SupportedPackageManager,
  registry: string,
  policy: PeerResolutionPolicy,
  scoped: Readonly<Record<string, string>> = {}
): string[] {
  const policyArgs: string[] = [];
  if (policy.legacyPeerDeps && manager === 'npm') policyArgs.push('--legacy-peer-deps');
  else if (policy.strictPeerDeps) {
    policyArgs.push(manager === 'pnpm' ? '--strict-peer-dependencies' : '--strict-peer-deps');
  }

  if (manager === 'npm') {
    return [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--audit=false',
      '--fund=false',
      '--json',
      `--registry=${registry}`,
      ...buildScopedRegistryArgs(scoped),
      ...policyArgs,
    ];
  }
  return [
    'install',
    '--lockfile-only',
    '--ignore-scripts',
    '--reporter=silent',
    `--registry=${registry}`,
    ...buildScopedRegistryArgs(scoped),
    ...policyArgs,
  ];
}

/**
 * Literal, script-free argv for a targeted transitive remediation performed
 * only inside an isolated copy of the current manifest and lockfile.
 */
export function buildTransitiveRemediationMaterializationArgs(
  manager: SupportedPackageManager,
  packageNames: readonly string[],
  registry: string,
  policy: PeerResolutionPolicy,
  scoped: Readonly<Record<string, string>> = {}
): string[] {
  const args = buildTransitiveRemediationArgs(manager, packageNames, { ignoreScripts: true });
  if (manager === 'npm') {
    args.push('--audit=false', '--fund=false', '--json', `--registry=${registry}`, ...buildScopedRegistryArgs(scoped));
    if (policy.legacyPeerDeps) args.push('--legacy-peer-deps');
    else if (policy.strictPeerDeps) args.push('--strict-peer-deps');
  } else {
    args.push('--reporter=silent', `--registry=${registry}`, ...buildScopedRegistryArgs(scoped));
    if (policy.strictPeerDeps) args.push('--strict-peer-dependencies');
  }
  return args;
}

function diagnostic(result: ResolverProcessResult, tempRoot: string): string {
  const combined = `${result.stderr}\n${result.stdout}`
    .replaceAll(tempRoot, '<temporary-project>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return combined.length === 0 ? 'The package manager returned no diagnostic.' : combined.slice(0, 500);
}

function verificationForResult(
  manager: SupportedPackageManager,
  version: string | null,
  result: ResolverProcessResult,
  tempRoot: string
): ResolverVerification {
  if (result.exitCode === 0) {
    return {
      status: 'compatible',
      packageManager: manager,
      packageManagerVersion: version,
      code: 'RESOLVED',
      explanation: 'The package manager resolved the proposed dependency set in an isolated temporary project.',
    };
  }
  const details = diagnostic(result, tempRoot);
  const peerConflict = /ERESOLVE|peer dep|peer-dependenc|ERR_PNPM_PEER_DEP_ISSUES/i.test(details);
  return {
    status: peerConflict ? 'conflict' : 'unknown',
    packageManager: manager,
    packageManagerVersion: version,
    code: peerConflict ? 'RESOLUTION_CONFLICT' : 'RESOLVER_FAILED',
    explanation: `Isolated resolver verification failed: ${details}`,
  };
}

export class IsolatedResolverVerifier implements ResolverVerifier {
  private readonly runner: ResolverProcessRunner;
  private readonly reviewResolutions = new Map<string, Promise<ResolverVerification>>();
  private readonly reviewGraphs = new Map<string, DependencyGraph>();

  private proposalKey(proposal: UpgradeProposal): string {
    return JSON.stringify(proposal.changes.map(({ packageName, targetVersion, classification }) =>
      [packageName, targetVersion, classification]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }

  constructor(private readonly options: IsolatedResolverVerifierOptions) {
    this.runner = options.runner ?? new NodeResolverProcessRunner();
  }

  async verify(proposal: UpgradeProposal, signal?: AbortSignal): Promise<ResolverVerification> {
    if (!this.options.retainResolvedGraph) return this.verifyProposal(proposal, signal);
    const key = this.proposalKey(proposal);
    let pending = this.reviewResolutions.get(key);
    if (pending === undefined) {
      pending = this.verifyProposal(proposal, signal);
      this.reviewResolutions.set(key, pending);
    }
    return pending;
  }

  private async verifyProposal(proposal: UpgradeProposal, signal?: AbortSignal): Promise<ResolverVerification> {
    const stagedManifest = buildStagedManifest(
      this.options.manifestText,
      proposal.changes.map((change) => ({
        packageName: change.packageName,
        target: change.targetVersion,
        classification: change.classification,
      }))
    );
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'packageawy-preflight-'));
    try {
      await writeFile(path.join(tempRoot, 'package.json'), stagedManifest, 'utf8');
      if (this.options.lockfile !== undefined) {
        await writeFile(path.join(tempRoot, this.options.lockfile.name), this.options.lockfile.text, 'utf8');
      }
      const result = await this.runner.run(
        this.options.invocation,
        (this.options.retainResolvedGraph ? buildLockfileMaterializationArgs : buildResolverArgs)(
          this.options.packageManager,
          this.options.registry,
          this.options.policy,
          this.options.resolvedRegistry?.scoped
        ),
        tempRoot,
        signal
      );
      if (this.options.retainResolvedGraph && result.exitCode === 0) {
        try {
          const lockfileName = this.options.packageManager === 'pnpm' ? 'pnpm-lock.yaml'
            : this.options.lockfile?.name ?? 'package-lock.json';
          const lockfileText = await readFile(path.join(tempRoot, lockfileName), 'utf8');
          this.reviewGraphs.set(this.proposalKey(proposal), buildDependencyGraph({
            root: tempRoot, manifest: parseManifest(stagedManifest), lockfileText,
            packageManager: this.options.packageManager,
          }));
        } catch {
          // Resolution can succeed without a parseable graph. Security stays unavailable.
        }
      }
      return verificationForResult(
        this.options.packageManager,
        this.options.packageManagerVersion,
        result,
        tempRoot
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  /**
   * Best-effort: materializes the real, proposed post-upgrade dependency tree
   * by running the real package manager's resolver in the same isolated
   * temp-dir pattern as `verify()`, then parsing its output lockfile with the
   * existing lockfile parser, never a second, hand-rolled resolver. Used
   * only to answer "does a transitive vulnerability remain" (see
   * evaluateSecurityOutcome in src/core/advisories/securityOutcome.ts). Any
   * failure here degrades that answer to `unknown`, never a wrong guess.
   *
   * `proposal.changes` may be empty: this is the "no direct-dependency
   * version change proposed at all" case a transitive-remediation analysis
   * uses (see resolveRemediationRequest / handleAnalyzeRemediation): the
   * manifest is staged unchanged, and whether the lockfile passed to this
   * verifier's constructor is supplied determines whether the package
   * manager reuses it or resolves fully fresh from declared ranges.
   * `buildStagedManifest` itself rejects an empty change list (it exists to
   * pin exact versions, which there are none of here), so that step is
   * skipped entirely rather than passed a list it would reject.
   */
  async materializeResolvedGraph(
    proposal: UpgradeProposal,
    signal?: AbortSignal
  ): Promise<{ ok: true; graph: DependencyGraph } | { ok: false }> {
    if (this.options.retainResolvedGraph && proposal.changes.length > 0) {
      await this.verify(proposal, signal);
      const graph = this.reviewGraphs.get(this.proposalKey(proposal));
      return graph === undefined ? { ok: false } : { ok: true, graph };
    }
    const stagedManifest =
      proposal.changes.length === 0
        ? this.options.manifestText
        : buildStagedManifest(
            this.options.manifestText,
            proposal.changes.map((change) => ({
              packageName: change.packageName,
              target: change.targetVersion,
              classification: change.classification,
            }))
          );
    const lockfileName = this.options.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'packageawy-security-outcome-'));
    try {
      await writeFile(path.join(tempRoot, 'package.json'), stagedManifest, 'utf8');
      if (this.options.lockfile !== undefined) {
        await writeFile(path.join(tempRoot, this.options.lockfile.name), this.options.lockfile.text, 'utf8');
      }
      const result = await this.runner.run(
        this.options.invocation,
        buildLockfileMaterializationArgs(
          this.options.packageManager,
          this.options.registry,
          this.options.policy,
          this.options.resolvedRegistry?.scoped
        ),
        tempRoot,
        signal
      );
      if (result.exitCode !== 0) return { ok: false };

      const lockfileText = await readFile(path.join(tempRoot, lockfileName), 'utf8');
      const manifest = parseManifest(stagedManifest);
      const graph = buildDependencyGraph({
        root: tempRoot,
        manifest,
        lockfileText,
        packageManager: this.options.packageManager,
      });
      return { ok: true, graph };
    } catch {
      return { ok: false };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  /**
   * Produces an applyable remediation candidate from the existing lockfile,
   * unlike `materializeResolvedGraph`'s intentionally broad lockfile-free
   * proof. The real package manager performs a targeted, lockfile-only update
   * in a temporary project. Package.json must remain byte-for-byte unchanged.
   */
  async materializeTransitiveRemediation(
    packageNames: readonly string[],
    signal?: AbortSignal
  ): Promise<
    | { ok: true; graph: DependencyGraph; beforeGraph: DependencyGraph; lockfileText: string }
    | { ok: false; reason: string }
  > {
    if (this.options.lockfile === undefined) {
      return { ok: false, reason: 'A supported active lockfile is required for an automatic transitive fix.' };
    }
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'packageawy-transitive-remediation-'));
    try {
      await writeFile(path.join(tempRoot, 'package.json'), this.options.manifestText, 'utf8');
      await writeFile(path.join(tempRoot, this.options.lockfile.name), this.options.lockfile.text, 'utf8');
      const manifest = parseManifest(this.options.manifestText);
      const beforeGraph = buildDependencyGraph({
        root: tempRoot,
        manifest,
        lockfileText: this.options.lockfile.text,
        packageManager: this.options.packageManager,
      });
      const result = await this.runner.run(
        this.options.invocation,
        buildTransitiveRemediationMaterializationArgs(
          this.options.packageManager,
          packageNames,
          this.options.registry,
          this.options.policy,
          this.options.resolvedRegistry?.scoped
        ),
        tempRoot,
        signal
      );
      if (result.exitCode !== 0) {
        return { ok: false, reason: `Targeted transitive resolution failed: ${diagnostic(result, tempRoot)}` };
      }
      const writtenManifest = await readFile(path.join(tempRoot, 'package.json'), 'utf8');
      if (writtenManifest !== this.options.manifestText) {
        return { ok: false, reason: 'The package manager unexpectedly changed package.json while resolving a transitive fix.' };
      }
      const lockfileText = await readFile(path.join(tempRoot, this.options.lockfile.name), 'utf8');
      const graph = buildDependencyGraph({
        root: tempRoot,
        manifest,
        lockfileText,
        packageManager: this.options.packageManager,
      });
      return { ok: true, graph, beforeGraph, lockfileText };
    } catch (cause) {
      return {
        ok: false,
        reason: signal?.aborted === true
          ? 'Transitive remediation analysis was cancelled.'
          : cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
