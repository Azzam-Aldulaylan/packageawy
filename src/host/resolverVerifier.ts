/**
 * Package-manager resolver verification in an isolated temporary project.
 *
 * The safety boundary is the temporary directory, not a package manager's
 * interpretation of "dry run": only a host-owned manifest and active
 * lockfile are copied, lifecycle scripts are disabled, and the real project
 * is never the cwd. A pnpm workspace member also gets the workspace's own
 * manifests and pnpm-workspace.yaml, so `workspace:` and `catalog:`
 * specifiers resolve. .npmrc files and pnpmfiles are never copied, and pnpm
 * runs with --ignore-pnpmfile.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { load as loadYaml } from 'js-yaml';

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

/** The pnpm workspace around the reviewed project, rebuilt inside the temporary directory. */
export interface IsolatedWorkspaceLayout {
  /** pnpm importer id of the reviewed project: `.` or a lock-root-relative POSIX path. */
  importerId: string;
  /**
   * Lock-root-relative POSIX paths with their contents: pnpm-workspace.yaml
   * and the other workspace manifests. The reviewed manifest is written from
   * `manifestText` instead.
   */
  files: readonly { path: string; text: string }[];
  /** Set when the workspace cannot be staged faithfully. Resolution is then skipped and stays unknown. */
  unavailableReason?: string;
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
  /** Set for a pnpm workspace. The lockfile then belongs to the workspace root. */
  workspace?: IsolatedWorkspaceLayout;
}

/**
 * Maps a lock-root-relative POSIX path into the temporary directory. Paths
 * come from lockfile importer ids, so anything absolute or with a `.` or
 * `..` segment is refused.
 */
export function isolatedRelativePath(tempRoot: string, relative: string): string {
  const segments = relative.split('/');
  if (relative.includes('\\') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Refusing an unsafe workspace path: ${relative}`);
  }
  return path.join(tempRoot, ...segments);
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
    '--ignore-pnpmfile',
    '--lockfile=false',
    '--loglevel=error',
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
    '--ignore-pnpmfile',
    '--loglevel=error',
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

  /** pnpm can succeed while leaving a member out of the workspace, so its importer must be in the written lockfile. */
  private async resolvedWorkspaceImporter(tempRoot: string): Promise<boolean> {
    try {
      const lock = loadYaml(await readFile(path.join(tempRoot, 'pnpm-lock.yaml'), 'utf8'));
      const importers = typeof lock === 'object' && lock !== null ? (lock as Record<string, unknown>)['importers'] : undefined;
      return typeof importers === 'object' && importers !== null &&
        Object.prototype.hasOwnProperty.call(importers, this.options.workspace?.importerId ?? '.');
    } catch {
      return false;
    }
  }

  private importerOption(): { importerId?: string } {
    return this.options.workspace === undefined ? {} : { importerId: this.options.workspace.importerId };
  }

  /**
   * Writes the manifest and active lockfile into the temporary directory and
   * returns the directory holding the reviewed manifest. For a workspace, the
   * lockfile stays at the temporary root and the manifest goes to its
   * importer path, beside the other workspace manifests.
   */
  private async stageProject(tempRoot: string, manifestText: string): Promise<string> {
    const workspace = this.options.workspace;
    let projectDir = tempRoot;
    if (workspace !== undefined) {
      for (const file of workspace.files) {
        const target = isolatedRelativePath(tempRoot, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.text, 'utf8');
      }
      if (workspace.importerId !== '.') {
        projectDir = isolatedRelativePath(tempRoot, workspace.importerId);
        await mkdir(projectDir, { recursive: true });
      }
    }
    await writeFile(path.join(projectDir, 'package.json'), manifestText, 'utf8');
    if (this.options.lockfile !== undefined) {
      await writeFile(path.join(tempRoot, this.options.lockfile.name), this.options.lockfile.text, 'utf8');
    }
    return projectDir;
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
    const unavailableReason = this.options.workspace?.unavailableReason;
    if (unavailableReason !== undefined) {
      return {
        status: 'unknown',
        packageManager: this.options.packageManager,
        packageManagerVersion: this.options.packageManagerVersion,
        code: 'RESOLVER_FAILED',
        explanation: `Isolated resolver verification was skipped: ${unavailableReason}`,
      };
    }
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
      const projectDir = await this.stageProject(tempRoot, stagedManifest);
      // A workspace resolves every member, so it keeps the lockfile and skips a full fresh install.
      const writesLockfile = this.options.retainResolvedGraph === true || this.options.workspace !== undefined;
      const result = await this.runner.run(
        this.options.invocation,
        (writesLockfile ? buildLockfileMaterializationArgs : buildResolverArgs)(
          this.options.packageManager,
          this.options.registry,
          this.options.policy,
          this.options.resolvedRegistry?.scoped
        ),
        tempRoot,
        signal
      );
      if (result.exitCode === 0 && this.options.workspace !== undefined &&
          !await this.resolvedWorkspaceImporter(tempRoot)) {
        return {
          status: 'unknown',
          packageManager: this.options.packageManager,
          packageManagerVersion: this.options.packageManagerVersion,
          code: 'RESOLVER_FAILED',
          explanation: 'Isolated resolver verification finished without resolving this workspace project.',
        };
      }
      if (this.options.retainResolvedGraph && result.exitCode === 0) {
        try {
          const lockfileName = this.options.packageManager === 'pnpm' ? 'pnpm-lock.yaml'
            : this.options.lockfile?.name ?? 'package-lock.json';
          const lockfileText = await readFile(path.join(tempRoot, lockfileName), 'utf8');
          this.reviewGraphs.set(this.proposalKey(proposal), buildDependencyGraph({
            root: projectDir, manifest: parseManifest(stagedManifest), lockfileText,
            packageManager: this.options.packageManager,
            ...this.importerOption(),
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
    if (this.options.workspace?.unavailableReason !== undefined) return { ok: false };
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
      const projectDir = await this.stageProject(tempRoot, stagedManifest);
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
      if (this.options.workspace !== undefined && !await this.resolvedWorkspaceImporter(tempRoot)) return { ok: false };

      const lockfileText = await readFile(path.join(tempRoot, lockfileName), 'utf8');
      const manifest = parseManifest(stagedManifest);
      const graph = buildDependencyGraph({
        root: projectDir,
        manifest,
        lockfileText,
        packageManager: this.options.packageManager,
        ...this.importerOption(),
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
