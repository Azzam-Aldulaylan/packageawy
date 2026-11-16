import { isExpectedFsError, isFsError } from './expectedFsError.js';
import { UnsupportedLockfileError } from '../core/lockfile/parse.js';
import { UnsupportedPnpmLockfileError } from '../core/lockfile/pnpm.js';
import { YAMLException } from 'js-yaml';
/**
 * Drives the pipeline for one open panel.
 *
 * Deliberately knows nothing about `vscode.WebviewPanel`: it posts through a
 * `MessageSink`, so the whole open/refresh/cancel lifecycle is testable against
 * a fake sink and a fake HttpClient, with no extension host.
 *
 * Caching is now split in two: an in-memory `lastResult` (this instance's own
 * session, exactly as before) backed by a persisted `PersistedProjectCache`
 * entry keyed by `options.cacheKey`: the project identity plus
 * registry, computed by the panel via `deriveProjectCacheKey`. A cold
 * controller (no in-memory `lastResult` yet: panel just opened, or the user
 * just switched to a project not yet scanned this session) hydrates from that
 * persisted entry before deciding what to show, so a fresh persisted result
 * can render immediately without a network round trip, and a stale one still
 * renders instantly while a revalidation runs underneath it.
 */

import type { AuditRunner } from '../core/audit/npmAudit.js';
import { classifyFreshness } from '../core/cache/freshness.js';
import type { PersistentProjectCacheStore } from '../core/cache/projectCacheStore.js';
import type { ScanSnapshot } from '../core/cache/schema.js';
import type { ProjectSourceFingerprint } from '../core/cache/sourceFingerprint.js';
import { computeSourceFingerprint, isSourceFingerprint, sourceFingerprintsMatch } from '../core/cache/sourceFingerprint.js';
import type { DeclaredDependency, OtherPackageManager } from '../core/manifest/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import type { BuildPackageRowsOptions } from '../core/pipeline.js';
import { buildPackageRows } from '../core/pipeline.js';
import type { HttpClient } from '../core/registry/http.js';
import { FetchError } from '../core/registry/http.js';
import type { EtagStore } from '../core/registry/versions.js';
import type { PeerResolutionPolicy } from '../core/registry/npmrc.js';
import type { AdvisoryLookupRequest } from '../core/advisories/resolve.js';
import { resolveTrustedAdvisoryUrl } from '../core/advisories/resolve.js';
import type {
  BulkRemoveEligibility,
  BulkUpgradeEligibility,
  RemoveRequestInput,
  UpgradeEligibility,
  UpgradeRequestInput,
} from '../core/upgrade/validate.js';
import type { PackageManagerKind, PackageRow, ResolvedRegistry } from '../core/types.js';
import { validateBulkRemoveRequest, validateBulkUpgradeRequest, validateUpgradeRequest } from '../core/upgrade/validate.js';
import type { BuildInfo } from './dashboardData.js';
import { toHostToWebviewMessage } from './dashboardData.js';
import { readOnlyReasonFor } from './packageManagerSupport.js';
import { targetFingerprintField } from './mutationTarget.js';
import type { MutationTargetResolution } from './mutationTarget.js';
import type { HostToWebviewMessage, ProtocolError, SelectedProjectInfo } from './webviewProtocol.js';
import { diagnosticLine, runtimeFailureLine } from '../core/diagnostics.js';
import { fireAndForget } from '../core/fireAndForget.js';
import { UpdateAdvisories, offeredVersionPairs } from './updateAdvisories.js';
import type { UpdateVersionPair } from './updateAdvisories.js';
import type { UpdateAdvisoryContext } from './webviewProtocol.js';
import { updatesSettled } from './registrySignIn.js';

export interface MessageSink {
  postMessage(message: HostToWebviewMessage): void;
}

export type BackgroundRefreshReason = 'structural' | 'time' | 'local-mutation';

export interface ProjectSnapshotUpdateResult {
  /** True only when no watcher/reload generation advanced during the disk read that produced this snapshot. */
  structurallyCurrent: boolean;
}

export type BackgroundRefreshOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; error: ProtocolError }
  | { status: 'cancelled' }
  | { status: 'superseded' };

export interface DashboardControllerOptions {
  /** Panel reload generation: a newer disk read supersedes scans before they publish or persist. */
  scanGeneration?: () => number;
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  lockfileText: string | null;
  /** Absolute path to the resolved lockfile, or null if none: persisted alongside each cache entry so a file-watcher event can purge every entry sharing an npm-workspace root lockfile. */
  lockfilePath: string | null;
  packageManager?: PackageManagerKind;
  importerId?: string;
  lockfileName?: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
  /** Yarn, Bun, or an unrecognized package manager owns this project: every dependency change is refused. */
  otherPackageManager?: OtherPackageManager | null;
  /** Where a dependency change writes, or why changes are refused. Null or absent refuses every change. */
  mutationTarget?: MutationTargetResolution | null;
  /** Already resolved by the caller via resolveRegistry. */
  registry: string;
  /** Full registry routing, including scoped overrides, for on-demand package metadata. */
  resolvedRegistry?: ResolvedRegistry;
  /** Host-parsed peer policy used by isolated package-manager checks. */
  peerPolicy?: PeerResolutionPolicy;
  httpClient: HttpClient;
  etagStore: EtagStore;
  /** Omit to skip the optional `npm audit` enrichment. */
  auditRunner?: AuditRunner;
  /** display info for the currently selected project, sent out with every DashboardData. */
  projectInfo: SelectedProjectInfo;
  /** Whether more than one project candidate was discovered. */
  canChangeProject: boolean;
  /** Panel-wide, not project-specific: the running extension's version/build stamp, sent out with every DashboardData so the footer can show it. */
  buildInfo: BuildInfo;
  /** panel-level, shared across every controller instance the panel builds. */
  projectCacheStore: PersistentProjectCacheStore;
  /** this project's persisted-cache key: derived from project identity + registry. */
  cacheKey: string;
  /** reads `packageawy.cacheTtlMinutes` at the host boundary. Called fresh on every freshness check, so a config change takes effect on the next check, not just the next controller. */
  ttlMinutesProvider: () => number;
  /** injected clock for deterministic freshness tests. Defaults to the real clock. */
  now?: () => number;
  /** Local diagnostic switch. Read for each operation so settings changes apply without reopening VS Code. */
  performanceEnabled?: () => boolean;
  /** Host panels enable real scan progress. Tests/other adapters may omit it. */
  progressEnabled?: boolean;
  /**
   * Reads `packageawy.security.publicAdvisoryCheck` for the project at
   * `root`. Called for each scan and cache read so a settings change applies
   * on the next one. Omitted means on.
   */
  publicAdvisoryCheckEnabled?: (root: string) => boolean;
  /** Troubleshooting log (HostPlatform.log). Receives formatted, safe lines only. */
  log?: (line: string) => void;
}

/** Settings key, relative to the `packageawy` section. Resource scoped, so it can differ per workspace folder. */
export const PUBLIC_ADVISORY_CHECK_SETTING = 'security.publicAdvisoryCheck';

function isCancellation(cause: unknown): boolean {
  return cause instanceof FetchError && cause.code === 'CANCELLED';
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof FetchError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

/**
 * Flattens a completed pipeline result down to the plain-object shape that's
 * both rendered and persisted, never the live `BuildPackageRowsResult`
 * itself, whose `advisoriesError` is a `FetchError` instance carrying a stack
 * trace and other fields that have no business on disk.
 */
function toScanSnapshot(result: {
  rows: ScanSnapshot['rows'];
  availability: ScanSnapshot['availability'];
  advisoriesError?: ProtocolError;
  auditUnavailable?: boolean;
  auditUnavailableReason?: ScanSnapshot['auditUnavailableReason'];
  packageManager?: ScanSnapshot['packageManager'];
  lockfileMissing?: boolean;
  hygieneFindings?: ScanSnapshot['hygieneFindings'];
}): ScanSnapshot {
  const snapshot: ScanSnapshot = { rows: result.rows, availability: result.availability };
  if (result.advisoriesError !== undefined) {
    snapshot.advisoriesError = { code: result.advisoriesError.code, message: result.advisoriesError.message };
  }
  if (result.auditUnavailable === true) {
    snapshot.auditUnavailable = true;
    if (result.auditUnavailableReason !== undefined) snapshot.auditUnavailableReason = result.auditUnavailableReason;
  }
  if (result.packageManager !== undefined) snapshot.packageManager = result.packageManager;
  if (result.lockfileMissing === true) snapshot.lockfileMissing = true;
  if (result.hygieneFindings !== undefined) snapshot.hygieneFindings = result.hygieneFindings;
  return snapshot;
}

/** A project that turned the advisory check off still has complete data for what it asked for. */
function hasCompleteCoreData(snapshot: ScanSnapshot): boolean {
  const advisories = snapshot.availability.advisories;
  return updatesSettled(snapshot.availability) && (advisories === 'complete' || advisories === 'off');
}

/** The project-specific slice of options that a reload replaces: everything but the fetch machinery. */
export type ProjectSnapshot = Pick<
  DashboardControllerOptions,
  | 'root'
  | 'manifestText'
  | 'lockfileText'
  | 'lockfilePath'
  | 'packageManager'
  | 'importerId'
  | 'lockfileName'
  | 'otherPackageManager'
  | 'mutationTarget'
  | 'registry'
  | 'resolvedRegistry'
  | 'peerPolicy'
  | 'projectInfo'
  | 'canChangeProject'
  | 'cacheKey'
>;

/** Only the speculative first ready may join this task. Other runs still restart. */
interface StartupTask {
  promise: Promise<BackgroundRefreshOutcome | undefined>;
  running: boolean;
  scanId: number;
  outcome?: BackgroundRefreshOutcome | undefined;
}

interface ScanSource {
  cacheKey: string;
  sourceFingerprint: ProjectSourceFingerprint;
  projectFacts: Pick<ScanSnapshot, 'packageManager' | 'lockfileMissing'>;
}

export class DashboardController {
  private options: DashboardControllerOptions;
  private lastResult: ScanSnapshot | undefined;
  /** Fingerprint captured from the exact controller inputs that produced `lastResult`. */
  private lastResultSourceFingerprint: ProjectSourceFingerprint | undefined;
  /** Disk inputs that produced the retained rows, including in-memory ready replays. */
  private lastResultDiskReadGeneration: number | undefined;
  private lastGeneratedAt: string | undefined;
  private inFlight: AbortController | undefined;
  private startupTask: StartupTask | undefined;
  private disposed = false;
  private readonly updateAdvisories: UpdateAdvisories;
  private updateContext: UpdateAdvisoryContext | undefined;
  private scanId = 0;
  private settingsGeneration = 0;
  /**
   * Derived from `options.manifestText`: recomputed by `updateProjectSnapshot`
   * whenever the snapshot changes, so it always reflects the manifest the most
   * recent (or in-flight) scan actually read. This is the host-owned source of
   * dependencies/devDependencies/optionalDependencies classification for the
   * Upgrade action's npm save flag. The webview never supplies or sees it.
   *
   * Wrapped in try/catch rather than left to throw: an invalid manifestText
   * already surfaces as a fatal-error from run() (see the existing "an
   * unreadable manifest is a fatal error" test): that failure path must not
   * change to throwing out of the constructor instead, before a sink even
   * exists to report it to.
   */
  private declaredDependencies: DeclaredDependency[];
  /**
   * Monotonically increasing: the revalidation generation. Bumped by
   * `invalidateScan()` whenever derived authority must be revoked:
   * a watcher event (called by the panel
   * before its debounce, not after), a manual or structural reload, and a
   * project snapshot replacement. Timer/cache-age refreshes deliberately do
   * not advance this generation because age is not evidence of source
   * mutation. This is the Upgrade-eligibility security boundary's other
   * half. See `isEligible`.
   */
  private revalidationGeneration = 0;
  /** Only a new disk read or file invalidation for the same root supersedes a disk read. */
  private readonly diskReadGenerations = new Map<string, number>();
  /** Never reuse a token after a disappeared root is rediscovered. */
  private nextDiskReadGeneration = 0;

  private get diskReadGeneration(): number {
    return this.diskReadGenerations.get(this.options.root) ?? 0;
  }
  /** Generation at the last disk confirmation or completed eligible scan. */
  private optionsGeneration = 0;
  /**
   * Disk-read token supplying the options. Scans do not advance it, so a
   * scan can revoke derived authority without invalidating confirmed inputs.
   */
  private scanInputsGeneration = 0;
  /** Panel generation of the disk read supplying the current options. */
  private optionsDiskGeneration: number | undefined;
  /** The `revalidationGeneration` `lastResult` was last validated against, or `undefined` if it never was: `undefined` is the explicit "revalidation in progress / not yet validated" state `validateUpgradeRequest` checks. */
  private eligibleGeneration: number | undefined;

  constructor(options: DashboardControllerOptions) {
    this.options = options;
    this.optionsDiskGeneration = options.scanGeneration?.();
    this.updateAdvisories = new UpdateAdvisories(options.httpClient, () => this.publicAdvisoryCheckEnabled(),
      () => this.options.log?.(diagnosticLine({ area: 'version-advisories', code: 'UNKNOWN' })));
    this.declaredDependencies = DashboardController.parseDeclaredDependencies(options.manifestText);
  }

  private static parseDeclaredDependencies(manifestText: string): DeclaredDependency[] {
    try {
      return parseManifest(manifestText).dependencies;
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      return [];
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private performanceEnabled(): boolean {
    return this.options.performanceEnabled?.() ?? false;
  }

  /** Absolute path to the directory holding package.json: the Upgrade task's cwd. */
  get root(): string {
    return this.options.root;
  }

  /** Why dependency changes are off for this project, or undefined when npm or pnpm owns it. */
  private readOnlyReason(): string | undefined {
    return readOnlyReasonFor(this.options);
  }

  /** Host-only source state used to build preflight and transaction inputs. */
  get upgradeSource(): {
    manifestText: string;
    lockfileText: string | null;
    lockfilePath: string | null;
    registry: string;
    resolvedRegistry: ResolvedRegistry;
    peerPolicy: PeerResolutionPolicy;
    packageManager: PackageManagerKind;
    importerId: string;
    lockfileName: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
    otherPackageManager: OtherPackageManager | null;
    mutationTarget: MutationTargetResolution | null;
  } {
    return {
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      lockfilePath: this.options.lockfilePath,
      registry: this.options.registry,
      resolvedRegistry: this.options.resolvedRegistry ?? {
        url: this.options.registry,
        source: 'default',
        scoped: {},
      },
      peerPolicy: this.options.peerPolicy ?? {
        strictPeerDeps: false,
        legacyPeerDeps: false,
        sources: { strictPeerDeps: 'default', legacyPeerDeps: 'default' },
      },
      packageManager: this.options.packageManager ?? 'npm',
      importerId: this.options.importerId ?? '.',
      lockfileName: this.options.lockfileName ?? null,
      otherPackageManager: this.options.otherPackageManager ?? null,
      mutationTarget: this.options.mutationTarget ?? null,
    };
  }

  /**
   * Replaces the controller's project snapshot in place: root, manifestText,
   * lockfileText, registry, cacheKey, and re-derives `declaredDependencies`
   * from the new manifestText. Called by DashboardPanel after re-resolving the
   * project (a fresh `resolveProject()` read from disk), so that a subsequent
   * `handleRefresh` scans against what package.json/the lockfile actually
   * contain now, including a package.json/lockfile an upgrade task itself
   * just rewrote, rather than whatever was read when the panel first opened.
   * The fetch machinery (httpClient/etagStore/auditRunner/projectCacheStore) is
   * untouched, so ETag caching and persisted cache lookups keep working across
   * reloads.
   *
   * @param generationAtReadStart: the caller's `beginRevalidation(snapshot.root)` token,
   * captured before reading disk. Scans only invalidate derived rows, so they
   * cannot supersede this read. A newer read or watcher event can supersede it,
   * in which case it must not replace newer inputs or restore their authority.
   */
  updateProjectSnapshot(snapshot: ProjectSnapshot, generationAtReadStart: number): ProjectSnapshotUpdateResult {
    if (generationAtReadStart !== this.diskReadGenerations.get(snapshot.root)) return { structurallyCurrent: false };
    this.options = { ...this.options, ...snapshot };
    this.declaredDependencies = DashboardController.parseDeclaredDependencies(snapshot.manifestText);
    this.invalidateScan();
    this.optionsGeneration = this.revalidationGeneration;
    this.scanInputsGeneration = this.diskReadGeneration;
    this.optionsDiskGeneration = this.options.scanGeneration?.();
    return { structurallyCurrent: true };
  }

  /**
   * The single explicit entry point for "eligibility must not be trusted
   * from this point forward until a matching revalidation proves
   * otherwise." Revokes Upgrade eligibility immediately: `lastResult` (and
   * whatever the webview currently sees) is left completely untouched, only
   * `isEligible()`'s answer changes, and is always safe to call more than
   * once in a row: each call simply advances the internal generation
   * counter again, so nothing breaks if, say, a watcher event and the
   * reload it schedules both call this for what is conceptually the same
   * change.
   *
   * Called by the panel before raw watcher debounce and before every disk
   * read, including drained watcher reloads and post-mutation reads. Scans
   * and snapshot application use `invalidateScan` instead, because neither
   * is evidence of a newer disk read or changed project files.
   *
   * Returns the disk-read token. Only a newer read or project-file
   * invalidation for the same root advances it. Pass the target root when
   * switching projects. Watchers default to the currently selected root.
   * Starting a scan never invalidates a disk read.
   */
  beginRevalidation(root = this.options.root): number {
    // Old watchers still belong to the selected root while a switch reads
    // another project. They must not supersede that other project's read.
    const generation = ++this.nextDiskReadGeneration;
    this.diskReadGenerations.set(root, generation);
    this.invalidateScan();
    return generation;
  }

  /** Discovery bounds retained roots and revokes reads of disappeared projects. */
  reconcileProjectRoots(roots: ReadonlySet<string>): void {
    for (const root of this.diskReadGenerations.keys()) {
      if (!roots.has(root)) this.diskReadGenerations.delete(root);
    }
    // Even an initial snapshot with token zero must stay revoked after removal.
    // The absent map entry also reads as zero, so invalidate its inputs explicitly.
    if (!roots.has(this.options.root)) {
      this.scanInputsGeneration = -1;
      this.invalidateScan();
    }
  }

  /** Revoke derived authority without superseding an in-flight disk read. */
  private invalidateScan(): number {
    this.updateAdvisories.clear();
    this.updateContext = undefined;
    this.revalidationGeneration += 1;
    return this.revalidationGeneration;
  }

  /**
   * Posts the current `lastResult` (if any) as `stale`, announcing that a
   * revalidation is now in progress. Call immediately after
   * `beginRevalidation()`, from the earliest point a revalidation is known
   * to be starting: a watcher event, before its debounce. The start of
   * a manual/post-upgrade reload, before its disk read, not only once
   * `run()` itself actually begins scanning. A structural `run()` also calls
   * this itself. Calling it more than once for the
   * same revalidation is a harmless, idempotent duplicate: always the same
   * data, since nothing updates `lastResult` until a scan actually
   * completes.
   *
   * This is what makes structural background revalidation (file-change-
   * triggered, which otherwise posts nothing until it completes) visible in
   * the webview at all, so it can disable Upgrade buttons for the entire
   * duration, including the debounce window and the disk read, not just
   * the network round trip. A no-op when there is nothing to announce
   * (nothing has ever rendered yet: a cold start's `loading` message
   * already covers that).
   */
  announceRevalidating(sink: MessageSink): void {
    if (this.lastResult === undefined) return;
    this.postSnapshot(sink,
      toHostToWebviewMessage(
        this.lastResult,
        { isEmpty: this.lastResult.rows.length === 0, isStale: true },
        this.options.projectInfo,
        this.options.canChangeProject,
        this.options.buildInfo,
        this.lastGeneratedAt,
        this.readOnlyReason()
      )
    );
  }

  /**
   * True only for data validated against the exact source state currently in
   * `this.options`: no watcher event, project reload, or reload attempt has
   * begun since `lastResult` was last confirmed to match it.
   * `eligibleGeneration` is only ever set in two places. `handleReady` may
   * set it for a complete fingerprint-matching persisted snapshot regardless
   * of age, because TTL controls background enrichment rather than structural
   * authority. And
   * `run()`'s success path only sets it when nothing called
   * `beginRevalidation()` again while the scan that just produced this exact
   * data was in flight, and both sites additionally require
   * `optionsGeneration === revalidationGeneration` (see that field's own
   * doc) before granting anything at all, so a bump that landed before
   * `this.options` ever caught up to it (a watcher event that fired before
   * the first hydration, or before a background-timer tick that races an
   * already-pending file-change reload) can never be mistaken for "nothing
   * changed."
   *
   * Deliberately does not re-check `classifyFreshness` live on every call:
   * that would make eligibility re-derive "is this old enough to distrust"
   * continuously from the same clock the display staleness banner uses,
   * including `cacheTtlMinutes: 0` ("always revalidate" for display
   * purposes), which would then make Upgrade permanently ineligible even
   * one millisecond after a scan that just completed cleanly. The TTL
   * decides whether to *trust a replay without revalidating*; it is not a
   * ticking expiry on structurally-valid data.
   */
  private isEligible(): boolean {
    return this.eligibleGeneration !== undefined && this.eligibleGeneration === this.revalidationGeneration;
  }

  /**
   * The actual security boundary for the Upgrade action: `request` is
   * whatever the webview sent, trusted only as far as it matches `lastResult`
   * and `declaredDependencies`: both derived from the host's last scan,
   * never from the webview, and only when `isEligible()` confirms that scan
   * still describes the current source state. A source-fingerprint mismatch,
   * data mid-revalidation after a file change or project reload, or a
   * structural revalidation that failed are all rejected
   * here regardless of what `lastResult` itself contains: this is the
   * actual gate. The webview disabling its Upgrade buttons in the same
   * situations is only a convenience, not the boundary.
   *
   * `lastResult === undefined` is checked separately, before `isEligible()`,
   * so a controller that has genuinely never completed a single scan keeps
   * reporting the more specific, more actionable `no-scan-result` ("run a
   * scan") rather than the generic `revalidating` ("try again shortly"),
   * `isEligible()` alone can't tell those two apart, since a cold
   * controller's `eligibleGeneration` is `undefined` in both cases.
   */
  /** True while a scan is running. Its completion posts a new snapshot. */
  scanRunning(): boolean {
    return this.inFlight !== undefined && !this.inFlight.signal.aborted;
  }

  /**
   * True when upgrades are blocked and the last finished scan could not check
   * every package (for example registry timeouts). Only a complete scan grants
   * eligibility. Callers check scanRunning() first: a newer scan may be on its
   * way, and a file change since then can also be pending.
   */
  lastScanIncomplete(): boolean {
    return this.lastResult !== undefined && !this.isEligible() && !hasCompleteCoreData(this.lastResult);
  }

  validateUpgradeRequest(request: UpgradeRequestInput): UpgradeEligibility {
    if (this.lastResult === undefined) return { ok: false, reason: 'no-scan-result' };
    if (!this.isEligible()) return { ok: false, reason: 'revalidating' };
    return validateUpgradeRequest(this.lastResult.rows, this.declaredDependencies, request);
  }

  /** Same freshness gate as a single upgrade, applied atomically to every requested change. */
  validateBulkUpgradeRequest(
    requests: readonly UpgradeRequestInput[],
    publishedTargetsByPackage: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  ): BulkUpgradeEligibility {
    if (this.lastResult === undefined) {
      return { ok: false, reason: 'change-rejected', changeReason: 'no-scan-result' };
    }
    if (!this.isEligible()) {
      return { ok: false, reason: 'change-rejected', changeReason: 'revalidating' };
    }
    return validateBulkUpgradeRequest(
      this.lastResult.rows,
      this.declaredDependencies,
      requests,
      publishedTargetsByPackage
    );
  }

  /** Same freshness gate as a bulk upgrade, applied atomically to every requested removal. */
  validateBulkRemoveRequest(requests: readonly RemoveRequestInput[]): BulkRemoveEligibility {
    if (this.lastResult === undefined) {
      return { ok: false, reason: 'change-rejected', changeReason: 'no-scan-result' };
    }
    if (!this.isEligible()) {
      return { ok: false, reason: 'change-rejected', changeReason: 'revalidating' };
    }
    return validateBulkRemoveRequest(this.lastResult.rows, this.declaredDependencies, requests);
  }

  /**
   * The security boundary for "open advisory source" (Problem 4): the
   * webview names an advisory and optional displayed reference, never a URL,
   * this resolves that name against `lastResult`, the host's last
   * completed scan, and returns a verified reference destination or the URL
   * that scan itself recorded. It returns `null` for any mismatch or unsafe
   * URL. Staleness
   * (`isEligible()`) is deliberately not checked here: unlike an Upgrade
   * request, opening a browser tab to an advisory mutates nothing, so a
   * revalidation in flight is not a reason to refuse it.
   */
  resolveAdvisoryUrl(request: AdvisoryLookupRequest): string | null {
    if (this.lastResult === undefined) return null;
    return resolveTrustedAdvisoryUrl(this.lastResult.rows, request);
  }

  /**
   * The host's last completed scan rows: the "before" side of
   * security-outcome evaluation (see evaluateSecurityOutcome in
   * src/core/advisories/securityOutcome.ts) and the source
   * `advisoriesByNameFromRows` (attribution.ts) reconstructs an advisory
   * lookup map from, to re-attribute against a proposed post-upgrade graph
   * without a second bulk-advisory fetch. Deliberately not gated by
   * `isEligible()`: the upgrade-eligibility re-checks that already surround
   * every call site cover staleness, and this alone mutates nothing.
   */
  lastResultRows(): readonly PackageRow[] {
    return this.lastResult?.rows ?? [];
  }

  /** Host-only immutable facts for a correlated post-mutation report. */
  lastResultSnapshot(): ScanSnapshot | null {
    return this.lastResult === undefined ? null : toScanSnapshot(this.lastResult);
  }

  /** Host-only snapshot bound to the exact source inputs which produced it. */
  lastResultEvidence(): { snapshot: ScanSnapshot; sourceFingerprint: ProjectSourceFingerprint } | null {
    return this.lastResult === undefined || this.lastResultSourceFingerprint === undefined
      ? null
      : {
          snapshot: toScanSnapshot(this.lastResult),
          sourceFingerprint: this.lastResultSourceFingerprint,
        };
  }

  /** Fingerprint of the exact manifest/lockfile inputs currently owned by this controller. */
  sourceFingerprint(): ProjectSourceFingerprint {
    return this.currentSourceFingerprint();
  }

  /**
   * a watched file affecting this project's manifest or lockfile changed
   * (or a successful upgrade just rewrote them). Drops the persisted entry so
   * nothing later replays data that's now known to be wrong. Deliberately
   * leaves the in-memory `lastResult` alone so the panel can keep the last
   * good render on screen until the caller's follow-up rescan (`run` via
   * `handleRefresh`/`refreshInBackground`) actually replaces it.
   */
  invalidateCache(): void {
    this.options.projectCacheStore.delete(this.options.cacheKey);
  }

  /**
   * Lockfile evidence from project resolution, never from npm's output. A
   * resolved mutation target answers from whether the lockfile it names
   * exists. Otherwise a caller that gives no lockfileName falls back to
   * whether lockfile text was read.
   */
  private lockfileMissing(): boolean {
    const target = this.options.mutationTarget;
    if (target?.ok === true) return !target.target.lockfileExists;
    const name = this.options.lockfileName;
    return name === null || (name === undefined && this.options.lockfileText === null);
  }

  /** The project facts the partial results banner words itself from. */
  private projectFacts(): Pick<ScanSnapshot, 'packageManager' | 'lockfileMissing'> {
    return {
      packageManager: this.options.packageManager ?? 'npm',
      ...(this.lockfileMissing() ? { lockfileMissing: true } : {}),
    };
  }

  private currentSourceFingerprint(): ProjectSourceFingerprint {
    return computeSourceFingerprint({
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      packageManager: this.options.packageManager ?? 'npm',
      importerId: this.options.importerId ?? '.',
      lockfilePath: this.options.lockfilePath,
      ...targetFingerprintField(this.options.mutationTarget),
    });
  }

  /**
   * Hydrates `lastResult` from the persisted entry for this cacheKey, but
   * only if it still matches what's actually on disk right now. A cacheKey
   * alone doesn't prove that: the project's manifest/lockfile could have
   * been edited while the panel was closed (no watcher running to invalidate
   * it then), and `updateProjectSnapshot` always runs before this is called
   * on an existing controller, so `this.options` already reflects a fresh
   * disk read. A mismatch means the entry describes a state that no longer
   * exists: it is deleted outright (not merely skipped) so it doesn't keep
   * failing this same comparison forever, and a real scan follows exactly as
   * if nothing had ever been cached.
   */
  private hydrateFromPersistedCache(performance: PerformanceRecorder): void {
    const endRead = performance.start('cache read');
    const cached = this.options.projectCacheStore.get(this.options.cacheKey);
    endRead({ hit: cached !== undefined });
    if (cached === undefined) return;

    const endValidation = performance.start('cache validation');
    // `isSourceFingerprint` here is defense in depth, not the primary
    // control: a real persisted entry already passed schema validation
    // (schema.ts) before ever reaching the store, so `cached.sourceFingerprint`
    // should always be well-formed. Guarding it anyway keeps this method
    // consistent with the rest of the cache layer's rule: never trust the
    // shape of anything read back from storage, never crash on it either.
    // An entry scanned under the other advisory setting would show advisory
    // facts the project turned off, or hide ones it turned back on.
    if (
      !isSourceFingerprint(cached.sourceFingerprint) ||
      !sourceFingerprintsMatch(cached.sourceFingerprint, this.currentSourceFingerprint()) ||
      (cached.availability.advisories === 'off') !== !this.publicAdvisoryCheckEnabled()
    ) {
      endValidation({ valid: false });
      this.options.projectCacheStore.delete(this.options.cacheKey);
      return;
    }
    endValidation({ valid: true });

    // PersistedProjectCache is a structural superset of ScanSnapshot (adds
    // generatedAt/lockfilePath/sourceFingerprint): assigning it here just
    // carries those extra fields along invisibly. Nothing that reads
    // `lastResult` as a ScanSnapshot ever looks at them.
    // Row identities belong to the scanned lockfile, whose alias targets can
    // differ from the manifest. Preserve them exactly on replay.
    // The fingerprint matched, so the project facts are the same ones the
    // snapshot was scanned with. Filling them from the current options lets an
    // entry written before they were persisted replay the same banner.
    this.lastResult = { ...cached, ...this.projectFacts() };
    this.lastResultSourceFingerprint = cached.sourceFingerprint;
    this.lastResultDiskReadGeneration = this.scanInputsGeneration;
    this.lastGeneratedAt = cached.generatedAt;
  }

  private persistSnapshot(snapshot: ScanSnapshot, generatedAt: string, source: ScanSource, performance: PerformanceRecorder): void {
    const currentFacts = this.projectFacts();
    // Skip changed sources so an older scan cannot replace a valid cache entry
    // or make its rows authoritative for files it never scanned.
    if (
      source.cacheKey !== this.options.cacheKey ||
      !sourceFingerprintsMatch(source.sourceFingerprint, this.currentSourceFingerprint()) ||
      source.projectFacts.packageManager !== currentFacts.packageManager ||
      source.projectFacts.lockfileMissing !== currentFacts.lockfileMissing
    ) return;

    const endWrite = performance.start('cache write');
    this.options.projectCacheStore.set(source.cacheKey, {
      ...snapshot,
      generatedAt,
      lockfilePath: source.sourceFingerprint.lockfilePath,
      sourceFingerprint: source.sourceFingerprint,
    });
    endWrite({ rows: snapshot.rows.length });
  }

  startStartup(sink: MessageSink): void {
    const task: StartupTask = { promise: Promise.resolve(undefined), running: true, scanId: this.scanId };
    this.startupTask = task;
    const startupSink: MessageSink = {
      postMessage: message => {
        if (this.disposed) return;
        // Record fatal state at the point it is produced. Ready can arrive
        // before the task promise's completion continuation has run.
        if (message.status === 'fatal-error') task.outcome = { status: 'failed', error: message.error };
        sink.postMessage(message);
      },
    };
    task.promise = this.presentReady(startupSink).then(outcome => {
      task.outcome = outcome;
      task.running = false;
      return outcome;
    });
    // presentReady starts its run synchronously, before the first await.
    task.scanId = this.scanId;
  }

  async handleStartupReady(sink: MessageSink): Promise<void> {
    const task = this.startupTask;
    this.startupTask = undefined;
    // A watcher or another refresh may have replaced startup's run. Only
    // the specifically identified startup task gets the join exception.
    await this.presentReady(sink, task?.scanId === this.scanId ? task : undefined);
  }

  /**
   * The webview mounted and asked for state.
   *
   * If nothing is in memory yet, first hydrate from the persisted cache: a
   * cold controller (new panel, or just switched to this project) may still
   * have a usable snapshot from a previous session. Then classify freshness
   * against the configured TTL: a fresh snapshot renders as `ready` and skips
   * the network entirely. A complete but age-expired snapshot also stays
   * ready/eligible while a time-only revalidation runs. Incomplete core data
   * remains structurally gated until a complete run succeeds.
   */
  async handleReady(sink: MessageSink): Promise<BackgroundRefreshOutcome | undefined> {
    return this.presentReady(sink);
  }

  private async presentReady(sink: MessageSink, startup?: StartupTask): Promise<BackgroundRefreshOutcome | undefined> {
    if (this.disposed) return { status: 'cancelled' };
    const cachePerformance = createPerformanceSession('Packageawy cache', this.performanceEnabled());
    if (this.lastResult === undefined) {
      this.hydrateFromPersistedCache(cachePerformance);
    }
    const cached = this.lastResult;
    if (cached === undefined) {
      cachePerformance.finish({ hit: false });
      if (startup?.outcome?.status === 'failed') {
        sink.postMessage({ status: 'fatal-error', error: startup.outcome.error });
        return startup.outcome;
      }
      sink.postMessage({ status: 'loading' });
      return startup?.running ? startup.promise : this.run(sink);
    }

    const endFreshness = cachePerformance.start('cache freshness');
    const freshness = classifyFreshness(this.lastGeneratedAt, this.options.ttlMinutesProvider(), this.now());
    endFreshness({ freshness });
    cachePerformance.finish({ hit: true, freshness });
    const rowsMatchDiskRead = this.lastResultDiskReadGeneration === this.diskReadGeneration;
    if (hasCompleteCoreData(cached)) {
      // Complete, fingerprint-matching data (hydrateFromPersistedCache already
      // deleted and refused to hydrate anything that didn't match) may
      // authorize an Upgrade: restore eligibility for it explicitly, since
      // a cold controller's `eligibleGeneration` starts undefined and
      // hydration alone (unlike a completed `run()`) never sets it. Gated on
      // `optionsGeneration === revalidationGeneration`: the fingerprint
      // match above only proves the persisted entry matches `this.options`
      // as they stand: if a watcher event already called
      // `beginRevalidation()` before `this.options` ever caught up to it
      // (construction happened, then a file changed, then the webview's
      // first `ready` arrived: all before the debounced reload ran), that
      // match is against content already known to be stale, and must not
      // grant eligibility.
      if (rowsMatchDiskRead && this.optionsGeneration === this.revalidationGeneration) {
        this.eligibleGeneration = this.revalidationGeneration;
      }
      if (rowsMatchDiskRead && this.updateContext === undefined && this.optionsGeneration === this.revalidationGeneration) {
        this.updateContext = this.makeUpdateContext();
      }
      this.postSnapshot(sink,
        toHostToWebviewMessage(
          cached,
          { isEmpty: cached.rows.length === 0, isStale: !rowsMatchDiskRead || this.optionsGeneration !== this.revalidationGeneration ||
            this.optionsDiskGeneration !== this.options.scanGeneration?.() },
          this.options.projectInfo,
          this.options.canChangeProject,
          this.options.buildInfo,
          this.lastGeneratedAt,
          this.readOnlyReason()
        )
      );
      this.enrichOfferedVersions(sink);
      if (startup?.running) return startup.promise;
      if ((!rowsMatchDiskRead && this.scanInputsGeneration === this.diskReadGeneration) || freshness !== 'fresh') {
        // A confirmed newer read needs new rows even if the retained rows are
        // young. Otherwise only age schedules this background enrichment.
        return this.run(sink, 'time');
      }
      return;
    }

    // Core-incomplete snapshot: `run()` itself
    // announces the stale replay (carrying `cached`) as its first
    // action via `beginRevalidation`'s call site there, then continues with
    // a real scan. Posting it again here would just be a redundant duplicate.
    if (startup?.running) {
      this.announceRevalidating(sink);
      return startup.promise;
    }
    return this.run(sink);
  }

  /**
   * Manual refresh: must genuinely bypass any freshness decision, so the
   * in-memory cache is discarded up front, never consulted, regardless of
   * how fresh it is, and a real scan always runs. The persisted entry is
   * left as-is until `run()` either replaces it with the new result or
   * decides (via its aborted/failure checks) not to.
   */
  async handleRefresh(sink: MessageSink, strict = false): Promise<BackgroundRefreshOutcome> {
    if (this.disposed) return { status: 'cancelled' };
    this.lastResult = undefined;
    this.lastResultSourceFingerprint = undefined;
    this.lastGeneratedAt = undefined;
    sink.postMessage({ status: 'loading' });
    return this.run(sink, 'structural', strict);
  }

  /**
   * background revalidation: file-watcher- or timer-triggered. Callers
   * must explicitly pass `time` for cache-age-only refreshes or
   * `local-mutation` after applying a confirmed post-transaction disk
   * snapshot. The safe default is structural. Unlike
   * `handleRefresh`, it never clears `lastResult` or posts `loading` first,
   * the whole point is that the last good render stays on screen, unchanged,
   * until (and unless) a new result actually arrives. A failure here is
   * silently absorbed by `run()`'s catch block (it only posts
   * `fatal-error` when there is nothing renderable at all).
   */
  async refreshInBackground(
    sink: MessageSink,
    reason: BackgroundRefreshReason = 'structural',
    strict = false
  ): Promise<BackgroundRefreshOutcome> {
    return this.run(sink, reason, strict);
  }

  /**
   * used by the panel's ~30-minute background timer to respect the
   * configured TTL: true only when there is a renderable snapshot that is no
   * longer fresh, so the timer's fixed cadence doesn't force a network round
   * trip while the configured TTL still considers the data good.
   */
  needsBackgroundRefresh(): boolean {
    if (this.lastResult === undefined) return false;
    if (!hasCompleteCoreData(this.lastResult)) return true;
    return classifyFreshness(this.lastGeneratedAt, this.options.ttlMinutesProvider(), this.now()) !== 'fresh';
  }

  publicAdvisoryCheckEnabled(): boolean {
    return this.options.publicAdvisoryCheckEnabled?.(this.options.root) ?? true;
  }

  handleAdvisorySettingChanged(sink?: MessageSink): void {
    if (sink !== undefined && this.updateContext !== undefined) {
      sink.postMessage({ status: 'update-advisories', context: this.updateContext, results: [] });
    }
    this.settingsGeneration += 1;
    this.updateContext = undefined;
    this.updateAdvisories.clear();
    this.inFlight?.abort();
  }

  /** Call from the panel's onDidDispose so an in-flight run stops with it. */
  dispose(): void {
    this.disposed = true;
    this.updateContext = undefined;
    this.updateAdvisories.clear();
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  private makeUpdateContext(): UpdateAdvisoryContext {
    return { scanId: this.scanId, projectId: this.options.projectInfo.id,
      sourceGeneration: this.revalidationGeneration, settingsGeneration: this.settingsGeneration };
  }

  private postSnapshot(sink: MessageSink, message: HostToWebviewMessage): void {
    if ('data' in message && this.updateContext !== undefined) {
      message = { ...message, data: { ...message.data, updateAdvisoryContext: this.updateContext,
        updateAdvisories: this.publicAdvisoryCheckEnabled() ? this.updateAdvisories.results() : [] } };
    }
    sink.postMessage(message);
  }

  private enrichOfferedVersions(sink: MessageSink): void {
    // Badges arrive after the table. A failure keeps the table as it is and is logged.
    fireAndForget(this.enrichUpdateVersions(offeredVersionPairs(this.lastResult?.rows ?? []), sink), (error) => {
      this.options.log?.(runtimeFailureLine('update-advisories', error));
    });
  }

  /** Host-derived picker options share exact-version memory and the bounded request queue. */
  enrichUpdateVersions(pairs: readonly UpdateVersionPair[], sink: MessageSink, wanted?: () => boolean): Promise<void> {
    const context = this.updateContext;
    if (context === undefined || this.disposed) return Promise.resolve();
    return this.updateAdvisories.enrich(pairs,
      () => !this.disposed && this.updateContext === context,
      results => sink.postMessage({ status: 'update-advisories', context, results }),
      wanted);
  }

  private async run(
    sink: MessageSink,
    reason: BackgroundRefreshReason = 'structural',
    strict = false
  ): Promise<BackgroundRefreshOutcome> {
    if (this.disposed) return { status: 'cancelled' };
    const scanGeneration = this.optionsDiskGeneration;
    this.scanId += 1;
    this.updateContext = undefined;
    this.updateAdvisories.clear(true);
    const performance = createPerformanceSession('Packageawy scan', this.performanceEnabled());
    // Time-only refresh requires an already-eligible snapshot. A targeted
    // local-mutation refresh starts one step earlier: updateProjectSnapshot
    // has applied a fresh disk read and advanced optionsGeneration, but no
    // scan has made the new rows eligible yet. Both fall back to the hard
    // path if their respective structural precondition does not hold.
    const effectiveReason: BackgroundRefreshReason =
      reason === 'time' && !this.isEligible()
        ? 'structural'
        : reason === 'local-mutation' && this.optionsGeneration !== this.revalidationGeneration
          ? 'structural'
          : reason;
    // Structural scans revoke derived authority. Disk inputs stay confirmed
    // only if no reload or watcher invalidated them before this scan began.
    const diskReadGeneration = this.scanInputsGeneration;
    const sourceWasCurrent = diskReadGeneration === this.diskReadGeneration;
    const generationAtStart =
      effectiveReason === 'structural' ? this.invalidateScan() : this.revalidationGeneration;

    // A newer run supersedes an older one outright. Without this, two runs race
    // to post and the slower (older) one can land last and win.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    // Scanning cannot make older disk inputs current. This covers every run,
    // including a structural scan started while a newer disk read is pending.
    const superseded = (): boolean => controller.signal.aborted || this.disposed ||
      !sourceWasCurrent || generationAtStart !== this.revalidationGeneration ||
      scanGeneration !== this.options.scanGeneration?.();
    const destination = sink;
    sink = { postMessage: message => { if (!superseded()) destination.postMessage(message); } };

    // Announce that a revalidation is now actively running: a no-op if
    // there's nothing to carry (a cold start already posted its own
    // `loading`) or `lastResult` was just explicitly cleared (`handleRefresh`
    // already posted its `loading` for that case), and a harmless
    // duplicate if an earlier call site (a watcher event, reloadAndScan's own
    // start) already announced this same revalidation. See
    // `announceRevalidating`'s doc.
    if (effectiveReason === 'structural') this.announceRevalidating(destination);

    const scanSource: ScanSource = {
      cacheKey: this.options.cacheKey,
      sourceFingerprint: this.currentSourceFingerprint(),
      projectFacts: this.projectFacts(),
    };
    const buildOptions: BuildPackageRowsOptions = {
      root: this.options.root,
      manifestText: this.options.manifestText,
      lockfileText: this.options.lockfileText,
      packageManager: this.options.packageManager ?? 'npm',
      importerId: this.options.importerId ?? '.',
      registry: this.options.registry,
      ...(this.options.resolvedRegistry === undefined ? {} : { resolvedRegistry: this.options.resolvedRegistry }),
      httpClient: this.options.httpClient,
      etagStore: this.options.etagStore,
      signal: controller.signal,
      performance,
      ...(this.options.auditRunner === undefined || this.options.packageManager === 'pnpm'
        ? {}
        : { auditRunner: this.options.auditRunner }),
      ...(this.options.packageManager === 'pnpm' ? { auditUnavailableWhenOmitted: false } : {}),
      ...(this.lockfileMissing() ? { lockfileMissing: true } : {}),
      ...(this.publicAdvisoryCheckEnabled() ? {} : { publicAdvisoryCheck: false }),
      publicAdvisoryCheckEnabled: () => this.publicAdvisoryCheckEnabled(),
      ...(this.options.log === undefined
        ? {}
        : { onDiagnostic: (entry) => this.options.log?.(diagnosticLine(entry)) }),
      ...(this.options.progressEnabled === true
        ? {
            onProgress: (progress) => {
              sink.postMessage({ status: 'scan-progress', ...progress });
            },
          }
        : {}),
    };

    try {
      const result = await buildPackageRows(buildOptions);
      // The pipeline checks the signal at each stage boundary, but a run that
      // was already past the last boundary when the abort fired still resolves
      // normally. Superseded or disposed, its result, and any cache write,
      // is not wanted either way.
      if (superseded()) {
        return { status: this.disposed ? 'cancelled' : 'superseded' };
      }
      const generatedAt = new Date().toISOString();
      const snapshot = toScanSnapshot({ ...result, ...scanSource.projectFacts });
      this.lastResult = snapshot;
      this.lastResultSourceFingerprint = scanSource.sourceFingerprint;
      this.lastResultDiskReadGeneration = diskReadGeneration;
      this.lastGeneratedAt = generatedAt;
      if (superseded()) return { status: 'superseded' };
      this.persistSnapshot(snapshot, generatedAt, scanSource, performance);
      // Only rows from the latest confirmed disk read can grant authority.
      if (
        hasCompleteCoreData(snapshot) &&
        generationAtStart === this.revalidationGeneration &&
        sourceWasCurrent
      ) {
        this.eligibleGeneration = generationAtStart;
        // A granted structural scan is itself a re-confirmation that
        // `this.options` are accurate as of this generation. In time-only
        // mode this is an idempotent assignment because no generation moved.
        this.optionsGeneration = generationAtStart;
      }
      if (generationAtStart === this.revalidationGeneration &&
          this.scanInputsGeneration === this.diskReadGeneration) {
        this.updateContext = this.makeUpdateContext();
      }
      if (superseded()) return { status: 'superseded' };
      this.postSnapshot(sink,
        toHostToWebviewMessage(
          snapshot,
          { isEmpty: snapshot.rows.length === 0, isStale: false },
          this.options.projectInfo,
          this.options.canChangeProject,
          this.options.buildInfo,
          generatedAt,
          this.readOnlyReason()
        )
      );
      this.enrichOfferedVersions(sink);
      return { status: 'succeeded' };
    } catch (cause) {
      if (!(cause instanceof FetchError) && !(cause instanceof SyntaxError) && !(cause instanceof YAMLException) &&
          !(cause instanceof UnsupportedLockfileError) && !(cause instanceof UnsupportedPnpmLockfileError) &&
          !isCancellation(cause) && !(strict ? isExpectedFsError(cause, 'read') : isFsError(cause))) throw cause;
      if (superseded()) {
        return { status: this.disposed ? 'cancelled' : 'superseded' };
      }
      if (isCancellation(cause)) return { status: 'cancelled' };
      // Nothing renderable at all: an unreadable manifest, an unsupported
      // lockfile version. Degraded-data failures never reach here: the
      // pipeline folds those into advisoriesError/auditUnavailable. If a good
      // snapshot is already on screen (a background revalidation that failed),
      // leave it exactly as it was rather than blowing it away with an error.
      if (this.lastResult === undefined) {
        sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      }
      return { status: 'failed', error: toProtocolError(cause) };
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
      performance.finish({ cancelled: controller.signal.aborted });
    }
  }
}
