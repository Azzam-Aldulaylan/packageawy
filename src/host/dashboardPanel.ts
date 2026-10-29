/**
 * The dashboard session behind the webview: lifecycle, the message boundary,
 * and watcher/reload wiring.
 *
 * One panel at a time, following the create-or-reveal pattern from VS Code's
 * own webview sample. Scan decisions live in DashboardController and upgrade
 * lifecycle decisions live in UpgradeAssistantCoordinator. The view itself
 * (HTML, CSP, resource roots) belongs to the platform glue that creates the
 * WebviewChannel. See platform/vscode/dashboardWebview.ts.
 *
 * SECURITY: every inbound message goes through isWebviewToHostMessage before
 * it is acted on. A webview is a separate security context. A message
 * arriving on this channel is not proof that we sent it.
 *
 * Project selection adds a second rule of the same shape: the webview can only ever ask to
 * open the project picker (`change-project`, no payload): it never names or
 * chooses a project. Discovery, labelling, and selection are entirely
 * host-owned (projectResolution.ts / projectPicker.ts). Nothing the webview
 * sends can select a candidate outside what this panel itself discovered.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import { NodeAuditRunner } from '../core/audit/npmAudit.js';
import { BranchChangeCoordinator, realBranchTimerScheduler } from './branchChangeCoordinator.js';
import { realTimerScheduler, BackgroundRefreshTimer } from '../core/cache/backgroundRefreshTimer.js';
import type { FileChangeKind } from '../core/cache/fileChangeCoordinator.js';
import { FileChangeCoordinator } from '../core/cache/fileChangeCoordinator.js';
import { DEFAULT_TTL_MINUTES, effectiveTtlMinutes } from '../core/cache/freshness.js';
import { deriveProjectCacheKey } from '../core/cache/keys.js';
import { computeSourceFingerprint, sourceFingerprintsMatch } from '../core/cache/sourceFingerprint.js';
import { PersistentEtagStore } from '../core/cache/persistentEtagStore.js';
import { PersistentProjectCacheStore } from '../core/cache/projectCacheStore.js';
import { DEFAULT_EXCLUDED_DIRS, isSameProjectReload, lockfileWatchDirs, projectCandidateLabel } from '../core/workspace/scan.js';
import { NodeHttpClient } from '../core/registry/http.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import { DashboardController } from './dashboardController.js';
import type { BackgroundRefreshOutcome, MessageSink } from './dashboardController.js';
import type { BuildInfo } from './dashboardData.js';
import type { ReloadSource } from './fileChangeReload.js';
import { reloadControllerFromDisk } from './fileChangeReload.js';
import { pickProject } from './projectPicker.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { discoverProjects, loadProject } from './projectResolution.js';
import { CancellationTokenSource } from './platform/cancellation.js';
import type { Disposable, HostPlatform, WebviewChannel } from './platform/hostPlatform.js';
import { reconcileProjectCandidates } from './projectReconciliation.js';
import { UpgradeAssistantCoordinator } from './upgradeAssistantCoordinator.js';
import { canRetryMutationEnrichment, classifyMutationEnrichmentStart } from './upgradeAssistantOutcome.js';
import { UsageAnalysisCoordinator } from './usage/usageCoordinator.js';
import { SmartCleanupMetadataCoordinator } from './smartCleanupMetadataCoordinator.js';
import { SmartCleanupDuplicateCoordinator } from './smartCleanupDuplicateCoordinator.js';
import type { SmartCleanupFinalRefreshEvidence } from './smartCleanupCompletionReport.js';
import { USAGE_FILE_WATCH_GLOB } from './usage/workspaceFiles.js';
import type { HostToWebviewMessage, ProtocolError, SelectedProjectInfo } from './webviewProtocol.js';
import type { WebviewToHostMessage } from './webviewProtocol.js';
import { isWebviewToHostMessage } from './webviewProtocol.js';

/** Spec's fixed background-refresh cadence: independent of the configurable `cacheTtlMinutes`, which only decides whether a given tick actually needs to do anything (see DashboardController.needsBackgroundRefresh). */
const BACKGROUND_REFRESH_INTERVAL_MS = 30 * 60_000;
/** Coalesces a burst of filesystem events (e.g. an editor's atomic save, which can fire delete+create in quick succession) into a single invalidation + rescan. */
const FILE_EVENT_DEBOUNCE_MS = 300;
const MAX_INTEGRATION_TEST_MESSAGES = 160;

export interface DashboardPanelIntegrationTestEvent {
  sequence: number;
  at: number;
  message: HostToWebviewMessage;
}

export interface DashboardPanelOptions {
  extensionVersion: string;
  /** Enables the integration test seam below. Never true for a normal session. */
  integrationTestMode: boolean;
}

export interface DashboardPanelIntegrationTestSnapshot {
  open: boolean;
  disposed: boolean;
  panelId: string | null;
  selectedManifestPath: string | null;
  packageManager: 'npm' | 'pnpm' | null;
  messages: readonly DashboardPanelIntegrationTestEvent[];
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

function toProjectInfo(candidate: DiscoveredProject): SelectedProjectInfo {
  return { label: projectCandidateLabel(candidate), manifestPath: candidate.manifestPath };
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  private readonly platform: HostPlatform;
  private readonly channel: WebviewChannel;
  private readonly sink: MessageSink;
  private readonly integrationTestMode: boolean;
  private readonly integrationTestPanelId = randomBytes(8).toString('hex');
  private readonly integrationTestMessages: DashboardPanelIntegrationTestEvent[] = [];
  private integrationTestMessageSequence = 0;
  private selectedPackageManager: 'npm' | 'pnpm' | null = null;
  private controller: DashboardController | undefined;
  /** In-flight or completed project resolution, dropped on failure so a retry re-runs it. */
  private pending: Promise<DashboardController | undefined> | undefined;
  /** Owns preflight, confirmation, transaction, verification, and completion. */
  private readonly upgradeCoordinator: UpgradeAssistantCoordinator;
  /** Owns on-demand "Where is this used?" / "Analyze cleanup" usage analysis. See src/host/usage/usageCoordinator.ts. */
  private readonly usageCoordinator: UsageAnalysisCoordinator;
  /** Lazy exact-version metadata used only while the Smart Cleanup workspace is open. */
  private readonly smartCleanupMetadataCoordinator: SmartCleanupMetadataCoordinator;
  /** Isolated, project-wide duplicate-consolidation preview and opaque action authority. */
  private readonly smartCleanupDuplicateCoordinator: SmartCleanupDuplicateCoordinator;
  /**
   * Shared across every controller this panel ever builds (initial open and
   * every reload) so ETag caching survives a reload, only the project
   * snapshot (root/manifestText/lockfileText/lockfilePath/registry/cacheKey)
   * is per-controller. `etagStore`/`projectCacheStore` are the persisted
   * stores: globalState/workspaceState respectively (see the file header on
   * the split): constructed once per panel and disposed once in
   * onDidDispose, exactly like `httpClient`/`auditRunner` already were.
   */
  private readonly httpClient = new NodeHttpClient();
  private readonly etagStore: PersistentEtagStore;
  private readonly projectCacheStore: PersistentProjectCacheStore;
  private readonly auditRunner = new NodeAuditRunner();
  private readonly backgroundTimer: BackgroundRefreshTimer;
  /** Computed once at construction: the same value for every controller/reload this panel session ever builds. See DashboardData's doc for why this exists (confirming a dev's rebuild actually loaded). */
  private readonly buildInfo: BuildInfo;
  /** Set once onDidDispose fires, so an async continuation mid-flight can bail before posting into a gone webview. */
  private disposed = false;
  /** The candidate a plain refresh (or a post-upgrade reload) re-reads: set on selection, untouched by refresh itself. */
  private selectedProject: DiscoveredProject | undefined;
  /**
   * How many candidates the most recent discovery found: drives
   * `canChangeProject`. Only re-discovery (initial load, or an explicit
   * "change project") updates this. A plain refresh reuses it, since
   * refresh's job is re-reading the selected project, not re-scanning the
   * whole workspace for new ones.
   */
  private candidateCount = 0;
  /** Incremented at the start of every `reloadAndScan` call. See that method's doc comment for the race it closes. */
  private reloadGeneration = 0;

  /** file watchers for the currently selected project's manifest/lockfile topology, recreated on every project switch. */
  private manifestWatcher: Disposable | undefined;
  /** One watcher per ancestor directory (see setupFileWatchers), never a single glob built by interpolating directory names, which real directory content could break out of. */
  private lockfileWatchers: Disposable[] = [];
  private configurationWatchers: Disposable[] = [];
  /** Source/config watcher used only to obsolete an open project-compatibility review. It never invalidates dashboard dependency facts. */
  private projectCompatibilitySourceWatcher: Disposable | undefined;
  /** The absolute lockfile path the current persisted entry was built against: needed to purge every npm-workspace sibling sharing it once a reload has just replaced it. Null means the selected project has no lockfile. */
  private selectedLockfilePath: string | null = null;
  private invalidationTimer: NodeJS.Timeout | undefined;
  private projectCompatibilityInvalidationTimer: NodeJS.Timeout | undefined;
  /** Advanced before debouncing so final analysis reads can detect events that race their snapshot. */
  private projectCompatibilitySourceGeneration = 0;
  /** Monotonic dependency/source/config identity for on-demand Smart Cleanup evidence. */
  private smartCleanupSourceGeneration = 0;
  /** Optional built-in Git HEAD subscription for the repository containing the selected manifest. */
  private gitHeadWatcher: Disposable | undefined;
  private gitWatchedProjectPath: string | undefined;
  private gitWatcherSetupGeneration = 0;
  private branchProjectPickerCancellation: CancellationTokenSource | undefined;
  /** Owns coalescing, upgrade-busy deferral, and serialized generation-checked reloads for watcher events. See fileChangeCoordinator.ts. This panel only owns the actual watcher subscriptions and debounce timing. */
  private readonly fileChangeCoordinator = new FileChangeCoordinator({
    isBusy: () => this.upgradeCoordinator.isMutationBusy(),
    currentGeneration: () => this.reloadGeneration,
    reload: (kinds, generation) => this.reloadAfterFileChange(kinds, generation),
  });
  private readonly branchChangeCoordinator = new BranchChangeCoordinator(
    realBranchTimerScheduler,
    {
      isMutationBusy: () => this.upgradeCoordinator.isMutationBusy(),
      reconcile: (generation) => this.reconcileAfterGitHeadChange(generation),
    },
    FILE_EVENT_DEBOUNCE_MS
  );
  private readonly reloadSource: ReloadSource<DiscoveredProject> = {
    loadProject: (candidate) => this.loadProjectMeasured(candidate, 'Packageawy project reload'),
    toProjectInfo,
    cacheKeyFor: (candidate, registry, packageManager) =>
      deriveProjectCacheKey(candidate.id, registry, packageManager ?? 'npm'),
  };

  private constructor(platform: HostPlatform, channel: WebviewChannel, options: DashboardPanelOptions) {
    this.platform = platform;
    this.channel = channel;
    this.integrationTestMode = options.integrationTestMode;
    this.buildInfo = {
      extensionVersion: options.extensionVersion,
      builtAt: __BUILD_TIME__,
    };
    this.sink = {
      postMessage: (message) => {
        if (this.integrationTestMode) {
          this.integrationTestMessageSequence += 1;
          this.integrationTestMessages.push({ sequence: this.integrationTestMessageSequence, at: Date.now(), message });
          if (this.integrationTestMessages.length > MAX_INTEGRATION_TEST_MESSAGES) {
            this.integrationTestMessages.splice(
              0,
              this.integrationTestMessages.length - MAX_INTEGRATION_TEST_MESSAGES
            );
          }
        }
        if (this.performanceEnabled()) {
          const performance = createPerformanceSession('Packageawy webview message', true);
          const endSerialization = performance.start('webview message serialization');
          const serialized = JSON.stringify(message);
          endSerialization({ status: message.status, bytes: Buffer.byteLength(serialized) });
          performance.finish({ status: message.status });
        }
        this.channel.postMessage(message);
      },
    };
    this.etagStore = new PersistentEtagStore(platform.globalState);
    this.projectCacheStore = new PersistentProjectCacheStore(platform.workspaceState);
    this.upgradeCoordinator = new UpgradeAssistantCoordinator({
      platform,
      sink: this.sink,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      ensureController: () => this.ensureController(),
      getSelectedProject: () => this.selectedProject,
      getSmartCleanupDeprecationEvidence: () => this.smartCleanupMetadataCoordinator.currentDeprecationEvidence(),
      getSmartCleanupDedupeEvidence: (requestId, actionId) =>
        this.smartCleanupDuplicateCoordinator.evidence(requestId, actionId),
      isDisposed: () => this.disposed,
      reloadFinalState: async () => {
        await this.reloadAndScan(undefined, { forceUsageRecheck: true });
      },
      reloadSmartCleanupFinalState: () => this.reloadAndCaptureFinalState(),
      readAndApplyMutationLocalState: () => this.readAndApplyMutationLocalState(),
      refreshMutationEnrichmentInBackground: (refreshId, packageName, structurallyCurrent) =>
        this.refreshMutationEnrichmentInBackground(refreshId, packageName, structurallyCurrent),
      flushDeferredChanges: async () => {
        await this.fileChangeCoordinator.flushAll();
      },
      onMutationLockReleased: () => {
        if (this.branchChangeCoordinator.hasPending) {
          this.branchChangeCoordinator.mutationReleased();
          return;
        }
        void this.usageCoordinator.runPendingBackgroundRefresh();
      },
      performanceEnabled: this.performanceEnabled,
      storeProjectCompatibilityReferences: (packageName, references, folder) =>
        this.usageCoordinator.storeProjectCompatibilityReferences(packageName, references, folder),
      projectCompatibilitySourceGeneration: () => this.projectCompatibilitySourceGeneration,
      smartCleanupRemovalEvidence: (requestId, packages) =>
        this.usageCoordinator.smartCleanupRemovalEvidence(requestId, packages),
    });
    this.usageCoordinator = new UsageAnalysisCoordinator({
      platform,
      sink: this.sink,
      ensureController: () => this.ensureController(),
      getSelectedProject: () => this.selectedProject,
      isDisposed: () => this.disposed,
      isUpgradeBusy: () => this.upgradeCoordinator.isMutationBusy(),
      performanceEnabled: this.performanceEnabled,
    });
    this.smartCleanupMetadataCoordinator = new SmartCleanupMetadataCoordinator({
      sink: this.sink,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      ensureController: () => this.ensureController(),
      isDisposed: () => this.disposed,
      sourceGeneration: () => this.smartCleanupSourceGeneration,
    });
    this.smartCleanupDuplicateCoordinator = new SmartCleanupDuplicateCoordinator({
      sink: this.sink,
      ensureController: () => this.ensureController(),
      isDisposed: () => this.disposed,
      sourceGeneration: () => this.smartCleanupSourceGeneration,
    });
    this.backgroundTimer = new BackgroundRefreshTimer(realTimerScheduler, BACKGROUND_REFRESH_INTERVAL_MS, () => {
      this.onBackgroundTick();
    });

    this.channel.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return;
      void this.handle(raw);
    });

    this.channel.onDidDispose(() => {
      // An in-flight pipeline run must not outlive the panel, nor try to
      // post into a webview that no longer exists.
      this.disposed = true;
      this.controller?.dispose();
      this.controller = undefined;
      this.pending = undefined;
      this.selectedPackageManager = null;
      // A mutating task is deliberately allowed to reach a stable boundary
      // even after its panel closes. The transaction's async owner keeps the
      // session alive until install/verification/rollback completes.
      this.upgradeCoordinator.disposeWhenIdle();
      this.usageCoordinator.dispose();
      this.smartCleanupMetadataCoordinator.dispose();
      this.smartCleanupDuplicateCoordinator.dispose();
      this.disposeWatchers();
      this.gitHeadWatcher?.dispose();
      this.gitHeadWatcher = undefined;
      this.branchProjectPickerCancellation?.cancel();
      this.branchProjectPickerCancellation?.dispose();
      this.branchProjectPickerCancellation = undefined;
      this.branchChangeCoordinator.dispose();
      this.fileChangeCoordinator.dispose();
      this.backgroundTimer.dispose();
      this.etagStore.dispose();
      this.projectCacheStore.dispose();
      DashboardPanel.current = undefined;
    });

    // Only while the panel is open: disposed above the moment it closes.
    this.backgroundTimer.start();
  }

  /** Reveals the open panel. False when none is open. */
  static reveal(): boolean {
    const existing = DashboardPanel.current;
    if (existing === undefined) return false;
    existing.channel.reveal();
    return true;
  }

  static create(platform: HostPlatform, channel: WebviewChannel, options: DashboardPanelOptions): void {
    DashboardPanel.current = new DashboardPanel(platform, channel, options);
  }

  /** The refresh command only refreshes what is already open. It never opens a panel. */
  static async refresh(): Promise<void> {
    await DashboardPanel.current?.handle({ type: 'refresh' });
  }

  /**
   * Narrow Extension Host test seam. It is enabled only for VS Code's test
   * extension mode (or the explicit child-process flag used by the runner),
   * and is not registered as a command or exposed to the webview.
   */
  static integrationTestSnapshot(): DashboardPanelIntegrationTestSnapshot {
    const current = DashboardPanel.current;
    if (current === undefined) {
      return {
        open: false,
        disposed: true,
        panelId: null,
        selectedManifestPath: null,
        packageManager: null,
        messages: [],
      };
    }
    if (!current.integrationTestMode) {
      throw new Error('Packageawy integration state is only available in Extension Host tests.');
    }
    return {
      open: true,
      disposed: current.disposed,
      panelId: current.integrationTestPanelId,
      selectedManifestPath: current.selectedProject?.manifestPath ?? null,
      packageManager: current.selectedPackageManager,
      messages: current.integrationTestMessages.map((event) => ({ ...event })),
    };
  }

  /** Dispatches through the same validator and handler used by the webview. */
  static async dispatchIntegrationTestMessage(raw: unknown): Promise<void> {
    const current = DashboardPanel.current;
    if (current === undefined || !current.integrationTestMode) {
      throw new Error('Packageawy integration dispatch requires an open test panel.');
    }
    if (!isWebviewToHostMessage(raw)) {
      throw new Error('Packageawy integration dispatch rejected an invalid webview message.');
    }
    await current.handle(raw);
  }

  private async handle(message: WebviewToHostMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.upgradeCoordinator.handleWebviewReady();
      const controller = await this.ensureController();
      if (controller === undefined) return;
      await controller.handleReady(this.sink);
      void this.usageCoordinator.requestBackgroundUsageRefresh();
      return;
    }
    if (message.type === 'load-upgrade-targets') {
      await this.upgradeCoordinator.handleLoadUpgradeTargets(message);
      return;
    }
    if (message.type === 'upgrade') {
      await this.upgradeCoordinator.handleAnalyzeUpgrade(message);
      return;
    }
    if (message.type === 'bulk-upgrade') {
      await this.upgradeCoordinator.handleAnalyzeBulkUpgrade(message);
      return;
    }
    if (message.type === 'confirm-upgrade') {
      await this.upgradeCoordinator.handleConfirmUpgrade(message);
      return;
    }
    if (message.type === 'use-smart-plan') {
      await this.upgradeCoordinator.handleUseSmartPlan(message);
      return;
    }
    if (message.type === 'retry-upgrade-enrichment') {
      this.retryMutationEnrichment(message.refreshId);
      return;
    }
    if (message.type === 'cancel-upgrade') {
      this.upgradeCoordinator.handleCancelUpgrade(message);
      return;
    }
    if (message.type === 'bulk-remove') {
      await this.upgradeCoordinator.handleAnalyzeBulkRemove(message);
      return;
    }
    if (message.type === 'smart-cleanup-remove') {
      await this.upgradeCoordinator.handleAnalyzeSmartCleanupRemove(message);
      return;
    }
    if (message.type === 'confirm-remove') {
      await this.upgradeCoordinator.handleConfirmRemove(message);
      return;
    }
    if (message.type === 'cancel-remove') {
      this.upgradeCoordinator.handleCancelRemove(message);
      return;
    }
    if (message.type === 'configure-verification') {
      this.upgradeCoordinator.handleConfigureVerification();
      return;
    }
    if (message.type === 'analyze-remediation') {
      // Read-only reviews may coexist. Only a transaction that can write the
      // dependency files blocks another source/dependency read.
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'remediation-error',
          package: message.package,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'A dependency change is currently being applied to this project.' },
        });
        return;
      }
      await this.upgradeCoordinator.handleAnalyzeRemediation(message);
      return;
    }
    if (message.type === 'analyze-remediations') {
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'remediation-batch-error',
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'A dependency change is currently being applied to this project.' },
        });
        return;
      }
      await this.upgradeCoordinator.handleAnalyzeRemediations(message);
      return;
    }
    if (message.type === 'cancel-remediation-analysis') {
      this.upgradeCoordinator.handleCancelRemediation();
      return;
    }
    if (message.type === 'confirm-remediation') {
      await this.upgradeCoordinator.handleConfirmRemediation(message);
      return;
    }
    if (message.type === 'cancel-remediation') {
      this.upgradeCoordinator.handleCancelRemediationPlan(message);
      return;
    }
    if (message.type === 'retry-remediation') {
      await this.upgradeCoordinator.handleRetryRemediation(message);
      return;
    }
    if (message.type === 'where-used') {
      // A retained decision review is not active work. Only mutation owns
      // package.json/lockfile strongly enough to defer this read.
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'usage-error',
          package: message.package,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'A dependency change is currently being applied to this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleWhereUsed(message);
      return;
    }
    if (message.type === 'reanalyze-usage') {
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'usage-error',
          package: message.package,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'A dependency change is currently being applied to this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleWhereUsed(message, true);
      return;
    }
    if (message.type === 'analyze-cleanup') {
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'cleanup-error',
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'A dependency change is currently being applied to this project.' },
        });
        return;
      }
      await this.usageCoordinator.handleAnalyzeCleanup();
      return;
    }
    if (message.type === 'analyze-smart-cleanup-metadata') {
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'smart-cleanup-metadata-error',
          requestId: message.requestId,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress.' },
        });
        return;
      }
      await this.smartCleanupMetadataCoordinator.analyze(message.requestId);
      return;
    }
    if (message.type === 'cancel-smart-cleanup-metadata') {
      this.smartCleanupMetadataCoordinator.cancel(message.requestId);
      return;
    }
    if (message.type === 'analyze-smart-cleanup-duplicates') {
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'smart-cleanup-duplicates-error',
          requestId: message.requestId,
          error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress.' },
        });
        return;
      }
      await this.smartCleanupDuplicateCoordinator.analyze(message.requestId);
      return;
    }
    if (message.type === 'cancel-smart-cleanup-duplicates') {
      this.smartCleanupDuplicateCoordinator.cancel(message.requestId);
      return;
    }
    if (message.type === 'cancel-usage-analysis') {
      this.usageCoordinator.handleCancel();
      return;
    }
    if (message.type === 'cancel-removal-impact') {
      this.usageCoordinator.handleCancelRemovalImpact(message);
      return;
    }
    if (message.type === 'analyze-removal-impact') {
      // Read-only reviews may coexist. Only a package-manager transaction can
      // make this source scan race dependency-file writes.
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.sink.postMessage({
          status: 'removal-impact-error',
          requestId: message.requestId,
          packages: [...message.packages].sort((left, right) => left.localeCompare(right)),
          error: {
            code: 'UPGRADE_IN_PROGRESS',
            message: 'A dependency change is currently being applied. Wait for it to finish, then analyze removal impact again.',
          },
        });
        return;
      }
      await this.usageCoordinator.handleAnalyzeRemovalImpact(message);
      return;
    }
    if (message.type === 'open-usage-reference') {
      this.usageCoordinator.handleOpenReference(message);
      return;
    }
    if (message.type === 'change-project') {
      // Same rule as refresh below: a project switch mid-upgrade would race
      // a scan (and a controller replacement) against a package.json/
      // lockfile an upgrade task is still writing to.
      if (this.upgradeCoordinator.isBusy() || this.upgradeCoordinator.isRemediationBusy()) return;
      await this.changeProject();
      return;
    }
    if (message.type === 'refresh') {
      // Ignored, not queued, while an upgrade holds the panel's lock: this
      // covers both the webview's Refresh button (also disabled client-
      // side while an upgrade is active, see App.tsx) and the Command
      // Palette's "Packageawy: Refresh", which bypasses the
      // webview entirely and would otherwise race a scan against a
      // package.json/lockfile an upgrade task is still writing to.
      if (this.upgradeCoordinator.isBusy() || this.upgradeCoordinator.isRemediationBusy()) return;
      // Manual refresh always re-reads the currently selected project's
      // package.json/lockfile from disk (see reloadAndScan) so externally
      // changed dependencies show up, without silently reverting to
      // whichever candidate discovery happened to find first.
      // `forceUsageRecheck: true`: an explicit Refresh click guarantees one
      // fresh usage/cleanup background pass the same way a first-ever open
      // does, bypassing the fingerprint gate other reload paths respect. See
      // UsageAnalysisCoordinator.requestBackgroundUsageRefresh's doc for
      // why forcing is safe here.
      if (this.selectedProject === undefined) {
        const controller = await this.ensureController();
        if (controller === undefined) return;
        await controller.handleReady(this.sink);
        void this.usageCoordinator.requestBackgroundUsageRefresh({ force: true });
        return;
      }
      await this.reloadAndScan(this.selectedProject, { forceUsageRecheck: true });
      return;
    }
    if (message.type === 'open-advisory') {
      this.openAdvisory(message);
      return;
    }
    const controller = await this.ensureController();
    if (controller === undefined) return; // ensureController already posted the failure.
    await controller.handleReady(this.sink);
    void this.usageCoordinator.requestBackgroundUsageRefresh();
  }

  /**
   * The webview names an advisory, never a URL. See
   * webviewProtocol.ts's doc on `open-advisory` and
   * DashboardController.resolveAdvisoryUrl for the actual trust boundary.
   * A miss (unknown package/advisory, or a URL that failed the `https:`
   * check) is silently a no-op: there is nothing unsafe about it, so there
   * is nothing worth surfacing as an error either.
   */
  private openAdvisory(message: { package: string; advisoryId: string | number; path: string[]; reference?: string }): void {
    const url = this.controller?.resolveAdvisoryUrl(message);
    if (url === null || url === undefined) return;
    this.platform.openExternal(url);
  }

  /**
   * Re-discovers every candidate and shows the picker, regardless of how
   * many candidates existed the last time discovery ran, so a project
   * added or removed since then is reflected, same as manual refresh
   * re-reads the selected project's files fresh rather than trusting a
   * cached copy. Cancelling leaves `this.selectedProject` untouched: the
   * currently selected project stays selected, nothing is posted.
   */
  private async changeProject(): Promise<void> {
    const performance = createPerformanceSession('Packageawy project discovery', this.performanceEnabled());
    let candidates: DiscoveredProject[];
    try {
      candidates = await discoverProjects(this.platform, performance);
    } catch (cause) {
      performance.finish({ failed: true });
      if (this.disposed) return;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
    performance.finish({ candidates: candidates.length });
    if (this.disposed) return;
    this.candidateCount = candidates.length;

    if (candidates.length === 0) {
      // Extremely unlikely (a project is already selected), but handled the
      // same way a fresh zero-candidate discovery always is.
      this.sink.postMessage({
        status: 'fatal-error',
        error: { code: 'NoProjectFoundError', message: 'No package.json was found in this workspace.' },
      });
      return;
    }

    // Same rule as the initial selection: exactly one candidate needs no
    // prompt. Only reachable if every other candidate disappeared between
    // "Change project" becoming visible (canChangeProject was true then)
    // and this re-discovery: re-select the sole remaining one directly.
    if (candidates.length === 1) {
      // An upgrade could have started while discoverProjects() was pending
      // (it isn't itself lock-holding): re-check right before applying,
      // the same "closest to the effect" placement the multi-candidate
      // branch below already uses for its picker.
      if (this.upgradeCoordinator.isBusy()) return;
      await this.reloadAndScan(candidates[0]);
      return;
    }

    const picked = await pickProject(this.platform, candidates);
    if (this.disposed) return;
    if (picked === undefined) return; // cancelled: current selection is preserved, nothing to do
    // An upgrade could have started while the picker was open (it isn't
    // itself lock-holding). Re-check right before applying the pick, the
    // same "closest to the effect" placement the upgrade flow's own
    // Workspace Trust re-check uses.
    if (this.upgradeCoordinator.isBusy()) return;

    await this.reloadAndScan(picked);
  }

  /**
   * Re-reads a candidate's package.json/the lockfile from disk and
   * (re)builds the controller's project snapshot before scanning: used by
   * manual refresh, a successful upgrade, and picking a new project via
   * `changeProject`, so none of them ever scan against stale, in-memory
   * manifest/lockfile text. The fetch machinery (httpClient/etagStore/
   * auditRunner) is shared across every reload via panel-level fields, so a
   * reload does not lose ETag caching.
   *
   * Defaults to `this.selectedProject`: refresh and the post-upgrade
   * reload both call this with no argument, so they always re-read the
   * currently selected project, never silently reverting to whichever
   * candidate discovery happened to find first.
   *
   * `reloadGeneration` guards against a subtler race than the upgrade lock
   * covers: `onDidReceiveMessage` dispatches each message via `void
   * this.handle(raw)`, unawaited, so nothing stops two `reloadAndScan` calls
   * from being in flight together (e.g. a slow Refresh on project A racing a
   * fast "change project" pick of B). Without a generation check, whichever
   * call's `loadProject` (disk I/O) happens to resolve last wins and
   * overwrites `this.selectedProject`, which could silently revert an
   * explicit, later project switch back to an earlier, slower request. This
   * mirrors the identical "a newer run supersedes an older one outright"
   * rule `DashboardController.run()` already applies one layer down for
   * racing scans of the same project. This is the same rule for racing
   * calls that can now target different projects.
   *
   * A watcher event can also arrive during this method's `loadProject`
   * await: queued in `fileChangeCoordinator` and scheduled behind its own
   * debounce timer. `setupFileWatchers` below tears down and rebuilds the
   * watchers once this reload has its fresh data, which cancels that
   * timer, and since this method never runs through the coordinator's own
   * `runAndDrain` self-draining loop (that only fires for watcher-triggered
   * reloads), nothing else would ever flush the queued event. Handled in two
   * places, not one, because which project a pending event is about
   * changes partway through this method, right at `setupFileWatchers`:
   *   - Immediately after `setupFileWatchers` installs the new watchers (for
   *     a switch), before the next `await`: anything pending right then can
   *     only be a leftover from the old watchers (nothing has had a chance
   *     to fire on the brand new ones yet, since no await has happened in
   *     between): discarded outright, since it was never about the newly
   *     selected project. Skipped for a same-project reload: there is no
   *     "old" vs "new" selection to disambiguate, so nothing here would ever
   *     be anything but relevant.
   *   - After the forced scan completes, unconditionally: by then
   *     any old-project leftover has already been cleared (the step above),
   *     so whatever is pending is guaranteed to be a genuine event from the
   *     currently active watchers: for the project this method just
   *     finished reloading, switch or not: always drained, never discarded.
   *
   * One more supersession point sits right before that final flush: this
   * call's `generation` is re-checked against `this.reloadGeneration`
   * one last time, after the network scan has had the whole
   * length of that scan to be overtaken by an entirely newer, faster
   * reloadAndScan call. Superseded here, this call must flush nothing at
   * all: the newer call already owns (or is about to own) that job for
   * whatever project is now actually selected.
   */
  private async reloadAndScan(
    candidate: DiscoveredProject | undefined = this.selectedProject,
    options: { forceUsageRecheck?: boolean; clearOnLoadFailure?: boolean } = {}
  ): Promise<BackgroundRefreshOutcome | undefined> {
    if (candidate === undefined) return undefined; // nothing selected yet. Only reachable before init ever completes

    const previousProjectId = this.selectedProject?.id;
    const sameProjectReload = isSameProjectReload(previousProjectId, candidate.id);
    if (!sameProjectReload) {
      this.smartCleanupSourceGeneration += 1;
      this.usageCoordinator.invalidateProjectSource(previousProjectId);
      this.usageCoordinator.invalidateProjectSource(candidate.id);
    }

    // Captured before the disk read even starts, not after: the moment this
    // reload begins, whatever the existing controller currently considers
    // eligible must stop being trusted for Upgrade until a matching
    // revalidation actually completes, and the panel announces that
    // immediately too (not only once a scan actually starts), so Upgrade
    // buttons visibly disable for the whole debounce-plus-disk-read window,
    // not just the network round trip. `revalidation` stays undefined when
    // there's no existing controller yet (unreachable in practice. See the
    // method doc: this mirrors the same defensive style as
    // `this.controller?.dispose()` elsewhere). `generationAtReadStart` is
    // threaded through to `updateProjectSnapshot` below so it can tell
    // whether anything else called `beginRevalidation()` while this
    // specific disk read was in flight. See that method's doc for why
    // a project reload must never silently claim a later, unrelated event's
    // generation as its own.
    const controllerBeforeReload = this.controller;
    const revalidation =
      controllerBeforeReload === undefined
        ? undefined
        : { controller: controllerBeforeReload, generationAtReadStart: controllerBeforeReload.beginRevalidation() };
    revalidation?.controller.announceRevalidating(this.sink);

    this.reloadGeneration += 1;
    const generation = this.reloadGeneration;
    // This reload is authoritative and about to fully replace the current
    // snapshot itself: anything a watcher had queued (pending or already
    // deferred behind an upgrade) before this reload began is superseded
    // outright, never applied on top of what this call is about to write.
    // (A burst that arrives during this reload's disk read is handled
    // separately, below. See the method doc.)
    this.fileChangeCoordinator.discardPending();

    let project: ResolvedProject;
    try {
      project = await this.loadProjectMeasured(candidate, 'Packageawy project reload');
    } catch (cause) {
      if (this.disposed || generation !== this.reloadGeneration) return;
      if (options.clearOnLoadFailure === true) {
        this.clearCurrentProjectForBranch(
          'The selected package.json disappeared while this branch was loading. Select a project and try again.',
          'ProjectChangedDuringBranchLoadError'
        );
        return;
      }
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return;
    }
    if (this.disposed || generation !== this.reloadGeneration) return;
    this.selectedProject = candidate;

    const projectInfo = toProjectInfo(candidate);
    const canChangeProject = this.candidateCount > 1;
    const cacheKey = this.cacheKeyFor(candidate, project);
    this.setupFileWatchers(candidate, path.join(project.root, 'package.json'));
    this.selectedLockfilePath = project.lockfilePath;

    if (!sameProjectReload) {
      // The watchers installed just above are now live for `candidate`, but
      // anything pending right now, before any further await, can only be
      // a leftover from the old (pre-switch) watchers: nothing has had a
      // chance to fire on the new ones yet. Discard it here, synchronously,
      // rather than at the end of this method: waiting would let it also
      // catch a genuine new-project event that the new watchers queue
      // while the scan below is in flight, discarding a legitimate
      // reload instead of applying it.
      this.fileChangeCoordinator.discardPending();
    }

    let controller: DashboardController;
    if (revalidation === undefined) {
      controller = this.buildController(project, projectInfo, canChangeProject, cacheKey);
      this.controller = controller;
    } else {
      controller = revalidation.controller;
      controller.updateProjectSnapshot(
        { ...project, projectInfo, canChangeProject, cacheKey },
        revalidation.generationAtReadStart
      );
    }
    // A same-project manual/post-action refresh already has useful rows on
    // screen. Keep them visible (marked stale by the revalidation announcement
    // above) while the forced scan runs. A genuine project switch must still
    // clear the old project's rows so they are never presented under the new
    // project identity.
    const scanOutcome = sameProjectReload
      ? await controller.refreshInBackground(this.sink)
      : await controller.handleRefresh(this.sink);

    // The network scan can take long enough for an
    // entirely separate, newer reloadAndScan call (a faster project switch,
    // or another refresh) to start AND finish while this one was still
    // awaiting it: that newer call already ran (or is about to run) its
    // own end-of-method flush, for its own, now-current project. This one is
    // superseded outright: touching the coordinator here at all would either
    // duplicate that newer flush or, worse, act on pending state that
    // belongs to whatever project is now actually selected, not the one this
    // call was for. Bail without flushing anything.
    if (this.disposed || generation !== this.reloadGeneration) return undefined;

    // Queued, not awaited: dependency data is already published to the
    // webview above, so usage/cleanup analysis must never block on it: it
    // runs quietly in the background, or is deferred if something (another
    // usage analysis, or the mutation lock this call may itself still be
    // running under, e.g. an upgrade's `reloadFinalState`) is still busy.
    // See UsageAnalysisCoordinator.requestBackgroundUsageRefresh's doc.
    void this.usageCoordinator.requestBackgroundUsageRefresh({ force: options.forceUsageRecheck === true });

    // Whatever is pending now is guaranteed to be from the *currently
    // active* watchers: any old-project leftover was already cleared above
    // for a switch, and a same-project reload never had an old/new
    // distinction to begin with. Always drain, never discard: a no-op if
    // nothing arrived, otherwise a fresh, mandatory second disk read through
    // the normal `reloadAfterFileChange` path.
    await this.fileChangeCoordinator.flush();
    return scanOutcome;
  }

  /**
   * Reloads the dashboard and then performs one bounded final disk reread.
   * Smart Cleanup uses this host-only evidence to prove that its completion
   * report belongs to the exact stable source which produced the refreshed
   * rows. Ordinary upgrade/removal callers use the normal reload path.
   */
  private async reloadAndCaptureFinalState(): Promise<SmartCleanupFinalRefreshEvidence | undefined> {
    const outcome = await this.reloadAndScan(undefined, { forceUsageRecheck: true });
    if (outcome?.status !== 'succeeded') return undefined;
    const controller = this.controller;
    const candidate = this.selectedProject;
    const evidence = controller?.lastResultEvidence() ?? null;
    if (controller === undefined || candidate === undefined || evidence === null || this.disposed) return undefined;

    const generationAtReadStart = this.smartCleanupSourceGeneration;
    const confirmed = await this.loadProjectMeasured(candidate, 'Smart Cleanup final evidence reread');
    const generationAfterRead = this.smartCleanupSourceGeneration;
    if (this.disposed || candidate !== this.selectedProject || controller !== this.controller) return undefined;

    const confirmedSourceFingerprint = computeSourceFingerprint({
      manifestText: confirmed.manifestText,
      lockfileText: confirmed.lockfileText,
      lockfilePath: confirmed.lockfilePath,
      packageManager: confirmed.packageManager,
      importerId: confirmed.importerId,
    });
    if (!sourceFingerprintsMatch(evidence.sourceFingerprint, confirmedSourceFingerprint)) return undefined;

    return {
      snapshot: evidence.snapshot,
      projectId: candidate.id,
      generationAtReadStart,
      generationAfterRead,
      sourceFingerprint: evidence.sourceFingerprint,
      confirmedSourceFingerprint,
    };
  }

  /**
   * Applies the package-manager transaction's freshly re-read local project
   * state without starting a registry/audit scan. Every watcher event queued
   * before this snapshot is already represented by the read and is discarded;
   * new watchers are installed immediately so later external edits retain the
   * normal structural-invalidation path.
   */
  private async readAndApplyMutationLocalState(): Promise<
    { project: ResolvedProject; structurallyCurrent: boolean } | undefined
  > {
    const candidate = this.selectedProject;
    const controller = this.controller;
    if (candidate === undefined || controller === undefined) return undefined;

    this.reloadGeneration += 1;
    const generation = this.reloadGeneration;
    // Only events already queued before this read belong to the transaction
    // whose final state we are about to capture. Events arriving during the
    // read remain queued and are drained after the mutation lock is released.
    this.fileChangeCoordinator.discardPending();
    const generationAtReadStart = controller.beginRevalidation();
    const project = await this.loadProjectMeasured(candidate, 'Packageawy post-upgrade local refresh');
    if (
      this.disposed ||
      generation !== this.reloadGeneration ||
      candidate !== this.selectedProject ||
      project.root !== controller.root
    ) {
      return undefined;
    }
    controller.invalidateCache();
    const update = controller.updateProjectSnapshot(
      {
        ...project,
        projectInfo: toProjectInfo(candidate),
        canChangeProject: this.candidateCount > 1,
        cacheKey: this.cacheKeyFor(candidate, project),
      },
      generationAtReadStart
    );
    this.setupFileWatchers(candidate, path.join(project.root, 'package.json'));
    this.selectedLockfilePath = project.lockfilePath;
    return { project, structurallyCurrent: update.structurallyCurrent };
  }

  private mutationEnrichment:
    | {
        refreshId: string;
        packageName: string;
        state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';
      }
    | undefined;

  /** Starts only the derived/network phase after local facts are already visible. */
  private refreshMutationEnrichmentInBackground(
    refreshId: string,
    packageName: string,
    structurallyCurrent = true
  ): void {
    const controller = this.controller;
    const lifecycle = { refreshId, packageName, state: 'running' as const };
    this.mutationEnrichment = lifecycle;
    if (classifyMutationEnrichmentStart(structurallyCurrent) === 'superseded') {
      // A watcher advanced while the final local read was in flight. That
      // read may still supply useful display facts, but it cannot seed a
      // targeted scan or authorize "applied". The retained watcher burst
      // owns the structurally authoritative reload after lock release.
      this.mutationEnrichment = { ...lifecycle, state: 'superseded' };
      this.sink.postMessage({
        status: 'upgrade-enrichment-result',
        refreshId,
        package: packageName,
        outcome: 'superseded',
      });
      return;
    }
    if (controller === undefined) {
      this.mutationEnrichment = { ...lifecycle, state: 'failed' };
      this.sink.postMessage({
        status: 'upgrade-enrichment-result',
        refreshId,
        package: packageName,
        outcome: 'failed',
        error: { code: 'NO_PROJECT', message: 'The project is not available for dependency data refresh.' },
      });
      return;
    }
    void controller.refreshInBackground(this.sink, 'local-mutation').then((outcome) => {
      if (this.disposed) return;
      const current = this.mutationEnrichment;
      const terminalOutcome = current === lifecycle ? outcome : { status: 'superseded' as const };
      if (current === lifecycle) {
        this.mutationEnrichment = { ...lifecycle, state: terminalOutcome.status };
      }
      this.sink.postMessage({
        status: 'upgrade-enrichment-result',
        refreshId,
        package: packageName,
        outcome: terminalOutcome.status,
        ...(terminalOutcome.status === 'failed' ? { error: terminalOutcome.error } : {}),
      });
      if (terminalOutcome.status !== 'succeeded' || this.controller !== controller) return;
      void this.usageCoordinator.requestBackgroundUsageRefresh({ force: true });
    });
  }

  /** Replays only the exact failed/cancelled lifecycle named by the webview. */
  private retryMutationEnrichment(refreshId: string): void {
    const lifecycle = this.mutationEnrichment;
    if (!canRetryMutationEnrichment(lifecycle, refreshId) || lifecycle === undefined) return;
    this.refreshMutationEnrichmentInBackground(lifecycle.refreshId, lifecycle.packageName);
  }

  /**
   * Project resolution is async and can fail (no folder open, no package.json,
   * or the user cancels the initial picker). That is reported as fatal-error
   * over the same channel rather than thrown during construction, so the
   * panel still opens and shows a retryable state: clicking Retry re-sends
   * `ready`, which runs this whole selection flow again from scratch.
   */
  private async ensureController(): Promise<DashboardController | undefined> {
    if (this.controller !== undefined) return this.controller;
    this.pending ??= this.createController();
    const controller = await this.pending;
    if (controller === undefined) this.pending = undefined;
    return controller;
  }

  private async createController(): Promise<DashboardController | undefined> {
    const performance = createPerformanceSession('Packageawy project load', this.performanceEnabled());
    try {
      const candidate = await this.selectInitialProject(performance);
      if (this.disposed || candidate === undefined) return undefined; // already posted (or torn down)

      this.selectedProject = candidate;
      const project = await loadProject(this.platform, candidate, performance);
      if (this.disposed) return undefined;

      this.setupFileWatchers(candidate, path.join(project.root, 'package.json'));
      this.selectedLockfilePath = project.lockfilePath;
      this.controller = this.buildController(
        project,
        toProjectInfo(candidate),
        this.candidateCount > 1,
        this.cacheKeyFor(candidate, project)
      );
      return this.controller;
    } catch (cause) {
      if (this.disposed) return undefined;
      this.sink.postMessage({ status: 'fatal-error', error: toProtocolError(cause) });
      return undefined;
    } finally {
      performance.finish();
    }
  }

  /**
   * Zero candidates: the existing "no project" error. One: silently
   * auto-selected, no prompt. Two or more: a QuickPick: cancelling it
   * leaves the panel in the same retryable fatal-error state as zero
   * candidates, distinguished only by the message, since there is no
   * "currently selected project" yet to fall back to on a first-ever open.
   */
  private async selectInitialProject(performance: PerformanceRecorder): Promise<DiscoveredProject | undefined> {
    const candidates = await discoverProjects(this.platform, performance);
    if (this.disposed) return undefined;
    this.candidateCount = candidates.length;

    if (candidates.length === 0) {
      this.sink.postMessage({
        status: 'fatal-error',
        error: { code: 'NoProjectFoundError', message: 'No package.json was found in this workspace.' },
      });
      return undefined;
    }
    if (candidates.length === 1) return candidates[0];

    const picked = await pickProject(this.platform, candidates);
    if (this.disposed) return undefined;
    if (picked === undefined) {
      this.sink.postMessage({
        status: 'fatal-error',
        error: { code: 'NoProjectSelectedError', message: 'Select a project to see its dependencies.' },
      });
      return undefined;
    }
    return picked;
  }

  private buildController(
    project: ResolvedProject,
    projectInfo: SelectedProjectInfo,
    canChangeProject: boolean,
    cacheKey: string
  ): DashboardController {
    this.selectedPackageManager = project.packageManager;
    return new DashboardController({
      root: project.root,
      manifestText: project.manifestText,
      lockfileText: project.lockfileText,
      lockfilePath: project.lockfilePath,
      packageManager: project.packageManager,
      importerId: project.importerId,
      lockfileName: project.lockfileName,
      registry: project.registry,
      resolvedRegistry: project.resolvedRegistry,
      peerPolicy: project.peerPolicy,
      httpClient: this.httpClient,
      etagStore: this.etagStore,
      auditRunner: this.auditRunner,
      projectInfo,
      canChangeProject,
      buildInfo: this.buildInfo,
      projectCacheStore: this.projectCacheStore,
      cacheKey,
      ttlMinutesProvider: this.ttlMinutesProvider,
      performanceEnabled: this.performanceEnabled,
      progressEnabled: true,
    });
  }

  private readonly performanceEnabled = (): boolean =>
    this.platform.getSetting<boolean>('debug.performance', false);

  private async loadProjectMeasured(candidate: DiscoveredProject, operation: string): Promise<ResolvedProject> {
    const performance = createPerformanceSession(operation, this.performanceEnabled());
    try {
      return await loadProject(this.platform, candidate, performance);
    } finally {
      performance.finish();
    }
  }

  /** project identity (stable across scans) plus registry. See deriveProjectCacheKey for why both are needed to avoid cross-registry contamination within the same project. */
  private cacheKeyFor(candidate: DiscoveredProject, project: ResolvedProject): string {
    return deriveProjectCacheKey(candidate.id, project.registry, project.packageManager);
  }

  private readonly ttlMinutesProvider = (): number => {
    const raw = this.platform.getSetting<number>('cacheTtlMinutes', DEFAULT_TTL_MINUTES);
    return effectiveTtlMinutes(raw);
  };

  private onBackgroundTick(): void {
    if (this.disposed || this.controller === undefined || this.upgradeCoordinator.isBusy()) return;
    if (!this.controller.needsBackgroundRefresh()) return;
    const controller = this.controller;
    void controller.refreshInBackground(this.sink, 'time').then((outcome) => {
      if (outcome.status !== 'succeeded' || this.disposed || this.controller !== controller) return;
      void this.usageCoordinator.requestBackgroundUsageRefresh();
    });
  }

  private disposeWatchers(): void {
    this.manifestWatcher?.dispose();
    this.manifestWatcher = undefined;
    for (const watcher of this.lockfileWatchers) watcher.dispose();
    this.lockfileWatchers = [];
    for (const watcher of this.configurationWatchers) watcher.dispose();
    this.configurationWatchers = [];
    this.projectCompatibilitySourceWatcher?.dispose();
    this.projectCompatibilitySourceWatcher = undefined;
    if (this.invalidationTimer !== undefined) {
      clearTimeout(this.invalidationTimer);
      this.invalidationTimer = undefined;
    }
    if (this.projectCompatibilityInvalidationTimer !== undefined) {
      clearTimeout(this.projectCompatibilityInvalidationTimer);
      this.projectCompatibilityInvalidationTimer = undefined;
    }
  }

  private setupGitHeadWatcher(manifestPath: string): void {
    if (this.gitWatchedProjectPath === manifestPath && this.gitHeadWatcher !== undefined) return;
    this.gitHeadWatcher?.dispose();
    this.gitHeadWatcher = undefined;
    this.gitWatchedProjectPath = manifestPath;
    this.gitWatcherSetupGeneration += 1;
    const setupGeneration = this.gitWatcherSetupGeneration;
    void this.platform.watchGitHead(manifestPath, () => this.onGitHeadChanged()).then((watcher) => {
      if (this.disposed || setupGeneration !== this.gitWatcherSetupGeneration) {
        watcher?.dispose();
        return;
      }
      this.gitHeadWatcher = watcher;
      if (watcher === undefined) this.gitWatchedProjectPath = undefined;
    });
  }

  private onGitHeadChanged(): void {
    if (this.disposed) return;
    this.branchProjectPickerCancellation?.cancel();
    // Supersede an in-flight reload immediately. The debounced reconciliation
    // below owns the first snapshot that may become authoritative on this HEAD.
    this.reloadGeneration += 1;
    this.controller?.beginRevalidation();
    this.controller?.announceRevalidating(this.sink);
    this.projectCompatibilitySourceGeneration += 1;
    this.smartCleanupSourceGeneration += 1;
    this.usageCoordinator.invalidateProjectSource(this.selectedProject?.id);
    this.upgradeCoordinator.handleDependencySourceChanged();
    this.fileChangeCoordinator.discardPending();
    if (this.invalidationTimer !== undefined) {
      clearTimeout(this.invalidationTimer);
      this.invalidationTimer = undefined;
    }
    if (this.projectCompatibilityInvalidationTimer !== undefined) {
      clearTimeout(this.projectCompatibilityInvalidationTimer);
      this.projectCompatibilityInvalidationTimer = undefined;
    }
    this.branchChangeCoordinator.notify();
  }

  private clearCurrentProjectForBranch(message: string, code: string): void {
    this.reloadGeneration += 1;
    this.fileChangeCoordinator.discardPending();
    this.controller?.dispose();
    this.controller = undefined;
    this.pending = undefined;
    this.selectedProject = undefined;
    this.selectedPackageManager = null;
    this.selectedLockfilePath = null;
    this.disposeWatchers();
    this.sink.postMessage({ status: 'fatal-error', error: { code, message } });
  }

  private async pickBranchProject(
    candidates: readonly DiscoveredProject[]
  ): Promise<DiscoveredProject | undefined> {
    const cancellation = new CancellationTokenSource();
    this.branchProjectPickerCancellation = cancellation;
    try {
      return await pickProject(this.platform, candidates, cancellation.token);
    } finally {
      if (this.branchProjectPickerCancellation === cancellation) {
        this.branchProjectPickerCancellation = undefined;
      }
      cancellation.dispose();
    }
  }

  private async reconcileAfterGitHeadChange(headGeneration: number): Promise<void> {
    if (this.disposed || !this.branchChangeCoordinator.hasPending) return;
    if (this.upgradeCoordinator.isMutationBusy()) return;
    const previous = this.selectedProject;
    const performance = createPerformanceSession('Packageawy branch reconciliation', this.performanceEnabled());
    let candidates: DiscoveredProject[];
    try {
      candidates = await discoverProjects(this.platform, performance);
    } catch (cause) {
      performance.finish({ failed: true });
      if (this.upgradeCoordinator.isMutationBusy()) return;
      if (this.disposed || !this.branchChangeCoordinator.claim(headGeneration)) return;
      this.clearCurrentProjectForBranch(toProtocolError(cause).message, 'BranchReconciliationError');
      return;
    }
    performance.finish({ candidates: candidates.length });
    if (this.upgradeCoordinator.isMutationBusy()) return;
    if (this.disposed || !this.branchChangeCoordinator.hasPending) return;
    const decision = reconcileProjectCandidates(previous, candidates);
    // Claim this exact HEAD before any panel mutation or QuickPick. A newer
    // HEAD makes the claim fail and leaves all current state untouched.
    if (!this.branchChangeCoordinator.claim(headGeneration)) return;
    this.candidateCount = candidates.length;

    if (decision.kind === 'none') {
      this.clearCurrentProjectForBranch(
        'No package.json was found on this branch.',
        'NoProjectFoundOnBranchError'
      );
      return;
    }

    if (decision.kind === 'selection-required') {
      this.clearCurrentProjectForBranch(
        'Select a project to see dependencies on this branch.',
        'NoProjectSelectedOnBranchError'
      );
      const picked = await this.pickBranchProject(decision.candidates);
      if (this.upgradeCoordinator.isMutationBusy()) {
        this.branchChangeCoordinator.deferClaimed(headGeneration);
        return;
      }
      if (this.disposed || !this.branchChangeCoordinator.isCurrent(headGeneration)) return;
      if (picked === undefined) return;
      await this.reloadAndScan(picked, { clearOnLoadFailure: true });
      return;
    }

    await this.reloadAndScan(decision.candidate, { clearOnLoadFailure: true });
    // HEAD events cancel the ordinary file debounce. Revalidate retained
    // upgrade evidence against the reconciled project as well, even when only
    // source/config contents (not dependency versions) changed on this branch.
    void this.upgradeCoordinator.checkOpenAnalysisFreshness();
  }

  /**
   * Recreated on every project switch/reload so watchers always track the
   * currently selected project's actual files.
   *
   * One watcher per ancestor directory `lockfileWatchDirs` returns: every
   * directory `nearestLockfileDir` could ever resolve to for this project,
   * up to the workspace folder root: each watching only the fixed pattern
   * `{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml}`. Deliberately not a single
   * watcher built by interpolating every ancestor directory name into one
   * glob string: a directory name is real filesystem content the workspace
   * happens to contain, and a legal one containing `*`, `?`, `[`, `]`, `{`,
   * `}`, or `,` would be reinterpreted as glob syntax instead of matched
   * literally. See lockfileWatchDirs's doc. Each directory here is used
   * only as the watcher's literal base directory, exactly like the manifest
   * watcher below already does. Only the hardcoded filenames, which this
   * codebase controls, ever appear in the glob pattern itself.
   */
  private setupFileWatchers(candidate: DiscoveredProject, manifestPath: string): void {
    this.disposeWatchers();
    this.projectCompatibilitySourceGeneration += 1;
    this.setupGitHeadWatcher(manifestPath);

    this.manifestWatcher = this.platform.watchFiles(
      path.dirname(manifestPath),
      path.basename(manifestPath),
      () => this.onWatchedFileEvent('manifest')
    );

    const projectBase = candidate.dir === ''
      ? candidate.folder.path
      : path.join(candidate.folder.path, candidate.dir);
    const onProjectCompatibilitySourceEvent = (filePath: string): void => {
      const relative = path.relative(projectBase, filePath);
      if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
      if (relative.split(path.sep).some((segment) => DEFAULT_EXCLUDED_DIRS.includes(segment))) return;
      this.projectCompatibilitySourceGeneration += 1;
      this.smartCleanupSourceGeneration += 1;
      this.usageCoordinator.invalidateProjectSource(candidate.id);
      this.upgradeCoordinator.handleProjectSourceChanged();
      if (this.projectCompatibilityInvalidationTimer !== undefined) {
        clearTimeout(this.projectCompatibilityInvalidationTimer);
      }
      this.projectCompatibilityInvalidationTimer = setTimeout(() => {
        this.projectCompatibilityInvalidationTimer = undefined;
        void this.upgradeCoordinator.checkOpenAnalysisFreshness();
        if (!this.branchChangeCoordinator.hasPending) {
          void this.usageCoordinator.requestBackgroundUsageRefresh();
        }
      }, FILE_EVENT_DEBOUNCE_MS);
    };
    this.projectCompatibilitySourceWatcher = this.platform.watchFiles(
      projectBase,
      USAGE_FILE_WATCH_GLOB,
      onProjectCompatibilitySourceEvent
    );

    const onConfigurationEvent = (): void => this.onWatchedFileEvent('configuration');
    this.configurationWatchers.push(
      this.platform.watchFiles(path.dirname(manifestPath), '.npmrc', onConfigurationEvent)
    );

    const onLockfileEvent = (): void => this.onWatchedFileEvent('lockfile');
    for (const dir of lockfileWatchDirs(candidate.dir)) {
      const dirPath = path.join(candidate.folder.path, dir);
      this.lockfileWatchers.push(
        this.platform.watchFiles(dirPath, '{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml}', onLockfileEvent)
      );
      this.configurationWatchers.push(
        this.platform.watchFiles(dirPath, 'pnpm-workspace.yaml', onConfigurationEvent)
      );
    }
  }

  /**
   * Host-owned debounce timing for the actual reload, but eligibility is
   * invalidated synchronously, right here, before any of that: a stale-or-
   * revalidating source must never authorize an Upgrade, and waiting for the
   * debounce would leave that gap open for the whole ~300ms window (or
   * longer, coalesced across a burst) between the file actually changing and
   * the reload it schedules actually running. `announceRevalidating` is
   * called synchronously in the same breath, not deferred until `run()`
   * eventually starts: this is the actual source of "revalidating" the
   * webview needs to see immediately: without it, the table would still show
   * `ready` (Upgrade buttons enabled) for the whole debounce window even
   * though the host has already revoked eligibility for it.
   */
  private onWatchedFileEvent(kind: FileChangeKind): void {
    if (this.disposed) return;
    this.controller?.beginRevalidation();
    this.controller?.announceRevalidating(this.sink);
    this.smartCleanupSourceGeneration += 1;
    this.usageCoordinator.invalidateProjectSource(this.selectedProject?.id);
    this.upgradeCoordinator.handleDependencySourceChanged();
    if (this.branchChangeCoordinator.hasPending) return;
    this.fileChangeCoordinator.notify(kind);
    if (this.invalidationTimer !== undefined) clearTimeout(this.invalidationTimer);
    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = undefined;
      void this.fileChangeCoordinator.flush();
      // A watcher event only requests revalidation. Compare the retained
      // review's exact dependency and consumed source evidence before showing
      // a stale warning. No-op saves must not revoke completed results.
      void this.upgradeCoordinator.checkOpenAnalysisFreshness();
    }, FILE_EVENT_DEBOUNCE_MS);
  }

  /**
   * The actual reload behind a watcher-triggered invalidation: called by
   * `fileChangeCoordinator` only once it has decided this burst is current
   * and not superseded. Always re-reads the selected project from disk
   * (never rescans the controller's old construction-time strings), and
   * never posts `loading`: `reloadControllerFromDisk`'s `refreshInBackground`
   * call leaves whatever is already rendered on screen exactly as it is
   * until (and unless) the new scan actually completes.
   *
   * `generation` alone is not enough to decide "is this still about the
   * right project," even though `this.reloadGeneration` is what
   * `reloadAndScan` bumps on every switch: it bumps that counter before
   * awaiting its `loadProject` call, but only assigns `this.selectedProject`
   * after that await resolves and its generation check passes. In the
   * gap between those two points, `this.reloadGeneration` already reflects
   * the switch-in-progress while `this.selectedProject` still reads as the
   * old project, so a watcher event for the old project, coalesced via
   * `fileChangeCoordinator` with that same new generation number (read live
   * off `this.reloadGeneration` at notify/drain time), would pass a
   * generation-only check despite genuinely being about the wrong project.
   * `candidate` is captured once, below, at the very start of this method,
   * every place this method re-checks "is this still current" compares
   * against that same captured reference, not just the generation number.
   */
  private async reloadAfterFileChange(kinds: ReadonlySet<FileChangeKind>, generation: number): Promise<void> {
    const candidate = this.selectedProject;
    const controller = this.controller;
    if (candidate === undefined || controller === undefined) return;
    // Every drained coordinator iteration is its revalidation attempt,
    // called again here even though `onWatchedFileEvent` already called it
    // for the raw event that led here, so that a burst drained automatically
    // after a held-open reload (see FileChangeCoordinator's self-draining)
    // is also covered, not just the first event of a burst. Captured (not
    // discarded) so `updateProjectSnapshot` (inside `reloadControllerFromDisk`
    // below) can tell whether anything else called `beginRevalidation()`
    // while this disk read was in flight. See that method's doc.
    const generationAtReadStart = controller.beginRevalidation();
    controller.announceRevalidating(this.sink);
    const previousLockfilePath = this.selectedLockfilePath;

    // A shared npm-workspace root lockfile affects every member project, not
    // just this one: purge by the previous resolved path (what every
    // currently-persisted entry, including sibling members with no live
    // controller right now, was actually keyed against) before reloading,
    // not after. `reloadControllerFromDisk` below ends by persisting a fresh
    // entry for this project's cacheKey under its (possibly identical,
    // a lockfile content edit with no topology change is the common case)
    // resolved lockfile path. Purging afterward by that same path would
    // immediately delete the entry this very reload just wrote.
    if (kinds.has('lockfile') && previousLockfilePath !== null) {
      this.projectCacheStore.deleteByLockfilePath(previousLockfilePath);
    }

    let outcome;
    try {
      outcome = await reloadControllerFromDisk({
        candidate,
        controller,
        canChangeProject: this.candidateCount > 1,
        sink: this.sink,
        source: this.reloadSource,
        generationAtReadStart,
        isStillCurrent: () => !this.disposed && generation === this.reloadGeneration && candidate === this.selectedProject,
      });
    } catch {
      // Can't re-read the project right now (e.g. its manifest was deleted
      // mid-edit): leave the last good render as-is. A later event (the
      // file reappearing, or the user picking a different project) recovers.
      return;
    }
    if (this.disposed || !outcome.applied) return;

    // `reloadControllerFromDisk`'s `isStillCurrent` check above only runs
    // once, right after its `loadProject` disk read resolves: before the
    // network scan (`refreshInBackground`) it awaits next. A switch can
    // start and fully complete during that scan, same as the disk-read gap
    // this method's doc explains: re-check both generation and candidate
    // identity again here, right before mutating panel-level state, so a
    // stale `outcome` from an old project can never install its watchers or
    // lockfile path over whatever project is now actually selected.
    if (generation !== this.reloadGeneration || candidate !== this.selectedProject) return;

    this.setupFileWatchers(candidate, path.join(outcome.project.root, 'package.json'));
    this.selectedLockfilePath = outcome.project.lockfilePath;
    // The watcher event cleared the likely-unused findings. Bring them back
    // for the new source. Some editors report a change only after the
    // change's own refresh has already run.
    void this.usageCoordinator.requestBackgroundUsageRefresh();
  }
}
