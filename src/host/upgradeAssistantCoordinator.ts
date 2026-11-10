/**
 * Host-side coordinator for one dependency-upgrade lifecycle.
 *
 * DashboardPanel owns the webview, project selection, watchers, and reload
 * machinery. This class owns everything from validating an untrusted upgrade
 * message through preflight, the Upgrade Analysis modal, transaction
 * execution, final-state reload, and user-visible completion.
 *
 * The flow has two phases:
 *
 *   handleAnalyzeUpgrade    Eligibility, the panel-wide lock, preflight,
 *                           smart-plan search, and security-outcome
 *                           evaluation. Stores the result (always freshly
 *                           derived, never trusted from the webview) under a
 *                           random `analysisId` and posts it to the webview.
 *                           The lock stays held for as long as the review
 *                           modal is open.
 *   handleConfirmUpgrade    Looks up the stored analysis by id, re-reads the
 *   handleUseSmartPlan      project from disk, rechecks eligibility, then
 *                           executes the transaction.
 *   handleCancelUpgrade     Releases the lock without executing anything.
 *
 * The stored analysis is never execution authority by itself. See the
 * STALE_SOURCE recheck in handleConfirmUpgrade/handleUseSmartPlan.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { buildDependencyGraph } from '../core/lockfile/build.js';
import { computeSourceFingerprint } from '../core/cache/sourceFingerprint.js';
import { runSequentialBatch } from '../core/async/sequentialBatch.js';
import { directNodes } from '../core/lockfile/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from '../core/advisories/bulk.js';
import { enrichAdvisoriesWithGitHubIdentifiers } from '../core/advisories/githubIdentifiers.js';
import {
  createTransitiveRemediationPlan,
  type RemediationGraphSnapshot,
  type TransitiveRemediationPlan,
} from '../core/advisories/transitiveRemediationPlan.js';
import type { AttributedAdvisory } from '../core/types.js';
import { analyzeCompatibility, CompatibilityCancelledError } from '../core/compatibility/preflight.js';
import type { CompatibilityStatus, UpgradeProposal } from '../core/compatibility/types.js';
import { RegistryPackageMetadataProvider, registryForPackage } from '../core/compatibility/registryMetadataProvider.js';
import { FetchError } from '../core/registry/http.js';
import type { HttpClient } from '../core/registry/http.js';
import { runPool } from '../core/registry/pool.js';
import { fetchDistTags, fetchPackument } from '../core/registry/versions.js';
import type { EtagStore } from '../core/registry/versions.js';
import type { DependencyReference } from '../core/usage/types.js';
import type {
  ProjectCompatibilityAnalysis,
} from '../core/projectCompatibility/index.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { createPerformanceSession } from '../core/performance/measurement.js';
import { inspectAppliedUpgradeState } from '../core/upgrade/appliedState.js';
import { planSmartUpgrade } from '../core/upgrade/smartPlan.js';
import {
  loadUpgradeTargets,
  publishedUpgradeTargetsForRequest,
  selectUpgradeTargetsFromDistTags,
} from '../core/upgrade/targets.js';
import { buildStagedManifest, buildStagedManifestForRemoval } from '../core/upgrade/stagedManifest.js';
import { isMajorUpgrade } from '../core/upgrade/plan.js';
import { stillRequiredBy } from '../core/upgrade/removeImpact.js';
import { buildPeerRequirementIndex, peerRequirementsFor } from '../core/upgrade/peerRequirement.js';
import { buildWhyInstalledIndex } from '../core/hygiene/whyInstalled.js';
import { describeBulkRejection, describeBulkRemoveRejection } from '../core/upgrade/validate.js';
import type { EligibleRemoval, EligibleUpgrade } from '../core/upgrade/validate.js';
import { advisoriesByNameFromRows } from '../core/advisories/attribution.js';
import { resolveRemediationRequest } from '../core/advisories/remediationRequest.js';
import type { RemediationRequestRejection } from '../core/advisories/remediationRequest.js';
import { auditUpgradeReview } from './upgradeReviewSecurity.js';
import { requiresSecurityAcknowledgement } from './upgradeSecuritySummary.js';
import { resolveTrustedAttributedAdvisoryUrl } from '../core/advisories/resolve.js';
import type { AdvisoryLookupRequest } from '../core/advisories/resolve.js';
import { PUBLIC_ADVISORY_CHECK_SETTING } from './dashboardController.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { createNodeUpgradeTransactionFileAdapter } from './nodeUpgradeTransactionFiles.js';
import { PNPM_NOT_FOUND_MESSAGE, resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import { materializeUpgradeSecurityGraph } from './upgradeSecurityGraph.js';
import { readPnpmWorkspaceLayout } from './pnpmWorkspaceLayout.js';
import type { PnpmWorkspaceLayout } from './pnpmWorkspaceLayout.js';
import type { HostPlatform, WorkspaceFolder } from './platform/hostPlatform.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { loadProject } from './projectResolution.js';
import { IsolatedResolverVerifier, NodeResolverProcessRunner } from './resolverVerifier.js';
import { collectProjectCompatibilityEvidence, parseProjectManifestCompatibilityEvidence } from './projectCompatibility/projectEvidenceCollector.js';
import { runProjectCompatibilityWorkflow } from './projectCompatibility/projectCompatibilityWorkflow.js';
import { TargetPackageInspector } from './projectCompatibility/targetPackageInspector.js';
import { TargetPackageSurfaceCache } from './projectCompatibility/targetPackageInspector.js';
import {
  projectCompatibilityEvidenceIsCurrent,
  projectCompatibilityFinalReadIsCurrent,
} from './projectCompatibility/projectCompatibilityFreshness.js';
import { resolveAnalysisForExecution } from './upgradeAnalysisLookup.js';
import type { AnalysisLookupRejection } from './upgradeAnalysisLookup.js';
import { UPGRADE_ANALYSIS_RETENTION_MS, UPGRADE_ANALYSIS_SOFT_STALE_MS } from './upgradeFreshness.js';
import {
  buildUpgradeAnalysisChanges,
  buildUpgradeAnalysisFiles,
  buildUpgradeAnalysisPresentation,
  buildUpgradeAnalysisVerification,
} from './upgradeAnalysisPresentation.js';
import { buildRemoveAnalysisPresentation } from './removeAnalysisPresentation.js';
import {
  classifyUpgradeApplication,
  describeRemovedPackages,
  describeRemoveTransactionOutcome,
  describeUpgradeTransactionOutcome,
} from './upgradeAssistantOutcome.js';
import { createRangePreservingInstall } from './rangePreservingInstall.js';
import { UpgradeExecutionSession } from './upgradeRunner.js';
import { OperationReservation, SourceGenerationGuard } from './operationReservation.js';
import { runUpgradeTransaction } from './upgradeTransaction.js';
import type { UpgradeTransactionFileAdapter } from './upgradeTransaction.js';
import {
  SMART_CLEANUP_RESTORE_MESSAGES,
  SMART_CLEANUP_RESTORE_TASK_TITLE,
  captureSmartCleanupRestoreFiles,
  restoreSmartCleanupFiles,
  smartCleanupRestoreFilesMatchDisk,
} from './smartCleanupRestorePoint.js';
import type { SmartCleanupRestoreFile } from './smartCleanupRestorePoint.js';
import { selectVerificationScripts, suggestVerificationScriptNames } from './verificationPolicy.js';
import { applyVerificationOptIn } from './verificationOptIn.js';
import type { VerificationOptInRequest } from './verificationOptIn.js';
import type { VerificationScript } from './verificationPolicy.js';
import { smartCleanupProjectCapability } from './smartCleanupProjectCapability.js';
import { dependencyChangeRefusal } from './packageManagerSupport.js';
import { canonicalProjectRoot, projectMutationLocks, type ProjectMutationLocks } from './projectMutationLock.js';
import { buildSmartCleanupCompletionReport } from './smartCleanupCompletionReport.js';
import type {
  SmartCleanupBeforeSnapshot,
  SmartCleanupCompletionReportResult,
  SmartCleanupFinalRefreshEvidence,
} from './smartCleanupCompletionReport.js';
import type {
  ProtocolError,
  SecurityOutcome,
  SmartCleanupCompletionPresentation,
  TransitiveRemediationApplyResult,
  TransitiveRemediationPlanSummary,
  UpgradeAnalysisSmartPlan,
  UpgradeResultPresentation,
} from './webviewProtocol.js';
import { buildTransitiveRemediationPresentation } from './transitiveRemediationPresentation.js';

export interface UpgradeChangeRequest {
  package: string;
  target: string;
}

export interface UpgradeMessage extends UpgradeChangeRequest {
  /** Client-minted correlation nonce for this analysis attempt. See webviewProtocol.ts's doc on `WebviewToHostMessage`'s `requestId`. Never trust/execution surface. Echoed back verbatim on every message belonging to this attempt, never stored on StoredAnalysis. */
  requestId: string;
}

export interface LoadUpgradeTargetsMessage {
  package: string;
  requestId: string;
}

export interface BulkUpgradeMessage {
  changes: UpgradeChangeRequest[];
  requestId: string;
}

export interface RemoveMessage {
  package: string;
}

export interface BulkRemoveMessage {
  changes: RemoveMessage[];
}

export interface SmartCleanupRemoveMessage {
  /** Smart Cleanup analysis correlation. */
  requestId: string;
  packages: string[];
  /** Exact removal-impact evidence correlation. */
  removalRequestId: string;
}

interface SmartCleanupRemovalEvidence {
  isCurrent(): boolean;
}

export interface RemediationMessage {
  package: string;
}

export interface RemediationBatchMessage {
  packages: string[];
}

export interface RemediationAnalysisMessage extends VerificationOptInRequest {
  analysisId: string;
}

export interface AnalysisMessage extends VerificationOptInRequest {
  securityAcknowledged?: boolean;
  analysisId: string;
}

export interface CancelUpgradeMessage {
  analysisId: string | null;
}

export interface CancelRemoveMessage extends CancelUpgradeMessage {
  /** Present for Smart Cleanup so a cancellation can find a just-stored review before its analysisId reaches the webview. */
  requestId?: string;
}

export interface UpgradeAssistantCoordinatorOptions {
  platform: HostPlatform;
  sink: MessageSink;
  httpClient: HttpClient;
  etagStore: EtagStore;
  ensureController(): Promise<DashboardController | undefined>;
  getSelectedProject(): DiscoveredProject | undefined;
  getSmartCleanupDeprecationEvidence?(): {
    deprecatedPackages: readonly string[];
    installedVersions: Readonly<Record<string, string>>;
  } | undefined;
  isDisposed(): boolean;
  reloadFinalState(): Promise<void>;
  /** Reloads and captures the exact post-transaction evidence used only by Smart Cleanup completion reporting. */
  reloadSmartCleanupFinalState?(): Promise<SmartCleanupFinalRefreshEvidence | undefined>;
  /** Reads and applies post-mutation package.json/lockfile state without waiting for registry/audit enrichment. */
  readAndApplyMutationLocalState?(): Promise<
    { project: ResolvedProject; structurallyCurrent: boolean } | undefined
  >;
  /** Starts the expensive derived-data scan after local state has already been published. */
  refreshMutationEnrichmentInBackground?(
    refreshId: string,
    packageName: string,
    structurallyCurrent: boolean
  ): void;
  flushDeferredChanges(): Promise<void>;
  /**
   * Fires once the mutation lock is actually released after a transaction
   * that called `reloadFinalState()`: the moment a background usage
   * refresh queued during that reload (see UsageAnalysisCoordinator's
   * `requestBackgroundUsageRefresh`) is allowed to actually start. Called
   * after deferred watcher changes are flushed so background work observes
   * the authoritative post-mutation project state.
   */
  onMutationLockReleased?(): void;
  performanceEnabled?(): boolean;
  /**
   * The directory whose dependency files a change here would write: the
   * lockfile root when one is known. Falls back to the selected project's
   * directory. Keys the extension-wide one-change-per-project lock.
   */
  mutationRoot?(): string | undefined;
  /** Test seam. Production shares one process-wide lock registry. */
  mutationLocks?: ProjectMutationLocks;
  /** Test seam. Production always uses the host-owned project loader. */
  loadProject?: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
  /** Test seam. Production always uses the platform's cancellable progress. See defaultWithCompatibilityProgress. */
  withCompatibilityProgress?: <T>(title: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /** Test seam. Production always reads the real `packageawy` upgrade configuration (see defaultGetUpgradeConfiguration). */
  getUpgradeConfiguration?: () => { ignoreScripts: boolean; verificationScripts: unknown[] };
  /** Reuses UsageReferenceStore for finding navigation. Returns one opaque usage id for the supplied host-owned references. */
  storeProjectCompatibilityReferences?(
    packageName: string,
    references: readonly DependencyReference[],
    folder: WorkspaceFolder
  ): string | null;
  /** Monotonic generation advanced synchronously by relevant source/config watcher events. */
  projectCompatibilitySourceGeneration?: () => number;
  /** Resolves one webview request to the exact host-owned removal-impact evidence it reviewed. */
  smartCleanupRemovalEvidence?(
    requestId: string,
    packages: readonly string[]
  ): SmartCleanupRemovalEvidence | null;
}

const MAX_REMEDIATION_PRESENTED_ADVISORIES = 400;

/** Production default for `UpgradeAssistantCoordinatorOptions.withCompatibilityProgress`: the exact `withProgress`/`AbortController` wiring `handleAnalyzeUpgradeRequests`'s compatibility preflight used inline before this seam existed. */
async function defaultWithCompatibilityProgress<T>(
  platform: HostPlatform,
  title: string,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return platform.withProgress(
    title,
    async (_progress, token) => {
      const abort = new AbortController();
      const cancellation = token.onCancellationRequested(() => abort.abort());
      try {
        return await run(abort.signal);
      } finally {
        cancellation.dispose();
      }
    }
  );
}

/** Production default for `UpgradeAssistantCoordinatorOptions.getUpgradeConfiguration`. */
function defaultGetUpgradeConfiguration(platform: HostPlatform): { ignoreScripts: boolean; verificationScripts: unknown[] } {
  return {
    ignoreScripts: platform.getSetting<boolean>('upgrade.ignoreScripts', true),
    verificationScripts: platform.getSetting<unknown[]>('upgrade.verificationScripts', []),
  };
}

/** Suggestions are offered only when the setting selected nothing for this manifest. */
function verificationSuggestionsFor(manifestText: string, configured: readonly VerificationScript[]): string[] {
  return configured.length > 0 ? [] : suggestVerificationScriptNames(manifestText);
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof FetchError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

const ANALYSIS_LOOKUP_ERRORS: Record<AnalysisLookupRejection, ProtocolError> = {
  STALE_ANALYSIS: { code: 'STALE_ANALYSIS', message: 'This upgrade analysis is no longer current. Analyze again.' },
  NO_SMART_PLAN: { code: 'NO_SMART_PLAN', message: 'No coordinated upgrade plan was offered for this analysis.' },
  PREFLIGHT_CONFLICT: { code: 'PREFLIGHT_CONFLICT', message: 'Compatibility preflight found blocking peer conflicts.' },
};

const ADVISORY_CHECK_OFF_MESSAGE = 'Security checks are turned off for this project. Turn them on to check a fix.';
const ADVISORY_CHECK_OFF: ProtocolError = { code: 'ADVISORY_CHECK_OFF', message: ADVISORY_CHECK_OFF_MESSAGE };

const REMEDIATION_REQUEST_ERRORS: Record<RemediationRequestRejection, ProtocolError> = {
  UNKNOWN_PACKAGE: { code: 'UNKNOWN_PACKAGE', message: 'This package is not part of the current scan.' },
  NOT_TRANSITIVE_VULNERABILITY: {
    code: 'NO_REMEDIATION_NEEDED',
    message: 'This dependency has no transitive vulnerability that remediation analysis applies to.',
  },
};

function projectCompatibilityFingerprint(project: ResolvedProject, evidenceFingerprint: string): string {
  const fingerprint = computeSourceFingerprint({
    manifestText: project.manifestText,
    lockfileText: project.lockfileText,
    lockfilePath: project.lockfilePath,
    packageManager: project.packageManager,
    importerId: project.importerId,
  });
  // Do not send an absolute lockfile path to the webview. Hashes + topology identity are sufficient correlation.
  return [
    fingerprint.manifestHash,
    fingerprint.lockfileHash ?? 'no-lockfile',
    project.packageManager,
    project.importerId,
    project.lockfileName ?? 'no-lockfile',
    evidenceFingerprint,
  ].join(':');
}

/** The pnpm workspace staged around the reviewed project, or undefined for a single project. */
function readReviewWorkspaceLayout(project: ResolvedProject, signal?: AbortSignal): Promise<PnpmWorkspaceLayout | undefined> {
  if (project.packageManager !== 'pnpm' || project.lockfileText === null) return Promise.resolve(undefined);
  return readPnpmWorkspaceLayout({
    lockfileRoot: project.lockfileRoot,
    importerId: project.importerId,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Workspace files the review resolved against must still match, like the manifest and lockfile. */
async function reviewWorkspaceStillMatches(project: ResolvedProject, fingerprint: string | null | undefined): Promise<boolean> {
  const current = await readReviewWorkspaceLayout(project).catch(() => undefined);
  return (current?.fingerprint ?? null) === (fingerprint ?? null);
}

function resolvedProjectSourceMatches(left: ResolvedProject, right: ResolvedProject): boolean {
  return left.root === right.root &&
    left.manifestText === right.manifestText &&
    left.lockfileText === right.lockfileText &&
    left.lockfilePath === right.lockfilePath &&
    left.registry === right.registry &&
    left.packageManager === right.packageManager &&
    (left.otherPackageManager ?? null) === (right.otherPackageManager ?? null) &&
    left.importerId === right.importerId &&
    JSON.stringify(left.peerPolicy) === JSON.stringify(right.peerPolicy) &&
    JSON.stringify(left.resolvedRegistry) === JSON.stringify(right.resolvedRegistry);
}

function attachTrustedProjectCompatibilityNavigation(input: {
  analysis: ProjectCompatibilityAnalysis;
  packageName: string;
  folder: WorkspaceFolder;
  store?: UpgradeAssistantCoordinatorOptions['storeProjectCompatibilityReferences'];
}): void {
  if (input.store === undefined) return;
  const navigable: Array<{ evidence: ProjectCompatibilityAnalysis['findings'][number]['evidence'][number]; reference: DependencyReference }> = [];
  const MAX_NAVIGABLE_PROJECT_EVIDENCE = 500;
  outer: for (const finding of input.analysis.findings) {
    for (const evidence of finding.evidence) {
      if (evidence.filePath === undefined) continue;
      const kind = evidence.kind === 'package-script'
        ? 'script' as const
        : evidence.kind === 'project-config'
          ? 'config' as const
          : 'import' as const;
      navigable.push({
        evidence,
        reference: {
          filePath: evidence.filePath,
          line: evidence.line ?? 1,
          column: evidence.column ?? 1,
          snippet: evidence.snippet ?? evidence.context ?? evidence.filePath,
          kind,
          ...(evidence.context === undefined ? {} : { context: evidence.context }),
        },
      });
      if (navigable.length >= MAX_NAVIGABLE_PROJECT_EVIDENCE) break outer;
    }
  }
  const usageId = input.store(input.packageName, navigable.map((entry) => entry.reference), input.folder);
  if (usageId === null) return;
  navigable.forEach((entry, referenceIndex) => {
    entry.evidence.usageId = usageId;
    entry.evidence.referenceIndex = referenceIndex;
  });
}

export function compatibilitySummary(analysis: Awaited<ReturnType<typeof analyzeCompatibility>>): string[] {
  const important = analysis.findings.filter((finding) => finding.status !== 'compatible').slice(0, 4);
  return [
    `Result: ${analysis.status}${analysis.completeness === 'partial' ? ' (partial evidence)' : ''}.`,
    ...important.map((finding) => `• ${finding.explanation}`),
    ...(analysis.findings.length > important.length
      ? [`• ${analysis.findings.length - important.length} additional finding(s).`]
      : []),
    ...(analysis.resolverVerification === undefined
      ? []
      : [`Resolver: ${analysis.resolverVerification.explanation}`]),
  ];
}

interface StoredAnalysis {
  id: string;
  /** Original lookup keys: every item is re-validated fresh at confirm time. */
  requests: UpgradeChangeRequest[];
  /** Host-proven selectable targets used when a request differs from row.upgradeTo. */
  publishedTargetsByPackage: ReadonlyMap<string, ReadonlySet<string>>;
  eligibility: EligibleUpgrade;
  /** The disk snapshot preflight ran against: the baseline the post-confirm recheck below compares fresh disk reads to. */
  snapshot: ResolvedProject;
  proposal: UpgradeProposal;
  compatibilityStatus: CompatibilityStatus;
  /** Set only when planSmartUpgrade found a validated coordinated plan: the only proposal `handleUseSmartPlan` is ever allowed to execute. */
  smartPlanProposal: UpgradeProposal | null;
  security: SecurityOutcome | null;
  ignoreScripts: boolean;
  verificationScripts: VerificationScript[];
  /** Offered as one-run opt-ins only when `verificationScripts` is empty. */
  suggestedScriptNames: string[];
  /** Source/config evidence consumed by project compatibility, re-read before execution. */
  projectCompatibilityEvidenceFingerprint: string | null;
  /** Hash of the pnpm workspace files staged for the resolver, null for a single project. */
  workspaceLayoutFingerprint: string | null;
  expiresAt: number;
}

/** Same shape/lifecycle discipline as StoredAnalysis, minus everything specific to compatibility preflight/smart-plan: a removal has neither. */
interface StoredRemoval {
  id: string;
  requests: RemoveMessage[];
  /** The first, host-validated removal: the session's reserve/release key, same convention as StoredAnalysis.eligibility. */
  eligibility: EligibleRemoval | null;
  eligibilities: EligibleRemoval[];
  reservationKey: string;
  snapshot: ResolvedProject;
  ignoreScripts: boolean;
  verificationScripts: VerificationScript[];
  /** Offered as one-run opt-ins only when `verificationScripts` is empty. */
  suggestedScriptNames: string[];
  /** Present only for Smart Cleanup. Generic removal reviews remain unchanged. */
  smartCleanupEvidence?: SmartCleanupRemovalEvidence;
  /** Client correlation only. Never mutation authority. */
  smartCleanupRequestId?: string;
  /** Host-owned baseline for the correlated completion report. */
  smartCleanupBefore?: SmartCleanupBeforeSnapshot;
  expiresAt: number;
}

/** A kept Smart Cleanup run's restore point. Single use, and held only in memory. */
interface StoredSmartCleanupRestore {
  analysisId: string;
  projectId: string;
  projectRoot: string;
  packageManager: 'npm' | 'pnpm';
  ignoreScripts: boolean;
  packages: string[];
  reservationKey: string;
  adapter: UpgradeTransactionFileAdapter;
  files: SmartCleanupRestoreFile[];
}

interface SmartCleanupRemovalContext {
  evidence?: SmartCleanupRemovalEvidence;
  requestId: string;
  removalRequestId?: string;
}

interface PendingRemovalAnalysis {
  packageName: string;
  smartCleanupRequestId?: string;
  cancelled: boolean;
  reservationHeld: boolean;
  releaseStarted: boolean;
}

interface SharedRemediationWork {
  performance?: PerformanceRecorder;
}

interface StoredRemediationPlan {
  id: string;
  packageName: string;
  snapshot: ResolvedProject;
  before: RemediationGraphSnapshot;
  targetAdvisories: AttributedAdvisory[];
  proposedLockfileText: string;
  packageManagerVersion: string | null;
  ignoreScripts: boolean;
  verificationScripts: VerificationScript[];
  /** Offered as one-run opt-ins only when `verificationScripts` is empty. */
  suggestedScriptNames: string[];
  plan: TransitiveRemediationPlan;
  presentation: TransitiveRemediationPlanSummary;
  expiresAt: number;
  stale: boolean;
}

interface PreparedRemediationWork {
  project: ResolvedProject;
  materialized: Extract<Awaited<ReturnType<IsolatedResolverVerifier['materializeTransitiveRemediation']>>, { ok: true }>;
  before: RemediationGraphSnapshot;
  after: RemediationGraphSnapshot;
  packageManagerVersion: string | null;
}

function verifiedDeprecatedPackagesAfter(
  before: SmartCleanupBeforeSnapshot,
  after: SmartCleanupFinalRefreshEvidence
): readonly string[] | undefined {
  const deprecatedPackages = before.deprecatedDirectPackages;
  const installedVersions = before.deprecationInstalledVersions;
  if (deprecatedPackages === undefined || installedVersions === undefined) return undefined;

  const afterNames = new Set<string>();
  for (const row of after.snapshot.rows) {
    if (row.current === null || installedVersions[row.name] !== row.current) return undefined;
    afterNames.add(row.name);
  }
  return deprecatedPackages.filter((name) => afterNames.has(name));
}

function toSmartCleanupCompletionPresentation(
  result: SmartCleanupCompletionReportResult,
  before: SmartCleanupBeforeSnapshot,
  after: SmartCleanupFinalRefreshEvidence
): SmartCleanupCompletionPresentation {
  const metrics: SmartCleanupCompletionPresentation['metrics'] = [];
  const addMetric = (
    id: SmartCleanupCompletionPresentation['metrics'][number]['id'],
    label: string,
    metric: SmartCleanupCompletionReportResult['report']['metrics'][keyof SmartCleanupCompletionReportResult['report']['metrics']],
    detail: string
  ): void => {
    if (metric.status === 'verified') metrics.push({ id, label, before: metric.before, after: metric.after, detail });
  };
  addMetric('dependencies', 'Direct dependencies', result.report.metrics.directDependencies, 'Measured from the correlated dependency inventory');
  addMetric('deprecated-dependencies', 'Deprecated direct dependencies', result.report.metrics.deprecatedDirectDependencies, 'Exact installed-version metadata');
  if (result.security !== null) {
    metrics.push({
      id: 'vulnerable-dependencies',
      label: 'Vulnerable direct dependencies',
      before: result.security.before.affectedDirectDependencies,
      after: result.security.after.affectedDirectDependencies,
      detail: 'Matches the dashboard Vulnerable Dependencies count',
    });
  }
  addMetric('advisory-findings', 'Advisory findings', result.report.metrics.vulnerabilities, 'Distinct advisory records across the installed graph');

  const advisory = (finding: NonNullable<SmartCleanupCompletionReportResult['security']>['removedAdvisories'][number]) => ({
    sourceId: finding.sourceId,
    identifiers: [...finding.identifiers],
    flaggedPackage: finding.flaggedPackage,
    severity: finding.severity,
    title: finding.title,
  });
  return {
    status: result.status,
    metrics,
    removedAdvisories: result.security?.removedAdvisories.map(advisory) ?? [],
    introducedAdvisories: result.security?.introducedAdvisories.map(advisory) ?? [],
    completedActionIds: result.report.actions.filter((action) => action.status === 'completed').map((action) => action.actionId),
    skippedActionIds: result.report.actions.filter((action) => action.status === 'skipped').map((action) => action.actionId),
    failedActionIds: result.report.actions.filter((action) => action.status === 'failed').map((action) => action.actionId),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

export class UpgradeAssistantCoordinator {
  private readonly session: UpgradeExecutionSession;
  private readonly reservation: OperationReservation;
  /** Advanced synchronously by host watcher/HEAD notifications. */
  private readonly sourceGeneration = new SourceGenerationGuard();
  private readonly projectLoader: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
  private readonly withCompatibilityProgress: <T>(title: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  private readonly getUpgradeConfiguration: () => { ignoreScripts: boolean; verificationScripts: unknown[] };
  private analysis: StoredAnalysis | undefined;
  private removal: StoredRemoval | undefined;
  private smartCleanupRestore: StoredSmartCleanupRestore | undefined;
  /** Why the last restore point was dropped, so a late Restore click gets the matching message. */
  private smartCleanupRestoreDropped:
    | { analysisId: string; reservationKey: string; reason: 'changed' | 'superseded' }
    | undefined;
  /** Registered before controller lookup so `cancel-remove { analysisId: null }` also cancels that initial async gap. */
  private pendingRemovalAnalysis: PendingRemovalAnalysis | undefined;
  /** The package a handleAnalyzeUpgrade call is currently in flight for, or null: the target `cancel-upgrade { analysisId: null }` refers to, since no analysisId exists yet at that point. */
  private pendingAnalyzePackage: string | null = null;
  /** Set by a cancel-upgrade with `analysisId: null` that arrived mid-analysis: handleAnalyzeUpgrade checks this right before storing/posting its result and drops it instead. */
  private cancelRequestedFor: string | null = null;
  /**
   * Host source invalidation is terminal for the webview, unlike its own
   * quiet Cancel action. Retain the package through the analysis finally
   * block so a watcher burst posts exactly one terminal message.
   */
  private sourceInvalidatedAnalyzePackage: string | null = null;
  private activeRemediationAbort: AbortController | undefined;
  private activeRemediationAnalysisId: string | undefined;
  private activeRemediationPackage: string | undefined;
  /** Opaque, host-owned lockfile plans. Bounded to one current plan per direct dependency. */
  private readonly remediationPlans = new Map<string, StoredRemediationPlan>();
  private readonly remediationPlanByPackage = new Map<string, string>();
  private activeUpgradeAnalysisAbort: AbortController | undefined;
  private activeUpgradeAdvisoryAbort: AbortController | undefined;
  private advisorySettingsGeneration = 0;
  /** One exact deep inventory is enough to make immediate re-analysis/cache reuse cheap without retaining many large file lists. */
  private readonly targetPackageSurfaceCache = new TargetPackageSurfaceCache();

  /** Identity in the process-wide project lock registry. */
  private readonly mutationOwner = {};
  private readonly mutationLocks: ProjectMutationLocks;
  /** Canonical root this coordinator's current reservation holds in the shared registry. */
  private heldMutationRootKey: string | undefined;
  private canonicalRootCache: { root: string; key: string } | undefined;
  private readonly stopListeningForSharedRelease: () => void;

  constructor(private readonly options: UpgradeAssistantCoordinatorOptions) {
    this.session = new UpgradeExecutionSession(options.platform);
    this.mutationLocks = options.mutationLocks ?? projectMutationLocks;
    this.reservation = new OperationReservation({
      reserve: (packageName) => this.session.reserve(packageName),
      release: (packageName) => {
        this.session.release(packageName);
        this.releaseSharedMutationRoot();
      },
      flushDeferredChanges: () => options.flushDeferredChanges(),
      resumePendingBackground: () => options.onMutationLockReleased?.(),
      isDisposed: () => options.isDisposed(),
      dispose: () => this.session.dispose(),
    });
    this.projectLoader = options.loadProject ?? ((candidate) => loadProject(options.platform, candidate));
    this.withCompatibilityProgress = options.withCompatibilityProgress ??
      ((title, run) => defaultWithCompatibilityProgress(options.platform, title, run));
    this.getUpgradeConfiguration = options.getUpgradeConfiguration ??
      (() => defaultGetUpgradeConfiguration(options.platform));
    // A change another panel started in this project may finish while this
    // panel is open. Watcher events deferred meanwhile are applied then.
    this.stopListeningForSharedRelease = this.mutationLocks.onDidRelease((key, owner) => {
      if (this.options.isDisposed()) {
        this.stopListeningForSharedRelease();
        return;
      }
      // This coordinator's own release already flushes through OperationReservation.
      if (owner === this.mutationOwner || key !== this.currentMutationRootKey() || this.reservation.isMutationBusy) return;
      void this.options.flushDeferredChanges()
        .catch(() => {})
        .then(() => this.options.onMutationLockReleased?.());
    });
  }

  isBusy(): boolean {
    return this.session.isBusy() || this.projectChangedElsewhere();
  }

  /** File reloads defer only while a package-manager transaction can write. */
  isMutationBusy(): boolean {
    return this.reservation.isMutationBusy || this.projectChangedElsewhere();
  }

  /** Another coordinator, such as one from a panel closed mid-install, holds this project's lock. */
  private projectChangedElsewhere(): boolean {
    const key = this.currentMutationRootKey();
    return key !== undefined && this.mutationLocks.isHeldByOther(key, this.mutationOwner);
  }

  private currentMutationRootKey(): string | undefined {
    const selected = this.options.getSelectedProject();
    const folderPath = selected?.folder?.path;
    const root = this.options.mutationRoot?.() ??
      (selected === undefined || typeof folderPath !== 'string' ? undefined : path.join(folderPath, selected.dir ?? ''));
    if (root === undefined) return undefined;
    if (this.canonicalRootCache?.root !== root) {
      this.canonicalRootCache = { root, key: canonicalProjectRoot(root) };
    }
    return this.canonicalRootCache.key;
  }

  private releaseSharedMutationRoot(): void {
    const key = this.heldMutationRootKey;
    if (key === undefined) return;
    this.heldMutationRootKey = undefined;
    this.mutationLocks.release(key, this.mutationOwner);
  }

  isRemediationBusy(): boolean {
    return this.activeRemediationAbort !== undefined;
  }

  /** Dispose immediately only when no mutation is in flight. */
  disposeWhenIdle(): void {
    this.activeRemediationAbort?.abort();
    this.activeUpgradeAnalysisAbort?.abort();
    if (this.reservation.isMutationBusy) return;
    this.analysis = undefined;
    this.removal = undefined;
    this.discardSmartCleanupRestorePoint();
    this.remediationPlans.clear();
    this.remediationPlanByPackage.clear();
    void this.reservation
      .releaseCurrent()
      .then((released) => {
        if (!released) this.reservation.disposeIfIdle();
      })
      .catch(() => {});
  }

  private reserve(packageName: string): boolean {
    // Any new analysis or dependency change supersedes a kept cleanup's restore point.
    this.dropSmartCleanupRestorePoint('superseded');
    const key = this.currentMutationRootKey();
    // The shared project lock is taken with the reservation and held until the
    // reservation's single release path, after install, verification, and rollback.
    if (key !== undefined && this.mutationLocks.tryAcquire(key, this.mutationOwner) === null) return false;
    if (!this.reservation.reserve(packageName)) {
      if (key !== undefined && this.heldMutationRootKey !== key) this.mutationLocks.release(key, this.mutationOwner);
      return false;
    }
    this.heldMutationRootKey = key;
    return true;
  }

  /** Drops a kept Smart Cleanup restore point. Called for a new analysis, a project switch, or panel teardown. */
  discardSmartCleanupRestorePoint(): void {
    this.dropSmartCleanupRestorePoint('superseded');
  }

  private dropSmartCleanupRestorePoint(reason: 'changed' | 'superseded'): void {
    const stored = this.smartCleanupRestore;
    if (stored === undefined) return;
    this.smartCleanupRestore = undefined;
    this.smartCleanupRestoreDropped = { analysisId: stored.analysisId, reservationKey: stored.reservationKey, reason };
  }

  /**
   * Watcher events also arrive for the cleanup's own writes, so only a
   * content difference from the bytes the cleanup left drops the restore point.
   */
  private async checkSmartCleanupRestorePoint(): Promise<void> {
    const stored = this.smartCleanupRestore;
    if (stored === undefined) return;
    const matches = await smartCleanupRestoreFilesMatchDisk(stored.adapter, stored.files);
    if (matches === false && this.smartCleanupRestore === stored) this.dropSmartCleanupRestorePoint('changed');
  }

  /**
   * Restore the dependency files a kept Smart Cleanup run captured, then
   * reinstall from the restored lockfile the same way a failed transitive fix
   * is rolled back. The compare-and-swap guard refuses any file edited since.
   */
  async handleRestoreSmartCleanup(message: { analysisId: string }): Promise<void> {
    const stored = this.smartCleanupRestore;
    if (stored === undefined || stored.analysisId !== message.analysisId) {
      const dropped = this.smartCleanupRestoreDropped?.analysisId === message.analysisId
        ? this.smartCleanupRestoreDropped
        : undefined;
      this.options.sink.postMessage({
        status: 'remove-error',
        package: dropped?.reservationKey ?? stored?.reservationKey ?? 'Smart Cleanup',
        error: dropped?.reason === 'changed'
          ? { code: 'RESTORE_CONFLICT', message: SMART_CLEANUP_RESTORE_MESSAGES.conflict }
          : { code: 'RESTORE_UNAVAILABLE', message: SMART_CLEANUP_RESTORE_MESSAGES.unavailable },
      });
      return;
    }
    // Single use, whatever the outcome.
    this.smartCleanupRestore = undefined;
    this.smartCleanupRestoreDropped = undefined;
    if (!this.reserve(stored.reservationKey)) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored.reservationKey,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency change is already in progress for this project.' },
      });
      return;
    }
    try {
      if (this.options.getSelectedProject()?.id !== stored.projectId) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: { code: 'RESTORE_UNAVAILABLE', message: SMART_CLEANUP_RESTORE_MESSAGES.unavailable },
        });
        return;
      }
      const controller = await this.options.ensureController();
      const refusal = controller === undefined ? null : dependencyChangeRefusal(controller.upgradeSource);
      if (refusal !== null) {
        this.options.sink.postMessage({ status: 'remove-error', package: stored.reservationKey, error: refusal });
        return;
      }
      if (!this.reservation.beginMutation(stored.reservationKey)) return;
      const restored = await restoreSmartCleanupFiles(stored.adapter, stored.files);
      if (restored.status !== 'restored') {
        if (restored.wrote && !this.options.isDisposed()) await this.options.reloadFinalState();
        if (this.options.isDisposed()) return;
        const detail = restored.wrote
          ? `${SMART_CLEANUP_RESTORE_MESSAGES.interrupted}${restored.recovered ? '' : ` ${SMART_CLEANUP_RESTORE_MESSAGES.unrecovered}`}`
          : restored.status === 'conflict'
            ? SMART_CLEANUP_RESTORE_MESSAGES.conflict
            : `${restored.message} ${SMART_CLEANUP_RESTORE_MESSAGES.unrecovered}`;
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: { code: restored.status === 'conflict' ? 'RESTORE_CONFLICT' : 'RESTORE_FAILED', message: detail },
        });
        this.options.platform.showWarningMessage(detail);
        return;
      }

      const prepared = this.session.prepareLockfileReconciliation({
        cwd: stored.projectRoot,
        ignoreScripts: stored.ignoreScripts,
        packageManager: stored.packageManager,
        taskTitle: SMART_CLEANUP_RESTORE_TASK_TITLE,
      });
      const reinstalled = prepared.ok ? await prepared.execute() : prepared;
      if (!this.options.isDisposed()) await this.options.reloadFinalState();
      if (this.options.isDisposed()) return;
      if (!reinstalled.ok) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: { code: 'RESTORE_INSTALL_FAILED', message: SMART_CLEANUP_RESTORE_MESSAGES.installFailed },
        });
        this.options.platform.showWarningMessage(SMART_CLEANUP_RESTORE_MESSAGES.installFailed);
        return;
      }
      this.options.sink.postMessage({
        status: 'remove-result',
        result: {
          analysisId: stored.analysisId,
          packages: stored.packages,
          outcome: 'rolled-back',
          verification: 'not-run',
          rollback: 'succeeded',
          message: SMART_CLEANUP_RESTORE_MESSAGES.restored,
        },
      });
      this.options.platform.showInformationMessage(SMART_CLEANUP_RESTORE_MESSAGES.restored);
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: toProtocolError(cause),
        });
      }
    } finally {
      await this.releaseReservation(stored.reservationKey);
    }
  }

  /**
   * The single release path for cancellation, failures, TTL reclamation,
   * controller-unavailable exits, and mutation completion. The reservation
   * is cleared synchronously. Host follow-up work is failure-contained so a
   * rejected reload can neither become unhandled nor poison later releases.
   */
  private async releaseReservation(packageName: string): Promise<void> {
    await this.reservation.release(packageName);
  }

  /**
   * A webview remount loses its React-side analysis ids. Drop any read-only
   * work it can no longer confirm or cancel, while allowing a real package-
   * manager transaction to finish at its existing stable boundary.
   */
  async handleWebviewReady(): Promise<void> {
    if (this.reservation.isMutationBusy) return;

    if (this.pendingAnalyzePackage !== null) {
      this.cancelRequestedFor = this.pendingAnalyzePackage;
      this.activeUpgradeAnalysisAbort?.abort();
    }

    const pendingRemoval = this.pendingRemovalAnalysis;
    if (pendingRemoval !== undefined) {
      pendingRemoval.cancelled = true;
      if (pendingRemoval.reservationHeld) pendingRemoval.releaseStarted = true;
      this.pendingRemovalAnalysis = undefined;
    }

    this.activeRemediationAbort?.abort();
    this.analysis = undefined;
    this.removal = undefined;
    this.discardSmartCleanupRestorePoint();
    this.remediationPlans.clear();
    this.remediationPlanByPackage.clear();
    await this.reservation.releaseReadOnlyCurrent();
  }

  /**
   * Called synchronously for watched source/dependency changes and genuine
   * HEAD changes. Advance the execution race guard immediately, but a completed
   * upgrade review is revoked only after its consumed contents differ. Watchers
   * can report identical saves, dev-tool writes, or changes outside that evidence.
   * A transaction inside its mutation boundary remains the sole deferral owner.
   */
  handleProjectSourceChanged(): void {
    this.sourceGeneration.advance();
    if (this.reservation.isMutationBusy) return;
    void this.checkSmartCleanupRestorePoint();


    if (this.pendingAnalyzePackage !== null) {
      const packageName = this.pendingAnalyzePackage;
      const webviewAlreadyCancelled =
        this.cancelRequestedFor === packageName && this.sourceInvalidatedAnalyzePackage !== packageName;
      this.cancelRequestedFor = packageName;
      if (!webviewAlreadyCancelled && this.sourceInvalidatedAnalyzePackage !== packageName) {
        this.sourceInvalidatedAnalyzePackage = packageName;
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed while upgrade analysis was running. Analyze again.',
          },
        });
      }
      this.activeUpgradeAnalysisAbort?.abort();
    }
    // Keep completed upgrade evidence for the debounced content comparison in
    // checkOpenAnalysisFreshness. Confirm still re-reads it and checks the
    // generation before mutation, including during this debounce window.
    if (this.removal !== undefined) {
      const stored = this.removal;
      this.removal = undefined;
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored.reservationKey,
        error: {
          code: 'STALE_SOURCE',
          message: 'Project files changed while the removal review was open. Analyze again.',
        },
      });
      void this.releaseReservation(stored.reservationKey);
    }
  }

  /**
   * Dependency topology/configuration changed. Unlike ordinary source edits,
   * this invalidates exact generated lockfile plans immediately. The stored
   * package/id correlation is retained only so Retry can start a fresh check;
   * stale plans can never reach the mutation boundary.
   */
  handleDependencySourceChanged(): void {
    this.handleProjectSourceChanged();
    if (this.reservation.isMutationBusy) return;
    if (this.activeRemediationAnalysisId === undefined && this.activeRemediationPackage !== undefined) {
      const packageName = this.activeRemediationPackage;
      this.activeRemediationPackage = undefined;
      this.activeRemediationAbort?.abort();
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: packageName,
        error: { code: 'STALE_SOURCE', message: 'Project dependency files changed while this fix was being checked. Check again.' },
      });
    }
    for (const stored of this.remediationPlans.values()) {
      if (stored.stale) continue;
      stored.stale = true;
      this.options.sink.postMessage({
        status: 'remediation-stale',
        package: stored.packageName,
        analysisId: stored.id,
        message: 'Project dependency files changed. Re-check the transitive fix before applying it.',
      });
    }
  }

  /** An abandoned analysis (modal left open, never confirmed or cancelled) reclaims its lock once its TTL passes, so a later analyze request is never permanently blocked by it. */
  private reclaimExpiredAnalysis(): void {
    if (this.analysis !== undefined && Date.now() >= this.analysis.expiresAt) {
      void this.releaseReservation(this.analysis.eligibility.packageName);
      this.analysis = undefined;
    }
  }

  /** Same reclaim as reclaimExpiredAnalysis, for an abandoned removal review. */
  private reclaimExpiredRemoval(): void {
    if (this.removal !== undefined && Date.now() >= this.removal.expiresAt) {
      void this.releaseReservation(this.removal.reservationKey);
      this.removal = undefined;
    }
  }

  /**
   * Checked before every progressive partial post in
   * handleAnalyzeUpgradeRequests: a mid-stream `cancel-upgrade{analysisId:
   * null}` (recorded as `cancelRequestedFor`) or panel disposal should stop
   * further sections from being computed/posted, not merely be discarded at
   * the very end the way a single pre-final check would. Returns true (and,
   * for a real cancellation match, clears `cancelRequestedFor`) exactly when
   * the caller should stop and return without posting.
   */
  private droppedByCancellation(packageName: string): boolean {
    if (this.options.isDisposed()) return true;
    if (this.cancelRequestedFor !== packageName) return false;
    this.cancelRequestedFor = null;
    return true;
  }

  /**
   * Load one package's bounded, host-derived upgrade choices on demand.
   * This is deliberately outside the dashboard's Stage-1 scan: opening the
   * Manage workspace for one dependency is the point at which a full
   * packument becomes useful enough to justify its parse cost.
   */
  async handleLoadUpgradeTargets(message: LoadUpgradeTargetsMessage): Promise<void> {
    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const row = controller.lastResultRows().find((candidate) => candidate.name === message.package);
    if (row === undefined || row.current === null || row.upgradeTo === null) {
      this.options.sink.postMessage({
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: { code: 'NO_ELIGIBLE_UPGRADE', message: 'No upgrade is currently available for this package.' },
      });
      return;
    }

    // Reuse the existing default-target eligibility gate before doing any
    // network work. This proves the package is declared, safe, and backed by
    // a current trusted scan without adding a weaker read-only side door.
    const eligibility = controller.validateUpgradeRequest({ package: row.name, target: row.upgradeTo });
    if (!eligibility.ok) {
      this.options.sink.postMessage({
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: describeBulkRejection({
          ok: false,
          reason: 'change-rejected',
          packageName: message.package,
          changeReason: eligibility.reason,
        }),
      });
      return;
    }

    this.options.sink.postMessage({
      status: 'upgrade-targets-loading',
      package: message.package,
      requestId: message.requestId,
    });
    try {
      const source = controller.upgradeSource;
      const targets = await loadUpgradeTargets(
        this.options.httpClient,
        this.options.etagStore,
        registryForPackage(source.resolvedRegistry, row.name),
        row.name,
        row.current,
        row.upgradeTo,
        undefined,
        row.upgradeReason
      );
      const stillEligible = controller.validateUpgradeRequest({ package: row.name, target: row.upgradeTo });
      if (!stillEligible.ok) {
        this.options.sink.postMessage({
          status: 'upgrade-targets-error',
          package: message.package,
          requestId: message.requestId,
          error: describeBulkRejection({
            ok: false,
            reason: 'change-rejected',
            packageName: message.package,
            changeReason: stillEligible.reason,
          }),
        });
        return;
      }
      this.options.sink.postMessage({
        status: 'upgrade-targets',
        package: message.package,
        requestId: message.requestId,
        targets,
      });
      void controller.enrichUpdateVersions(targets.options.map(option => ({
        name: row.registryName ?? row.name, version: option.version,
      })), this.options.sink);
    } catch (cause) {
      if (this.options.isDisposed()) return;
      this.options.sink.postMessage({
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: toProtocolError(cause),
      });
    }
  }

  private async publishedTargetsFor(
    controller: DashboardController,
    requests: readonly UpgradeChangeRequest[]
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const source = controller.upgradeSource;
    const entries = await Promise.all(
      requests.map(async (request): Promise<readonly [string, ReadonlySet<string>]> => {
        const row = controller.lastResultRows().find((candidate) => candidate.name === request.package);
        if (row === undefined || row.current === null) return [request.package, new Set()];
        const published = await publishedUpgradeTargetsForRequest(
          this.options.httpClient,
          this.options.etagStore,
          registryForPackage(source.resolvedRegistry, row.name),
          row.name,
          row.current,
          row.upgradeTo,
          request.target
        );
        return [row.name, published];
      })
    );
    return new Map(entries);
  }

  private async loadPublisherUpgradeTargets(
    controller: DashboardController,
    requests: readonly UpgradeChangeRequest[],
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    const source = controller.upgradeSource;
    const rowsByName = new Map(controller.lastResultRows().map((row) => [row.name, row]));
    const rows = requests.flatMap((request) => {
      const row = rowsByName.get(request.package);
      return row?.current != null && row.upgradeTo !== null ? [row] : [];
    });
    await runPool(
      rows,
      (row, workerSignal) => fetchDistTags(
        this.options.httpClient,
        this.options.etagStore,
        registryForPackage(source.resolvedRegistry, row.name),
        row.name,
        workerSignal
      ),
      {
        signal,
        onSettled: (row, result) => {
          if (!result.ok || signal.aborted || this.options.isDisposed() || row.current === null) return;
          // Publisher tags describe available choices. The validated request
          // remains the target for both single and bulk analysis.
          this.options.sink.postMessage({
            status: 'upgrade-targets',
            package: row.name,
            requestId,
            targets: selectUpgradeTargetsFromDistTags(result.value, row.current, row.upgradeTo, row.upgradeReason),
          });
        },
      }
    );
  }

  /**
   * Analysis phase: eligibility, lock, preflight, smart-plan search, security
   * outcome. Ends by storing the analysis and posting it, never by
   * executing anything.
   */
  async handleAnalyzeUpgrade(message: UpgradeMessage): Promise<void> {
    await this.handleAnalyzeUpgradeRequests(message.requestId, [{ package: message.package, target: message.target }]);
  }

  async handleAnalyzeBulkUpgrade(message: BulkUpgradeMessage): Promise<void> {
    await this.handleAnalyzeUpgradeRequests(message.requestId, message.changes);
  }

  private async handleAnalyzeUpgradeRequests(
    requestId: string,
    messages: readonly UpgradeChangeRequest[]
  ): Promise<void> {
    this.reclaimExpiredAnalysis();
    this.reclaimExpiredRemoval();

    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: messages[0]?.package ?? 'unknown',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Wait for remediation analysis to finish before upgrading.' },
      });
      return;
    }

    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const refusal = dependencyChangeRefusal(controller.upgradeSource);
    if (refusal !== null) {
      this.options.sink.postMessage({ status: 'upgrade-error', package: messages[0]?.package ?? 'unknown', error: refusal });
      return;
    }

    let publishedTargetsByPackage: ReadonlyMap<string, ReadonlySet<string>> = new Map();
    let batch = controller.validateBulkUpgradeRequest(messages);
    if (!batch.ok && batch.reason === 'change-rejected' && batch.changeReason === 'stale-target') {
      try {
        publishedTargetsByPackage = await this.publishedTargetsFor(controller, messages);
      } catch (cause) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: batch.packageName ?? messages[0]?.package ?? 'unknown',
          error: toProtocolError(cause),
        });
        return;
      }
      batch = controller.validateBulkUpgradeRequest(messages, publishedTargetsByPackage);
    }
    if (!batch.ok) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: batch.packageName ?? messages[0]?.package ?? 'unknown',
        error: describeBulkRejection(batch),
      });
      return;
    }
    const initialEligibility = batch.upgrades[0];
    if (initialEligibility === undefined) return;
    const eligibility: EligibleUpgrade = initialEligibility;
    const eligibilities = batch.upgrades;
    const effectiveMessages = messages;

    // Reserve across preflight and however long the analysis modal stays
    // open, not merely process execution: forged requests cannot stack
    // analyses or race package managers, and only one package can be under
    // analysis for the whole panel at a time.
    if (!this.reserve(eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: eligibility.packageName,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
      });
      return;
    }
    this.pendingAnalyzePackage = eligibility.packageName;
    const analysisAbort = new AbortController();
    this.activeUpgradeAnalysisAbort = analysisAbort;
    let advisoryAbort = new AbortController();
    this.activeUpgradeAdvisoryAbort = advisoryAbort;
    const abortAdvisories = (): void => advisoryAbort.abort();
    analysisAbort.signal.addEventListener('abort', abortAdvisories, { once: true });
    const pendingAnalysisWork: Promise<unknown>[] = [];
    const startSecurityCheck = () => {
      if (advisoryAbort.signal.aborted && !analysisAbort.signal.aborted) {
        advisoryAbort = new AbortController();
        this.activeUpgradeAdvisoryAbort = advisoryAbort;
      }
      return { generation: this.advisorySettingsGeneration,
        enabled: this.publicAdvisoryCheckEnabled(controller.root) };
    };

    // Tracks whether the full review completed for performance reporting;
    // the read-only reservation is released in `finally` on every path.
    let succeeded = false;
    const performance = createPerformanceSession(
      'Packageawy upgrade analysis',
      this.options.performanceEnabled?.() ?? false
    );
    try {
      await this.loadPublisherUpgradeTargets(controller, effectiveMessages, requestId, analysisAbort.signal);
      if (analysisAbort.signal.aborted || this.droppedByCancellation(eligibility.packageName)) return;
      performance.setMetadata('changes', eligibilities.length);
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const source = controller.upgradeSource;
      const endProjectLoad = performance.start('action project reload');
      const preflightProject = await this.projectLoader(selected);
      endProjectLoad();
      if (
        preflightProject.root !== controller.root ||
        preflightProject.manifestText !== source.manifestText ||
        preflightProject.lockfileText !== source.lockfileText ||
        preflightProject.lockfilePath !== source.lockfilePath ||
        preflightProject.registry !== source.registry ||
        preflightProject.packageManager !== source.packageManager ||
        preflightProject.importerId !== source.importerId
      ) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
        });
        return;
      }

      // --- Stage 0: overview: everything below is synchronous/cheap, no
      // network or resolver work, so it can post immediately. ---
      const upgradeConfiguration = this.getUpgradeConfiguration();
      const verificationScripts = selectVerificationScripts(source.manifestText, upgradeConfiguration.verificationScripts);
      const suggestedScriptNames = verificationSuggestionsFor(source.manifestText, verificationScripts);

      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');

      const overviewChanges = buildUpgradeAnalysisChanges({
        packageName: eligibility.packageName,
        currentVersion: eligibility.currentVersion,
        targetVersion: eligibility.target,
        classification: eligibility.classification,
        changes: eligibilities.map((item) => ({
          packageName: item.packageName,
          currentVersion: item.currentVersion,
          targetVersion: item.target,
          classification: item.classification,
        })),
      });

      if (this.droppedByCancellation(eligibility.packageName)) return;
      this.options.sink.postMessage({
        status: 'upgrade-analysis-partial',
        requestId,
        package: eligibility.packageName,
        section: {
          kind: 'overview',
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
          majorUpdate: isMajorUpgrade(eligibility.currentVersion, eligibility.target),
          changes: overviewChanges,
          verification: buildUpgradeAnalysisVerification(
            verificationScripts.map((script) => script.scriptName),
            suggestedScriptNames
          ),
          files: buildUpgradeAnalysisFiles(manifestPath, expectedLockfilePath),
        },
      });

      // Project source collection starts beside dependency-tree preflight so
      // neither blocks the other's first useful result. A scan failure is
      // represented as partial evidence later. It never fails Upgrade Review.
      const manifestProjectEvidence = parseProjectManifestCompatibilityEvidence(preflightProject.manifestText);
      const projectEvidencePromise = collectProjectCompatibilityEvidence({
        platform: this.options.platform,
        folder: selected.folder,
        dir: selected.dir,
        manifestText: preflightProject.manifestText,
        packageName: eligibility.packageName,
        signal: analysisAbort.signal,
      }).catch(() => ({
        ...manifestProjectEvidence,
        imports: [],
        ruleFiles: [],
        scannedFileCount: 0,
        truncated: true,
        evidenceFingerprint: 'unavailable',
      }));
      this.options.sink.postMessage({
        status: 'upgrade-analyzing',
        package: eligibility.packageName,
        phase: 'project-compatibility',
        requestId,
      });

      const proposal: UpgradeProposal = {
        requested: {
          packageName: eligibility.packageName,
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
        },
        changes: eligibilities.map((item) => ({
          packageName: item.packageName,
          currentVersion: item.currentVersion,
          targetVersion: item.target,
          classification: item.classification,
        })),
      };
      const endGraph = performance.start('action graph rebuild');
      const manifest = parseManifest(preflightProject.manifestText);
      const graph = buildDependencyGraph({
        root: preflightProject.root,
        manifest,
        lockfileText: preflightProject.lockfileText,
        packageManager: preflightProject.packageManager,
        importerId: preflightProject.importerId,
      });
      endGraph({ nodes: graph.nodes.size });
      const endToolchain = performance.start('package-manager resolution');
      const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
      const packageManagerInvocation =
        preflightProject.packageManager === 'pnpm'
          ? resolveInstalledPnpmInvocation(npmResolution.ok ? npmResolution.invocation : null, controller.root)
          : npmResolution.ok
            ? {
                executable: npmResolution.invocation.node,
                prefixArgs: [npmResolution.invocation.npmCliJs],
                version: npmResolution.invocation.version,
              }
            : null;
      endToolchain({ available: packageManagerInvocation !== null });
      const workspaceLayout = await readReviewWorkspaceLayout(preflightProject, analysisAbort.signal);
      if (analysisAbort.signal.aborted) return;
      const resolverVerifier = packageManagerInvocation !== null
        ? new IsolatedResolverVerifier({
            // Bound each isolated Upgrade Review resolver step, not the user's
            // confirmed installation. A timeout remains unverified evidence.
            runner: new NodeResolverProcessRunner({ timeoutMs: 120_000 }),
            retainResolvedGraph: this.publicAdvisoryCheckEnabled(controller.root),
            packageManager: preflightProject.packageManager,
            packageManagerVersion: packageManagerInvocation.version ?? null,
            invocation: packageManagerInvocation,
            manifestText: preflightProject.manifestText,
            ...(preflightProject.lockfileText === null || preflightProject.lockfileName === null
              ? {}
              : {
                  lockfile: {
                    name: preflightProject.lockfileName,
                    text: preflightProject.lockfileText,
                  },
                }),
            registry: preflightProject.registry,
            resolvedRegistry: preflightProject.resolvedRegistry,
            policy: preflightProject.peerPolicy,
            ...(workspaceLayout === undefined ? {} : { workspace: workspaceLayout }),
          })
        : undefined;
      const metadataProvider = new RegistryPackageMetadataProvider(
        this.options.httpClient,
        this.options.etagStore,
        preflightProject.resolvedRegistry
      );

      this.options.sink.postMessage({ status: 'upgrade-analyzing', package: eligibility.packageName, phase: 'compatibility', requestId });
      const endCompatibility = performance.start('compatibility preflight');
      const compatibilityTitle =
        eligibilities.length === 1
          ? `Checking compatibility for ${eligibility.packageName}@${eligibility.target}`
          : `Checking compatibility for ${eligibilities.length} dependency upgrades`;
      const compatibilityResultPromise = this.withCompatibilityProgress(compatibilityTitle, async (signal) => {
        const combined = new AbortController();
        const abort = (): void => combined.abort();
        signal.addEventListener('abort', abort, { once: true });
        analysisAbort.signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted || analysisAbort.signal.aborted) combined.abort();
        try {
          return await analyzeCompatibility({
            graph,
            proposal,
            metadataProvider,
            policy: preflightProject.peerPolicy,
            ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
            signal: combined.signal,
          });
        } finally {
          signal.removeEventListener('abort', abort);
          analysisAbort.signal.removeEventListener('abort', abort);
        }
      }
      ).then(
        (analysis) => {
          endCompatibility({ status: analysis.status });
          if (!analysisAbort.signal.aborted && !this.droppedByCancellation(eligibility.packageName)) {
            this.options.sink.postMessage({
              status: 'upgrade-analysis-partial', requestId, package: eligibility.packageName,
              section: { kind: 'compatibility', compatibility: {
                status: analysis.status, completeness: analysis.completeness, findings: analysis.findings,
                ...(analysis.resolverVerification === undefined ? {} : { resolverVerification: analysis.resolverVerification }),
              } },
            });
          }
          return { ok: true as const, analysis };
        },
        (cause: unknown) => { endCompatibility({ completed: false }); return { ok: false as const, cause }; }
      );
      pendingAnalysisWork.push(compatibilityResultPromise);

      // Chain directly from compatibility completion: its resolver verify
      // and temp-dir cleanup have settled before this callback runs, while
      // project evidence/metadata work below may still be in flight.
      const initialSecuritySettings = startSecurityCheck();
      const securityGraphPromise = compatibilityResultPromise.then(async (compatibilityResult) => {
        if (
          !compatibilityResult.ok ||
          !this.publicAdvisoryCheckEnabled(controller.root) ||
          compatibilityResult.analysis.status === 'conflict' ||
          resolverVerifier === undefined
        ) return undefined;
        const endSecurityResolver = performance.start('security graph materialization');
        const proposedGraph = await materializeUpgradeSecurityGraph({
          compatibilityStatus: compatibilityResult.analysis.status,
          proposal,
          materializer: resolverVerifier,
          signal: analysisAbort.signal,
        });
        endSecurityResolver({ resolved: proposedGraph !== undefined });
        return proposedGraph;
      });

      pendingAnalysisWork.push(securityGraphPromise);
      // Security is published when its graph is ready, not after package inventory.
      const securityResultPromise = securityGraphPromise.then(async (proposedSecurityGraph): Promise<SecurityOutcome> => {
        const security = await auditUpgradeReview({
          before: graph, after: proposedSecurityGraph, proposal, client: this.options.httpClient,
          enabled: () => this.publicAdvisoryCheckEnabled(controller.root), signal: advisoryAbort.signal,
        });
        if (!analysisAbort.signal.aborted && !this.droppedByCancellation(eligibility.packageName)) {
          this.options.sink.postMessage({
            status: 'upgrade-analysis-partial', requestId, package: eligibility.packageName,
            section: { kind: 'security', security },
          });
        }
        return security;
      }).then(
        (security) => ({ ok: true as const, security }),
        (cause: unknown) => ({ ok: false as const, cause })
      );
      pendingAnalysisWork.push(securityResultPromise);

      // The workflow owns local/metadata stages. Only an uncached npm pack waits
      // for the resolver lane. Cached evidence never waits on a subprocess.
      const packageRegistry = registryForPackage(preflightProject.resolvedRegistry, eligibility.packageName);
      const projectResultPromise = runProjectCompatibilityWorkflow({
        identity: { packageName: eligibility.packageName, currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target, requestId },
        sourceFingerprint: (fingerprint) => projectCompatibilityFingerprint(preflightProject, fingerprint),
        manifest: manifestProjectEvidence, evidence: projectEvidencePromise, graph, metadataProvider,
        registry: packageRegistry, surfaceCache: this.targetPackageSurfaceCache,
        ...(npmResolution.ok ? { inspect: (packageName: string, version: string, signal: AbortSignal) => new TargetPackageInspector({
          executable: npmResolution.invocation.node, prefixArgs: [npmResolution.invocation.npmCliJs],
          version: npmResolution.invocation.version,
        }, packageRegistry).inspect(packageName, version, signal) } : {}),
        packageManagerIdle: securityGraphPromise, performance, signal: analysisAbort.signal,
        onResult: (projectCompatibility) => {
          if (analysisAbort.signal.aborted || this.droppedByCancellation(eligibility.packageName)) return;
          attachTrustedProjectCompatibilityNavigation({
            analysis: projectCompatibility, packageName: eligibility.packageName, folder: selected.folder,
            store: this.options.storeProjectCompatibilityReferences,
          });
          this.options.sink.postMessage({
            status: 'upgrade-analysis-partial', requestId, package: eligibility.packageName,
            section: { kind: 'project-compatibility', projectCompatibility },
          });
        },
      }).then(
        (result) => ({ ok: true as const, result }),
        (cause: unknown) => ({ ok: false as const, cause })
      );
      pendingAnalysisWork.push(projectResultPromise);
      const compatibilityResult = await compatibilityResultPromise;
      if (!compatibilityResult.ok) throw compatibilityResult.cause;
      const analysis = compatibilityResult.analysis;
      const projectResult = await projectResultPromise;
      if (!projectResult.ok) throw projectResult.cause;
      const { analysis: projectCompatibility, evidence: projectEvidence } = projectResult.result;
      const securityResult = await securityResultPromise;
      if (!securityResult.ok) throw securityResult.cause;
      let security = securityResult.security;
      let securitySettings = initialSecuritySettings;
      if (this.droppedByCancellation(eligibility.packageName)) return;

      let smartPlan: UpgradeAnalysisSmartPlan | null = null;
      let smartPlanProposal: UpgradeProposal | null = null;
      if (analysis.status === 'conflict') {
        const declaredByName = new Map(manifest.dependencies.map((dependency) => [dependency.name, dependency]));
        const upgradeableDirectDependencies = directNodes(graph).flatMap((node) => {
          const declared = declaredByName.get(node.name);
          if (declared === undefined || node.version === null) return [];
          return [{
            packageName: node.name,
            currentVersion: node.version,
            classification: declared.optional ? ('optional' as const) : declared.dev ? ('dev' as const) : ('prod' as const),
          }];
        });
        this.options.sink.postMessage({ status: 'upgrade-analyzing', package: eligibility.packageName, phase: 'smart-plan', requestId });
        const endSmartPlan = performance.start('smart-plan search');
        const planned = await planSmartUpgrade({
          graph,
          signal: analysisAbort.signal,
          initialAnalysis: analysis,
          upgradeableDirectDependencies,
          candidateProvider: {
            getStableVersionCandidates: async (packageName, signal) => {
              const packument = await fetchPackument(
                this.options.httpClient,
                this.options.etagStore,
                registryForPackage(preflightProject.resolvedRegistry, packageName),
                packageName,
                signal
              );
              return { versions: packument.versions, complete: true };
            },
          },
          metadataProvider,
          policy: preflightProject.peerPolicy,
          ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
        });
        endSmartPlan({ outcome: planned.outcome, checks: planned.statistics.compatibilityChecks });
        // A conflict with no coordinated plan is not an error here: the
        // analysis is still shown, honestly, as a conflict with no smart-plan
        // option. The modal offers only Close (see spec's conflict-action
        // rules). Only genuinely offer the option when one was actually found
        // and validated.
        if (planned.outcome === 'found') {
          smartPlanProposal = planned.plan.proposal;
          // The coordinated proposal includes planner-added dependencies and can
          // differ from the first reviewed graph. Audit its executable changes.
          securitySettings = startSecurityCheck();
          const coordinatedGraph = securitySettings.enabled
            ? await materializeUpgradeSecurityGraph({
                compatibilityStatus: 'compatible', proposal: smartPlanProposal,
                materializer: resolverVerifier, signal: analysisAbort.signal,
              }) : undefined;
          security = await auditUpgradeReview({
            before: graph, after: coordinatedGraph, proposal: smartPlanProposal, client: this.options.httpClient,
            enabled: () => this.publicAdvisoryCheckEnabled(controller.root), signal: advisoryAbort.signal,
          });
          if (!analysisAbort.signal.aborted && !this.droppedByCancellation(eligibility.packageName)) {
            this.options.sink.postMessage({
              status: 'upgrade-analysis-partial', requestId, package: eligibility.packageName,
              section: { kind: 'security', security },
            });
          }
          smartPlan = {
            changes: planned.plan.proposal.changes.map((change) => ({
              packageName: change.packageName,
              currentVersion: change.currentVersion,
              targetVersion: change.targetVersion,
            })),
            reasonFindingIds: [...new Set(planned.plan.groups.flatMap((group) => group.reasonFindingIds))],
          };
        }

        if (this.droppedByCancellation(eligibility.packageName)) return;
        this.options.sink.postMessage({
          status: 'upgrade-analysis-partial',
          requestId,
          package: eligibility.packageName,
          section: { kind: 'smart-plan', smartPlan },
        });
      }

      // A cancel-upgrade with `analysisId: null` arrived while the above was
      // in flight: drop the result rather than storing/posting it, and let
      // `finally` release the lock like any other unsuccessful exit. Every
      // partial post above already checked this at the moment its data
      // became ready. This is the last-line defense for the gap between the
      // final partial and final assembly.
      if (this.droppedByCancellation(eligibility.packageName)) return;

      // Source/config files are not part of the dependency lock snapshot, so
      // re-read their bounded evidence once before retaining an actionable
      // review. A change during medium/deep analysis invalidates the result
      // instead of silently attaching findings to an older source state.
      const finalReadGeneration = this.options.projectCompatibilitySourceGeneration?.() ?? 0;
      const [finalProjectEvidence, finalDiskSnapshot] = await Promise.all([
        collectProjectCompatibilityEvidence({
          platform: this.options.platform,
          folder: selected.folder,
          dir: selected.dir,
          manifestText: preflightProject.manifestText,
          packageName: eligibility.packageName,
          signal: analysisAbort.signal,
        }).catch(() => null),
        this.projectLoader(selected).catch(() => null),
      ]);
      // Cancellation during this last read is not a source change and cannot
      // retain a new review after the user has closed it.
      if (analysisAbort.signal.aborted || this.droppedByCancellation(eligibility.packageName)) return;
      if (
        !projectCompatibilityFinalReadIsCurrent({
          generationBeforeRead: finalReadGeneration,
          generationAfterRead: this.options.projectCompatibilitySourceGeneration?.() ?? 0,
          expectedFingerprint: projectEvidence.evidenceFingerprint === 'unavailable'
            ? null
            : projectEvidence.evidenceFingerprint,
          observedFingerprint: finalProjectEvidence?.evidenceFingerprint ?? null,
        }) ||
        finalDiskSnapshot === null ||
        !resolvedProjectSourceMatches(finalDiskSnapshot, preflightProject) ||
        !await reviewWorkspaceStillMatches(finalDiskSnapshot, workspaceLayout?.fingerprint ?? null)
      ) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project source changed during compatibility analysis. Refresh and try again.',
          },
        });
        return;
      }

      // A completed request can outlive its setting. Reconcile the executable
      // proposal after the final reads, before retaining acknowledgement evidence.
      while (securitySettings.generation !== this.advisorySettingsGeneration ||
             securitySettings.enabled !== this.publicAdvisoryCheckEnabled(controller.root)) {
        securitySettings = startSecurityCheck();
        const currentProposal = smartPlanProposal ?? proposal;
        const currentGraph = securitySettings.enabled ? await materializeUpgradeSecurityGraph({
          compatibilityStatus: smartPlanProposal === null ? analysis.status : 'compatible',
          proposal: currentProposal, materializer: resolverVerifier, signal: analysisAbort.signal,
        }) : undefined;
        if (analysisAbort.signal.aborted || this.droppedByCancellation(eligibility.packageName)) return;
        security = await auditUpgradeReview({
          before: graph, after: currentGraph, proposal: currentProposal, client: this.options.httpClient,
          enabled: () => this.publicAdvisoryCheckEnabled(controller.root), signal: advisoryAbort.signal,
        });
        if (analysisAbort.signal.aborted || this.droppedByCancellation(eligibility.packageName)) return;
        if (securitySettings.generation === this.advisorySettingsGeneration &&
            securitySettings.enabled === this.publicAdvisoryCheckEnabled(controller.root)) {
          this.options.sink.postMessage({
            status: 'upgrade-analysis-partial', requestId, package: eligibility.packageName,
            section: { kind: 'security', security },
          });
        }
      }

      const analysisId = randomBytes(16).toString('hex');
      const analyzedAt = new Date().toISOString();
      const expiresAt = Date.now() + UPGRADE_ANALYSIS_RETENTION_MS;
      this.analysis = {
        id: analysisId,
        requests: [...effectiveMessages],
        publishedTargetsByPackage,
        eligibility,
        snapshot: preflightProject,
        proposal,
        compatibilityStatus: analysis.status,
        smartPlanProposal,
        security,
        ignoreScripts: upgradeConfiguration.ignoreScripts,
        verificationScripts,
        suggestedScriptNames,
        projectCompatibilityEvidenceFingerprint:
          projectEvidence.evidenceFingerprint === 'unavailable' ? null : projectEvidence.evidenceFingerprint,
        workspaceLayoutFingerprint: workspaceLayout?.fingerprint ?? null,
        expiresAt,
      };

      this.options.sink.postMessage({
        status: 'upgrade-analysis',
        requestId,
        analysis: buildUpgradeAnalysisPresentation({
          analysisId,
          analyzedAt,
          expiresAt: new Date(expiresAt).toISOString(),
          packageName: eligibility.packageName,
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
          changes: eligibilities.map((item) => ({
            packageName: item.packageName,
            currentVersion: item.currentVersion,
            targetVersion: item.target,
            classification: item.classification,
          })),
          compatibility: {
            status: analysis.status,
            completeness: analysis.completeness,
            findings: analysis.findings,
            ...(analysis.resolverVerification === undefined ? {} : { resolverVerification: analysis.resolverVerification }),
          },
          projectCompatibility,
          security,
          smartPlan,
          verificationScriptNames: verificationScripts.map((script) => script.scriptName),
          suggestedScriptNames,
          manifestPath,
          lockfilePath: expectedLockfilePath,
        }),
      });
      succeeded = true;
      return;
    } catch (cause) {
      if (analysisAbort.signal.aborted) {
        this.droppedByCancellation(eligibility.packageName);
        return;
      }
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error:
            cause instanceof CompatibilityCancelledError
              ? { code: 'CANCELLED', message: 'Compatibility preflight was cancelled.' }
              : toProtocolError(cause),
        });
      }
      return;
    } finally {
      // Retain reservation until every launched stage (including child cleanup)
      // settles. A completed review is cached data, not mutation ownership, so
      // it releases here just like failed/cancelled analysis. Confirmation
      // reacquires the project-wide lock immediately before authoritative
      // revalidation and any package-manager work.
      if (!succeeded) analysisAbort.abort();
      await Promise.allSettled(pendingAnalysisWork);
      await this.releaseReservation(eligibility.packageName);
      if (this.pendingAnalyzePackage === eligibility.packageName) this.pendingAnalyzePackage = null;
      if (this.cancelRequestedFor === eligibility.packageName) this.cancelRequestedFor = null;
      if (this.sourceInvalidatedAnalyzePackage === eligibility.packageName) {
        this.sourceInvalidatedAnalyzePackage = null;
      }
      if (this.activeUpgradeAnalysisAbort === analysisAbort) this.activeUpgradeAnalysisAbort = undefined;
      analysisAbort.signal.removeEventListener('abort', abortAdvisories);
      if (this.activeUpgradeAdvisoryAbort === advisoryAbort) this.activeUpgradeAdvisoryAbort = undefined;
      performance.finish({ completed: succeeded });
    }
  }

  resolveReviewAdvisoryUrl(request: AdvisoryLookupRequest): string | null {
    const security = this.analysis?.security;
    if (security == null) return null;
    return resolveTrustedAttributedAdvisoryUrl([
      ...security.resolvedAdvisories,
      ...[...security.remaining, ...(security.introduced ?? [])].map((entry) => ({
        ...entry, flaggedVersion: entry.resolvedVersion,
      })),
    ], request);
  }

  async handleConfirmUpgrade(message: AnalysisMessage): Promise<void> {
    await this.executeStoredAnalysis(message.analysisId, false, message);
  }

  async handleUseSmartPlan(message: AnalysisMessage): Promise<void> {
    await this.executeStoredAnalysis(message.analysisId, true, message);
  }

  handleCancelUpgrade(message: CancelUpgradeMessage): void {
    if (message.analysisId === null) {
      // No analysis exists yet: mark the in-flight one (if any) so
      // handleAnalyzeUpgrade drops its result instead of storing/posting
      // it. The lock itself is released by that method's `finally`, not
      // here: nothing to release yet if it's still running.
      if (this.pendingAnalyzePackage !== null) {
        this.cancelRequestedFor = this.pendingAnalyzePackage;
        this.activeUpgradeAnalysisAbort?.abort();
      }
      return;
    }
    if (this.analysis === undefined || this.analysis.id !== message.analysisId) return;
    void this.releaseReservation(this.analysis.eligibility.packageName);
    this.analysis = undefined;
  }

  /**
   * Called (debounced, via dashboardPanel.ts's watcher timers) after a
   * manifest/lockfile/configuration or analyzed source change. If an analysis
   * is currently open, re-reads disk with the same projectLoader used by the
   * authoritative STALE_SOURCE recheck and compares against the exact same
   * fields executeStoredAnalysis compares below, never a second, looser
   * definition of "changed." Only a stable content mismatch revokes the stored
   * action and emits the stale hint. The webview keeps the results readable.
   * Raw watcher events and an already-dirty working tree are not evidence of a
   * change since analysis. This never replaces the confirm-time source checks.
   */
  async checkOpenAnalysisFreshness(): Promise<void> {
    const stored = this.analysis;
    if (stored === undefined || this.options.isDisposed()) return;
    const selected = this.options.getSelectedProject();
    if (selected === undefined) return;
    const generation = this.sourceGeneration.capture();
    const isCurrent = (): boolean => this.analysis === stored && !this.options.isDisposed() &&
      this.options.getSelectedProject() === selected && this.sourceGeneration.isCurrent(generation);
    const disk = await this.projectLoader(selected).catch(() => null);
    // Re-check after the await: a confirm/cancel/TTL-reclaim may have
    // superseded this exact stored analysis while disk was being re-read.
    // Failed reads do not prove changed files. Execution still fails closed on
    // its mandatory reread. A later watcher event can retry this advisory check.
    if (!isCurrent() || disk === null) return;
    let matches = resolvedProjectSourceMatches(disk, stored.snapshot) &&
      await reviewWorkspaceStillMatches(disk, stored.workspaceLayoutFingerprint);
    if (!isCurrent()) return;
    if (matches && stored.projectCompatibilityEvidenceFingerprint !== null) {
      const evidence = await collectProjectCompatibilityEvidence({
        platform: this.options.platform,
        folder: selected.folder,
        dir: selected.dir,
        manifestText: disk.manifestText,
        packageName: stored.eligibility.packageName,
      }).catch(() => null);
      // A confirm/cancel/new analysis may supersede this one during the
      // bounded source scan. Never stale a newer retained review.
      if (!isCurrent() || evidence === null) return;
      matches = projectCompatibilityEvidenceIsCurrent(
        stored.projectCompatibilityEvidenceFingerprint,
        evidence.evidenceFingerprint
      );
    }
    if (!matches) {
      this.analysis = undefined;
      this.options.sink.postMessage({ status: 'upgrade-analysis-stale', analysisId: stored.id });
      await this.releaseReservation(stored.eligibility.packageName);
    }
  }

  /** Setting events must stop advisory work even while the panel defers refresh. */
  handleAdvisorySettingChanged(): void {
    this.advisorySettingsGeneration += 1;
    this.activeUpgradeAdvisoryAbort?.abort();
    if (this.activeRemediationAnalysisId === undefined &&
        this.activeRemediationPackage !== undefined && !this.activeRemediationAbort?.signal.aborted) {
      const packageName = this.activeRemediationPackage;
      this.activeRemediationPackage = undefined;
      this.options.sink.postMessage({
        status: 'remediation-error', package: packageName,
        error: { code: 'ADVISORY_CHECK_CHANGED', message: 'Security checks changed. Review the fix again.' },
      });
    }
    this.activeRemediationAbort?.abort();
  }

  /** Every path that submits package names for advisories checks this first. */
  private publicAdvisoryCheckEnabled(root: string): boolean {
    return this.options.platform.getSetting<boolean>(PUBLIC_ADVISORY_CHECK_SETTING, true, root);
  }

  handleConfigureVerification(): void {
    this.options.platform.openSettings('upgrade.verificationScripts');
  }

  /**
   * Analyze phase for a coordinated removal: eligibility, the same
   * panel-wide lock an upgrade reserves, and a non-blocking dependency-graph
   * impact check (does anything else still resolve through what's being
   * removed). No compatibility preflight, no smart-plan search, no security
   * outcome: none apply to removing a declared dependency outright. Ends by
   * storing the analysis and posting it, exactly like handleAnalyzeUpgrade,
   * never by executing anything.
   */
  /**
   * Smart Cleanup's mutation entry point. Unlike the generic bulk-removal UI,
   * this path is authorized only by a still-current host removal-impact result;
   * the webview's package list is merely a canonical selection lookup.
   */
  async handleAnalyzeSmartCleanupRemove(message: SmartCleanupRemoveMessage): Promise<void> {
    const requestedPackage = message.packages[0] ?? 'Smart Cleanup';
    const removalEvidence = this.options.smartCleanupRemovalEvidence?.(message.removalRequestId, message.packages) ?? null;
    if (message.packages.length === 0 || removalEvidence == null || !removalEvidence.isCurrent()) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: requestedPackage,
        error: {
          code: 'STALE_ANALYSIS',
          message: 'This Smart Cleanup selection is no longer current. Analyze again.',
        },
      });
      return;
    }
    await this.handleAnalyzeBulkRemove(
      { changes: message.packages.map((packageName) => ({ package: packageName })) },
      {
        requestId: message.requestId,
        removalRequestId: message.removalRequestId,
        evidence: removalEvidence,
      }
    );
  }

  async handleAnalyzeBulkRemove(
    message: BulkRemoveMessage,
    smartCleanup?: SmartCleanupRemovalContext
  ): Promise<void> {
    this.reclaimExpiredAnalysis();
    this.reclaimExpiredRemoval();

    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: message.changes[0]?.package ?? 'unknown',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Wait for remediation analysis to finish before removing dependencies.' },
      });
      return;
    }

    const requestedPackage = message.changes[0]?.package ?? 'unknown';
    if (this.pendingRemovalAnalysis !== undefined) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: requestedPackage,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress for this project.' },
      });
      return;
    }
    const pending: PendingRemovalAnalysis = {
      packageName: requestedPackage,
      ...(smartCleanup === undefined ? {} : { smartCleanupRequestId: smartCleanup.requestId }),
      cancelled: false,
      reservationHeld: false,
      releaseStarted: false,
    };
    this.pendingRemovalAnalysis = pending;

    const controller = await this.options.ensureController();
    if (controller === undefined || pending.cancelled || this.pendingRemovalAnalysis !== pending) {
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }
    const refusal = dependencyChangeRefusal(controller.upgradeSource);
    if (refusal !== null) {
      this.options.sink.postMessage({ status: 'remove-error', package: requestedPackage, error: refusal });
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }

    if (smartCleanup !== undefined) {
      const capability = smartCleanupProjectCapability(controller.upgradeSource);
      if (!capability.executionSupported) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: requestedPackage,
          error: { code: 'NOT_ELIGIBLE', message: capability.reason },
        });
        if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
        return;
      }
      if (smartCleanup.evidence !== undefined && !smartCleanup.evidence.isCurrent()) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: requestedPackage,
          error: {
            code: 'STALE_ANALYSIS',
            message: 'This Smart Cleanup selection is no longer current. Analyze again.',
          },
        });
        if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
        return;
      }
    }

    let eligibilities: EligibleRemoval[];
    if (message.changes.length > 0) {
      const batch = controller.validateBulkRemoveRequest(message.changes);
      if (!batch.ok) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: batch.packageName ?? message.changes[0]?.package ?? 'unknown',
          error: describeBulkRemoveRejection(batch),
        });
        if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
        return;
      }
      eligibilities = batch.removals;
    } else {
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }
    const eligibility = eligibilities[0] ?? null;
    const reservationKey = eligibility?.packageName ?? requestedPackage;
    pending.packageName = reservationKey;

    // Same reservation discipline as an upgrade: held across analysis and
    // however long the review modal stays open, not merely execution.
    if (!this.reserve(reservationKey)) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: reservationKey,
        // Reuses the upgrade flow's code: it is the same panel-wide
        // lock, so the webview's existing upgradeErrorClearsActiveState/
        // upgradeErrorIsUserVisible already treat this race the right way
        // (quiet, doesn't clear whatever this webview is itself tracking).
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another dependency operation is already in progress for this project.' },
      });
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      return;
    }
    pending.reservationHeld = true;
    const analysisSourceGeneration = this.sourceGeneration.capture();

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const source = controller.upgradeSource;
      const preflightProject = await this.projectLoader(selected);
      if (pending.cancelled || this.pendingRemovalAnalysis !== pending || this.options.isDisposed()) return;
      if (
        preflightProject.root !== controller.root ||
        preflightProject.manifestText !== source.manifestText ||
        preflightProject.lockfileText !== source.lockfileText ||
        preflightProject.lockfilePath !== source.lockfilePath ||
        preflightProject.registry !== source.registry ||
        preflightProject.packageManager !== source.packageManager ||
        preflightProject.importerId !== source.importerId
      ) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: reservationKey,
          error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
        });
        return;
      }

      this.options.sink.postMessage({ status: 'remove-analyzing', package: reservationKey });

      const manifest = parseManifest(preflightProject.manifestText);
      const graph = buildDependencyGraph({
        root: preflightProject.root,
        manifest,
        lockfileText: preflightProject.lockfileText,
        packageManager: preflightProject.packageManager,
        importerId: preflightProject.importerId,
      });
      const removingNames = new Set(eligibilities.map((item) => item.packageName));
      const peerRequirementIndex = buildPeerRequirementIndex(graph);
      const whyInstalledIndex = buildWhyInstalledIndex(graph);
      const requiredPeerBlock = eligibilities
        .map((item) => ({
          packageName: item.packageName,
          requirements: peerRequirementsFor(graph, item.packageName, removingNames, peerRequirementIndex).filter((requirement) => !requirement.optional),
        }))
        .find((item) => item.requirements.length > 0);
      if (requiredPeerBlock !== undefined) {
        const owners = requiredPeerBlock.requirements.map((requirement) => requirement.requiredBy).join(', ');
        this.options.sink.postMessage({
          status: 'remove-error',
          package: requiredPeerBlock.packageName,
          error: {
            code: 'REQUIRED_PEER_DEPENDENCY',
            message: `${requiredPeerBlock.packageName} is required as a peer dependency by ${owners}. Remove the requiring package in the same operation or keep this dependency.`,
          },
        });
        return;
      }
      const changes = eligibilities.map((item) => ({
        packageName: item.packageName,
        classification: item.classification,
        stillRequiredBy: stillRequiredBy(graph, manifest.dependencies, item.packageName, removingNames, whyInstalledIndex),
      }));
      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');

      const ignoreScripts = this.options.platform.getSetting<boolean>('upgrade.ignoreScripts', true);
      const configuredVerification = this.options.platform.getSetting<unknown[]>('upgrade.verificationScripts', []);
      const verificationScripts = selectVerificationScripts(source.manifestText, configuredVerification);
      const suggestedScriptNames = verificationSuggestionsFor(source.manifestText, verificationScripts);

      const analysisId = randomBytes(16).toString('hex');
      const smartCleanupSnapshot = smartCleanup === undefined ? null : controller.lastResultSnapshot?.() ?? null;
      const deprecationEvidence = smartCleanup === undefined
        ? undefined
        : this.options.getSmartCleanupDeprecationEvidence?.();
      const smartCleanupBefore: SmartCleanupBeforeSnapshot | undefined = smartCleanupSnapshot === null || smartCleanup === undefined
        ? undefined
        : {
            snapshot: smartCleanupSnapshot,
            projectId: selected.id,
            sourceGeneration: analysisSourceGeneration,
            sourceFingerprint: computeSourceFingerprint({
              manifestText: preflightProject.manifestText,
              lockfileText: preflightProject.lockfileText,
              lockfilePath: preflightProject.lockfilePath,
              packageManager: preflightProject.packageManager,
              importerId: preflightProject.importerId,
            }),
            ...(deprecationEvidence === undefined
              ? {}
              : {
                  deprecatedDirectPackages: deprecationEvidence.deprecatedPackages,
                  deprecationInstalledVersions: deprecationEvidence.installedVersions,
                }),
          };
      const analyzedAt = new Date().toISOString();
      const expiresAt = Date.now() + UPGRADE_ANALYSIS_RETENTION_MS;
      const removal: StoredRemoval = {
        id: analysisId,
        requests: [...message.changes],
        eligibility,
        eligibilities,
        reservationKey,
        snapshot: preflightProject,
        ignoreScripts,
        verificationScripts,
        suggestedScriptNames,
        ...(smartCleanup?.evidence === undefined ? {} : { smartCleanupEvidence: smartCleanup.evidence }),
        ...(smartCleanup === undefined ? {} : { smartCleanupRequestId: smartCleanup.requestId }),
        ...(smartCleanupBefore === undefined ? {} : { smartCleanupBefore }),
        expiresAt,
      };
      if (pending.cancelled || this.pendingRemovalAnalysis !== pending || this.options.isDisposed()) return;
      if (
        smartCleanup?.evidence !== undefined &&
        !smartCleanup.evidence.isCurrent()
      ) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: reservationKey,
          error: {
            code: 'STALE_ANALYSIS',
            message: 'Project usage evidence changed while Smart Cleanup removal was being prepared. Analyze again.',
          },
        });
        return;
      }
      if (!this.sourceGeneration.commitIfCurrent(analysisSourceGeneration, () => {
        this.removal = removal;
      })) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: reservationKey,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed while removal impact was being analyzed. Analyze again.',
          },
        });
        return;
      }

      this.options.sink.postMessage({
        status: 'remove-analysis',
        analysis: buildRemoveAnalysisPresentation({
          analysisId,
          analyzedAt,
          expiresAt: new Date(expiresAt).toISOString(),
          packageName: reservationKey,
          changes,
          verificationScriptNames: verificationScripts.map((script) => script.scriptName),
          suggestedScriptNames,
          manifestPath,
          lockfilePath: expectedLockfilePath,
        }),
      });
      return;
    } catch (cause) {
      if (!pending.cancelled && this.pendingRemovalAnalysis === pending && !this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'remove-error', package: reservationKey, error: toProtocolError(cause) });
      }
      return;
    } finally {
      if (this.pendingRemovalAnalysis === pending) this.pendingRemovalAnalysis = undefined;
      if (pending.reservationHeld && !pending.releaseStarted) {
        pending.releaseStarted = true;
        await this.releaseReservation(reservationKey);
      }
    }
  }

  async handleConfirmRemove(message: AnalysisMessage & { resultInDialog?: true }): Promise<void> {
    await this.executeStoredRemoval(message.analysisId, message, message.resultInDialog === true);
  }

  handleCancelRemove(message: CancelRemoveMessage): void {
    if (message.analysisId === null) {
      const pending = this.pendingRemovalAnalysis;
      if (
        pending !== undefined &&
        !pending.cancelled &&
        (message.requestId === undefined || pending.smartCleanupRequestId === message.requestId)
      ) {
        pending.cancelled = true;
        // Free the request slot synchronously. The abandoned operation compares
        // identity after every await, so it cannot clear or publish over a
        // replacement that starts immediately after this cancellation.
        this.pendingRemovalAnalysis = undefined;
        if (pending.reservationHeld && !pending.releaseStarted) {
          pending.releaseStarted = true;
          void this.releaseReservation(pending.packageName);
        }
        return;
      }
      const stored = this.removal;
      if (message.requestId !== undefined && stored?.smartCleanupRequestId === message.requestId) {
        this.removal = undefined;
        void this.releaseReservation(stored.reservationKey);
      }
      return;
    }
    if (this.removal === undefined || this.removal.id !== message.analysisId) return;
    void this.releaseReservation(this.removal.reservationKey);
    this.removal = undefined;
  }

  /**
   * "Analyze remediation" for a transitive vulnerability with no direct
   * upgrade target. See resolveRemediationRequest
   * (src/core/advisories/remediationRequest.ts) for the eligibility check
   * and upgradeAction.ts's `transitive-remediation` state for where this is
   * triggered from.
   *
   * Analysis is read-only in the real project. An isolated copy starts from
   * the active lockfile and runs a targeted, script-free lockfile update for
   * the vulnerable transitive packages. The resulting tree is offered only
   * when the manifest and all direct dependency versions remain unchanged,
   * at least one targeted advisory is removed, and no advisory is introduced
   * or worsened. Applying the opaque reviewed plan is a separate transaction
   * with a final advisory reread and compare-and-swap rollback.
   */
  async handleAnalyzeRemediation(message: RemediationMessage): Promise<void> {
    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: message.package,
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another remediation analysis is already in progress.' },
      });
      return;
    }
    const abort = new AbortController();
    this.activeRemediationAbort = abort;
    this.activeRemediationPackage = message.package;
    const performance = createPerformanceSession(
      'Packageawy remediation analysis',
      this.options.performanceEnabled?.() ?? false
    );
    try {
      await this.analyzeRemediation(message, abort.signal, { performance });
    } finally {
      if (this.activeRemediationAbort === abort) this.activeRemediationAbort = undefined;
      if (this.activeRemediationPackage === message.package) this.activeRemediationPackage = undefined;
      performance.finish({ packages: 1 });
    }
  }

  async handleAnalyzeRemediations(message: RemediationBatchMessage): Promise<void> {
    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remediation-batch-error',
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Another remediation analysis is already in progress.' },
      });
      return;
    }
    const abort = new AbortController();
    this.activeRemediationAbort = abort;
    const total = message.packages.length;
    const performance = createPerformanceSession(
      'Packageawy bulk remediation analysis',
      this.options.performanceEnabled?.() ?? false
    );
    const sharedWork: SharedRemediationWork = { performance };
    try {
      const result = await runSequentialBatch({
        items: message.packages,
        signal: abort.signal,
        onStart: (packageName, completed) => {
          this.options.sink.postMessage({ status: 'remediation-batch-progress', completed, total, current: packageName });
        },
        run: async (packageName, signal) => this.analyzeRemediation({ package: packageName }, signal, sharedWork),
        onError: (packageName, cause) => {
          if (!this.options.isDisposed()) {
            this.options.sink.postMessage({
              status: 'remediation-error',
              package: packageName,
              error: toProtocolError(cause),
            });
          }
        },
      });
      this.options.sink.postMessage({
        status: 'remediation-batch-complete',
        completed: result.completed,
        total,
        cancelled: result.cancelled,
      });
    } finally {
      if (this.activeRemediationAbort === abort) this.activeRemediationAbort = undefined;
      this.activeRemediationPackage = undefined;
      performance.finish({ packages: total });
    }
  }

  handleCancelRemediation(): void {
    this.activeRemediationAbort?.abort();
  }

  handleCancelRemediationPlan(message: RemediationAnalysisMessage): void {
    if (this.activeRemediationAnalysisId === message.analysisId) {
      this.activeRemediationAbort?.abort();
      return;
    }
    const stored = this.remediationPlans.get(message.analysisId);
    if (stored === undefined) return;
    this.remediationPlans.delete(stored.id);
    if (this.remediationPlanByPackage.get(stored.packageName) === stored.id) {
      this.remediationPlanByPackage.delete(stored.packageName);
    }
  }

  async handleRetryRemediation(message: RemediationAnalysisMessage): Promise<void> {
    const stored = this.remediationPlans.get(message.analysisId);
    if (stored === undefined) return;
    const packageName = stored.packageName;
    this.handleCancelRemediationPlan(message);
    await this.handleAnalyzeRemediation({ package: packageName });
  }

  async handleConfirmRemediation(message: RemediationAnalysisMessage): Promise<void> {
    await this.executeStoredRemediation(message.analysisId, message);
  }

  private async analyzeRemediation(
    message: RemediationMessage,
    signal: AbortSignal,
    sharedWork: SharedRemediationWork
  ): Promise<void> {
    const controller = await this.options.ensureController();
    if (controller === undefined) return;
    const refusal = dependencyChangeRefusal(controller.upgradeSource);
    if (refusal !== null) {
      this.options.sink.postMessage({ status: 'remediation-error', package: message.package, error: refusal });
      return;
    }
    if (!this.publicAdvisoryCheckEnabled(controller.root)) {
      this.options.sink.postMessage({ status: 'remediation-error', package: message.package, error: ADVISORY_CHECK_OFF });
      return;
    }

    const eligibility = resolveRemediationRequest(controller.lastResultRows(), message.package);
    if (!eligibility.ok) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: message.package,
        error: REMEDIATION_REQUEST_ERRORS[eligibility.reason],
      });
      return;
    }
    const { row } = eligibility;
    // resolveRemediationRequest already guarantees this. Re-asserted for the
    // type checker without weakening the check itself.
    if (row.current === null) return;
    const currentVersion = row.current;
    this.activeRemediationPackage = row.name;

    this.options.sink.postMessage({ status: 'remediation-analyzing', package: row.name });

    try {
      const prepared = await this.prepareRemediationWork(
        controller,
        eligibility.transitiveAdvisories,
        row.name,
        signal,
        sharedWork.performance
      );
      if (signal.aborted) return;
      if (this.options.isDisposed()) return;
      const plan = createTransitiveRemediationPlan({
        rootPackageName: row.name,
        targetAdvisories: eligibility.transitiveAdvisories,
        before: prepared.before,
        after: prepared.after,
        manifestUnchanged: true,
      });
      const analysisId = randomBytes(16).toString('hex');
      const generatedAt = Date.now();
      const expiresAt = generatedAt + UPGRADE_ANALYSIS_SOFT_STALE_MS;
      const configuration = this.getUpgradeConfiguration();
      const verificationScripts = selectVerificationScripts(
        prepared.project.manifestText,
        configuration.verificationScripts
      );
      const suggestedScriptNames = verificationSuggestionsFor(prepared.project.manifestText, verificationScripts);
      const presentation = buildTransitiveRemediationPresentation({
        analysisId,
        generatedAt: new Date(generatedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        rootPackage: row.name,
        currentVersion,
        packageManager: prepared.project.packageManager,
        packageManagerVersion: prepared.packageManagerVersion,
        lifecycleScriptsEnabled: !configuration.ignoreScripts,
        manifestPath: 'package.json',
        lockfilePath: path.relative(prepared.project.root, prepared.project.lockfilePath!).split(path.sep).join('/'),
        plan,
        afterGraph: prepared.after.graph,
        targetedPackages: new Set(eligibility.transitiveAdvisories.map((entry) => entry.flaggedPackage)),
        verification: buildUpgradeAnalysisVerification(
          verificationScripts.map((entry) => entry.scriptName),
          suggestedScriptNames
        ),
      });
      const previousId = this.remediationPlanByPackage.get(row.name);
      if (previousId !== undefined) this.remediationPlans.delete(previousId);
      const stored: StoredRemediationPlan = {
        id: analysisId,
        packageName: row.name,
        snapshot: prepared.project,
        before: prepared.before,
        targetAdvisories: [...eligibility.transitiveAdvisories],
        proposedLockfileText: prepared.materialized.lockfileText,
        packageManagerVersion: prepared.packageManagerVersion,
        ignoreScripts: configuration.ignoreScripts,
        verificationScripts,
        suggestedScriptNames,
        plan,
        presentation,
        expiresAt,
        stale: false,
      };
      this.remediationPlans.set(analysisId, stored);
      this.remediationPlanByPackage.set(row.name, analysisId);
      this.options.sink.postMessage({ status: 'remediation-plan', package: row.name, plan: presentation });
    } catch (cause) {
      if (!this.options.isDisposed() && !signal.aborted) {
        this.options.sink.postMessage({ status: 'remediation-error', package: row.name, error: toProtocolError(cause) });
      }
    }
  }

  private async prepareRemediationWork(
    controller: DashboardController,
    targetAdvisories: readonly AttributedAdvisory[],
    packageName: string,
    signal: AbortSignal,
    performance?: PerformanceRecorder
  ): Promise<PreparedRemediationWork> {
    const selected = this.options.getSelectedProject();
    if (selected === undefined) throw Object.assign(new Error('No project is selected.'), { name: 'NO_PROJECT' });
    const endProjectLoad = performance?.start('remediation project reload') ?? (() => 0);
    const preflightProject = await this.projectLoader(selected);
    endProjectLoad();
    const source = controller.upgradeSource;
    if (
      preflightProject.root !== controller.root ||
      preflightProject.manifestText !== source.manifestText ||
      preflightProject.lockfileText !== source.lockfileText ||
      preflightProject.lockfilePath !== source.lockfilePath ||
      preflightProject.registry !== source.registry ||
      preflightProject.packageManager !== source.packageManager ||
      preflightProject.importerId !== source.importerId ||
      JSON.stringify(preflightProject.peerPolicy) !== JSON.stringify(source.peerPolicy) ||
      JSON.stringify(preflightProject.resolvedRegistry) !== JSON.stringify(source.resolvedRegistry)
    ) {
      throw Object.assign(new Error('Project dependency files changed. Refresh and try again.'), {
        name: 'STALE_SOURCE',
      });
    }
    if (preflightProject.lockfileText === null || preflightProject.lockfilePath === null || preflightProject.lockfileName === null) {
      throw Object.assign(new Error('A current npm or pnpm lockfile is required to prepare a transitive fix.'), {
        name: 'NO_LOCKFILE',
      });
    }
    if (preflightProject.importerId !== '.') {
      throw Object.assign(new Error('Automatic transitive fixes for workspace importers are not supported yet.'), {
        name: 'UNSUPPORTED_WORKSPACE',
      });
    }

    const endToolchain = performance?.start('remediation package-manager resolution') ?? (() => 0);
    const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
    const packageManagerInvocation =
      preflightProject.packageManager === 'pnpm'
        ? resolveInstalledPnpmInvocation(npmResolution.ok ? npmResolution.invocation : null, controller.root)
        : npmResolution.ok
          ? {
              executable: npmResolution.invocation.node,
              prefixArgs: [npmResolution.invocation.npmCliJs],
              version: npmResolution.invocation.version,
            }
          : null;
    endToolchain({ available: packageManagerInvocation !== null });
    if (packageManagerInvocation === null) {
      throw Object.assign(new Error(preflightProject.packageManager === 'pnpm' ? PNPM_NOT_FOUND_MESSAGE : 'The package manager could not be located to run this check.'), {
        name: 'RESOLVER_UNAVAILABLE',
      });
    }

    const resolverVerifier = new IsolatedResolverVerifier({
      packageManager: preflightProject.packageManager,
      packageManagerVersion: packageManagerInvocation.version ?? null,
      invocation: packageManagerInvocation,
      manifestText: preflightProject.manifestText,
      lockfile: { name: preflightProject.lockfileName, text: preflightProject.lockfileText },
      registry: preflightProject.registry,
      resolvedRegistry: preflightProject.resolvedRegistry,
      policy: preflightProject.peerPolicy,
    });
    const targetNames = [...new Set(targetAdvisories.map((entry) => entry.flaggedPackage))].sort();
    const endMaterialization = performance?.start('remediation graph materialization') ?? (() => 0);
    const materialized = await this.options.platform.withProgress(
      `Checking remediation for ${packageName}`,
      async (_progress, token) => {
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        const externalCancellation = (): void => abort.abort();
        signal.addEventListener('abort', externalCancellation, { once: true });
        if (signal.aborted) abort.abort();
        try {
          return await resolverVerifier.materializeTransitiveRemediation(targetNames, abort.signal);
        } finally {
          cancellation.dispose();
          signal.removeEventListener('abort', externalCancellation);
        }
      }
    );
    endMaterialization({ resolved: materialized.ok });
    if (!materialized.ok) {
      throw Object.assign(new Error(materialized.reason), { name: 'RESOLVER_UNAVAILABLE' });
    }
    if (!this.publicAdvisoryCheckEnabled(controller.root)) {
      throw Object.assign(new Error(ADVISORY_CHECK_OFF_MESSAGE), { name: ADVISORY_CHECK_OFF.code });
    }
    const endAdvisories = performance?.start('remediation advisory verification') ?? (() => 0);
    let proposedAdvisories: Map<string, import('../core/types.js').Advisory[]>;
    try {
      const npmAdvisories = await fetchBulkAdvisories(
        this.options.httpClient,
        buildBulkRequestBody(materialized.graph),
        signal,
        () => this.publicAdvisoryCheckEnabled(controller.root)
      );
      proposedAdvisories = await enrichAdvisoriesWithGitHubIdentifiers(
        this.options.httpClient,
        this.options.etagStore,
        npmAdvisories,
        signal
      );
    } catch (cause) {
      endAdvisories({ available: false });
      throw Object.assign(
        new Error(`The proposed dependency tree could not be checked for vulnerabilities: ${cause instanceof Error ? cause.message : String(cause)}`),
        { name: 'SECURITY_EVIDENCE_UNAVAILABLE' }
      );
    }
    endAdvisories({ available: true });
    return {
      project: preflightProject,
      materialized,
      before: {
        graph: materialized.beforeGraph,
        advisoriesByName: advisoriesByNameFromRows(controller.lastResultRows()),
        advisories: 'complete',
      },
      after: { graph: materialized.graph, advisoriesByName: proposedAdvisories, advisories: 'complete' },
      packageManagerVersion: packageManagerInvocation.version ?? null,
    };
  }

  private async executeStoredRemediation(analysisId: string, optIn: VerificationOptInRequest = {}): Promise<void> {
    const stored = this.remediationPlans.get(analysisId);
    if (stored === undefined) return;
    if (stored.stale || Date.now() >= stored.expiresAt) {
      stored.stale = true;
      this.options.sink.postMessage({
        status: 'remediation-stale',
        package: stored.packageName,
        analysisId: stored.id,
        message: 'This transitive fix is no longer current. Check it again before applying.',
      });
      return;
    }
    if (!stored.plan.automaticApplyAllowed) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: stored.packageName,
        error: { code: 'NO_SAFE_FIX', message: 'The reviewed candidate is not safe to apply automatically.' },
      });
      return;
    }
    if (this.activeRemediationAbort !== undefined) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: stored.packageName,
        error: { code: 'ANALYSIS_IN_PROGRESS', message: 'Wait for the current transitive-fix operation to finish.' },
      });
      return;
    }
    if (!this.reserve(stored.packageName)) {
      this.options.sink.postMessage({
        status: 'remediation-error',
        package: stored.packageName,
        error: { code: 'OPERATION_IN_PROGRESS', message: 'Another dependency change is already in progress.' },
      });
      return;
    }

    const abort = new AbortController();
    this.activeRemediationAbort = abort;
    this.activeRemediationAnalysisId = stored.id;
    const selected = this.options.getSelectedProject();
    let finalPlan: TransitiveRemediationPlan | undefined;
    let finalPresentation: TransitiveRemediationPlanSummary | undefined;
    try {
      if (selected === undefined) {
        throw Object.assign(new Error('No project is selected.'), { name: 'NO_PROJECT' });
      }
      const disk = await this.projectLoader(selected);
      if (
        stored.stale ||
        !resolvedProjectSourceMatches(disk, stored.snapshot) ||
        disk.lockfilePath === null ||
        disk.lockfileText === null
      ) {
        stored.stale = true;
        this.options.sink.postMessage({
          status: 'remediation-stale',
          package: stored.packageName,
          analysisId: stored.id,
          message: 'Project dependency files changed after this fix was checked. Check it again before applying.',
        });
        return;
      }
      const currentNpm = resolveNpmInvocation(createNodeNpmResolverDeps(disk.root));
      const currentInvocation = disk.packageManager === 'pnpm'
        ? resolveInstalledPnpmInvocation(currentNpm.ok ? currentNpm.invocation : null, disk.root)
        : currentNpm.ok ? { version: currentNpm.invocation.version } : null;
      if (
        currentInvocation === null ||
        (stored.packageManagerVersion !== null && currentInvocation.version !== stored.packageManagerVersion)
      ) {
        stored.stale = true;
        this.options.sink.postMessage({
          status: 'remediation-stale',
          package: stored.packageName,
          analysisId: stored.id,
          message: 'The package-manager version changed after this fix was checked. Check the fix again.',
        });
        return;
      }

      // The plan is deleted when this run ends, so the accepted opt-in only
      // affects this one run.
      await applyVerificationOptIn(this.options.platform, stored, {
        currentSetting: this.getUpgradeConfiguration().verificationScripts,
        manifestText: disk.manifestText,
        request: optIn,
      });

      const prepared = this.session.prepareLockfileReconciliation({
        cwd: disk.root,
        ignoreScripts: stored.ignoreScripts,
        packageManager: disk.packageManager,
      });
      if (!prepared.ok) {
        this.options.sink.postMessage({
          status: 'remediation-error',
          package: stored.packageName,
          error: { code: prepared.code, message: prepared.message },
        });
        return;
      }

      const manifestPath = path.join(disk.root, 'package.json');
      const lockfilePath = disk.lockfilePath;
      const files = await createNodeUpgradeTransactionFileAdapter({
        workspaceRoot: selected.folder.path,
        allowlistedPaths: [manifestPath, lockfilePath],
      });
      if (stored.stale) {
        this.options.sink.postMessage({
          status: 'remediation-stale',
          package: stored.packageName,
          analysisId: stored.id,
          message: 'Project dependency files changed before the reviewed fix could start. Check it again.',
        });
        return;
      }
      if (abort.signal.aborted) {
        this.options.sink.postMessage({
          status: 'remediation-apply-result',
          package: stored.packageName,
          analysisId: stored.id,
          result: {
            outcome: 'cancelled',
            message: 'The transitive fix was cancelled before any dependency changes were applied.',
            verification: 'not-run',
            rollback: 'not-needed',
            resolvedAdvisories: [],
            remainingAdvisories: [...stored.presentation.resolvedAdvisories, ...stored.presentation.remainingAdvisories]
              .slice(0, MAX_REMEDIATION_PRESENTED_ADVISORIES),
            introducedAdvisories: [],
          },
        });
        return;
      }
      if (!this.reservation.beginMutation(stored.packageName)) {
        this.options.sink.postMessage({
          status: 'remediation-error',
          package: stored.packageName,
          error: { code: 'OPERATION_IN_PROGRESS', message: 'The transitive fix could not acquire the dependency mutation lock.' },
        });
        return;
      }
      this.options.sink.postMessage({
        status: 'remediation-applying',
        package: stored.packageName,
        analysisId: stored.id,
        phase: 'preparing',
      });

      let securityVerificationFailed = false;
      const transaction = await runUpgradeTransaction({
        allowlistedPaths: [manifestPath, lockfilePath],
        files,
        fileStages: [{
          path: lockfilePath,
          expectedContents: Buffer.from(disk.lockfileText, 'utf8'),
          contents: Buffer.from(stored.proposedLockfileText, 'utf8'),
        }],
        install: {
          execute: async () => {
            this.options.sink.postMessage({
              status: 'remediation-applying',
              package: stored.packageName,
              analysisId: stored.id,
              phase: 'installing',
            });
            const outcome = await prepared.execute();
            return outcome.ok
              ? { status: 'succeeded' as const }
              : { status: 'failed' as const, code: outcome.code, message: outcome.message };
          },
        },
        verifier: {
          verify: async () => {
            this.options.sink.postMessage({
              status: 'remediation-applying',
              package: stored.packageName,
              analysisId: stored.id,
              phase: 'verifying-security',
            });
            const checks: Array<{ id: string; status: 'passed' | 'failed' | 'cancelled'; message?: string }> = [];
            try {
              const applied = await this.projectLoader(selected);
              if (
                applied.manifestText !== stored.snapshot.manifestText ||
                applied.lockfileText === null ||
                applied.lockfileText !== stored.proposedLockfileText ||
                applied.lockfilePath !== stored.snapshot.lockfilePath ||
                applied.packageManager !== stored.snapshot.packageManager ||
                applied.importerId !== stored.snapshot.importerId
              ) {
                throw new Error('The installed project no longer matches the reviewed manifest and lockfile plan.');
              }
              const graph = buildDependencyGraph({
                root: applied.root,
                manifest: parseManifest(applied.manifestText),
                lockfileText: applied.lockfileText,
                packageManager: applied.packageManager,
                importerId: applied.importerId,
              });
              if (!this.publicAdvisoryCheckEnabled(applied.root)) throw new Error(ADVISORY_CHECK_OFF_MESSAGE);
              const npmAdvisories = await fetchBulkAdvisories(
                this.options.httpClient,
                buildBulkRequestBody(graph),
                abort.signal,
                () => this.publicAdvisoryCheckEnabled(applied.root)
              );
              const advisoriesByName = await enrichAdvisoriesWithGitHubIdentifiers(
                this.options.httpClient,
                this.options.etagStore,
                npmAdvisories,
                abort.signal
              );
              finalPlan = createTransitiveRemediationPlan({
                rootPackageName: stored.packageName,
                targetAdvisories: stored.targetAdvisories,
                before: stored.before,
                after: { graph, advisoriesByName, advisories: 'complete' },
                manifestUnchanged: true,
              });
              finalPresentation = buildTransitiveRemediationPresentation({
                analysisId: stored.id,
                generatedAt: stored.presentation.generatedAt,
                expiresAt: stored.presentation.expiresAt,
                rootPackage: stored.packageName,
                currentVersion: stored.presentation.currentVersion,
                packageManager: applied.packageManager,
                packageManagerVersion: stored.packageManagerVersion,
                lifecycleScriptsEnabled: !stored.ignoreScripts,
                manifestPath: 'package.json',
                lockfilePath: path.relative(applied.root, lockfilePath).split(path.sep).join('/'),
                plan: finalPlan,
                afterGraph: graph,
                targetedPackages: new Set(stored.targetAdvisories.map((entry) => entry.flaggedPackage)),
                verification: stored.presentation.verification,
              });
              const promisedResolved = new Set(stored.plan.target.resolved.map((entry) => entry.identity));
              const finallyResolved = new Set(finalPlan.target.resolved.map((entry) => entry.identity));
              const preservedReviewedOutcome = [...promisedResolved].every((identity) => finallyResolved.has(identity));
              securityVerificationFailed = !finalPlan.automaticApplyAllowed || !preservedReviewedOutcome;
              checks.push({
                id: 'transitive-security',
                status: securityVerificationFailed ? 'failed' : 'passed',
                ...(securityVerificationFailed
                  ? { message: 'The installed dependency tree did not preserve the reviewed security outcome.' }
                  : {}),
              });
            } catch (cause) {
              securityVerificationFailed = true;
              checks.push({
                id: 'transitive-security',
                status: abort.signal.aborted ? 'cancelled' : 'failed',
                message: cause instanceof Error ? cause.message : String(cause),
              });
            }

            if (!securityVerificationFailed && stored.verificationScripts.length > 0) {
              this.options.sink.postMessage({
                status: 'remediation-applying',
                package: stored.packageName,
                analysisId: stored.id,
                phase: 'verifying-project',
              });
              const projectVerification = await this.session.verify({
                packageName: stored.packageName,
                cwd: disk.root,
                packageManager: disk.packageManager,
                scripts: stored.verificationScripts,
                signal: abort.signal,
              });
              checks.push(...projectVerification.checks);
              if (projectVerification.status === 'cancelled') return { status: 'cancelled', checks };
              if (projectVerification.status === 'failed') {
                return { status: 'failed', checks, ...(projectVerification.message === undefined ? {} : { message: projectVerification.message }) };
              }
            }
            if (checks.some((check) => check.status === 'cancelled')) return { status: 'cancelled', checks };
            if (checks.some((check) => check.status === 'failed')) return { status: 'failed', checks };
            return { status: 'passed', checks };
          },
        },
        verificationFailureDecider: {
          decide: async () => {
            this.options.sink.postMessage({
              status: 'remediation-applying',
              package: stored.packageName,
              analysisId: stored.id,
              phase: 'rolling-back',
            });
            if (securityVerificationFailed || this.options.isDisposed()) return 'rollback';
            const choice = await this.options.platform.showModalWarning(
              'The transitive fix installed, but project verification failed.',
              'Rollback restores package.json and the active lockfile. Keep changes only if you have reviewed the failed checks.',
              ['Rollback', 'Keep Changes']
            );
            return choice === 'Keep Changes' ? 'keep' : 'rollback';
          },
        },
        signal: abort.signal,
      });

      if (transaction.completion === 'not-started' && transaction.reason !== 'cancelled') {
        const lockfileConflict = transaction.fileStages?.some(
          (stage) => stage.status === 'failed' && stage.code === 'CONFLICT'
        ) === true;
        if (lockfileConflict) {
          stored.stale = true;
          this.options.sink.postMessage({
            status: 'remediation-stale',
            package: stored.packageName,
            analysisId: stored.id,
            message: 'The lockfile changed before the reviewed fix could be applied. Check the fix again.',
          });
        } else {
          this.options.sink.postMessage({
            status: 'remediation-error',
            package: stored.packageName,
            error: {
              code: transaction.reason.toUpperCase().replaceAll('-', '_'),
              message: 'The transitive fix could not start, so no dependency changes were applied.',
            },
          });
        }
        return;
      }

      // Restoring package.json/lockfile bytes is not enough after a package
      // manager has touched node_modules. Reconcile the installed tree back
      // to the restored lockfile before claiming rollback completed.
      let rollbackReconciliationFailed = false;
      if (
        transaction.completion === 'rolled-back' &&
        transaction.rollback.status === 'succeeded' &&
        transaction.install.status !== 'not-run'
      ) {
        this.options.sink.postMessage({
          status: 'remediation-applying',
          package: stored.packageName,
          analysisId: stored.id,
          phase: 'rolling-back',
        });
        const restore = this.session.prepareLockfileReconciliation({
          cwd: disk.root,
          ignoreScripts: stored.ignoreScripts,
          packageManager: disk.packageManager,
        });
        if (!restore.ok) {
          rollbackReconciliationFailed = true;
        } else {
          const restored = await restore.execute();
          rollbackReconciliationFailed = !restored.ok;
        }
      }

      const rollback: TransitiveRemediationApplyResult['rollback'] =
        rollbackReconciliationFailed
          ? 'failed'
          : transaction.rollback.status === 'not-needed'
          ? 'not-needed'
          : transaction.rollback.status === 'succeeded'
            ? 'succeeded'
            : transaction.rollback.status;
      const verification: TransitiveRemediationApplyResult['verification'] =
        transaction.verification.status === 'passed'
          ? 'passed'
          : transaction.verification.status === 'failed'
            ? 'failed'
            : transaction.verification.status === 'not-run' && transaction.verification.reason === 'not-configured'
              ? 'not-configured'
              : 'not-run';
      const outcome: TransitiveRemediationApplyResult['outcome'] =
        rollbackReconciliationFailed
          ? 'recovery-required'
          : transaction.completion === 'rolled-back'
          ? transaction.reason === 'cancelled' ? 'cancelled' : 'rolled-back'
          : transaction.completion === 'incomplete'
            ? 'recovery-required'
            : transaction.completion === 'kept' && transaction.verification.status === 'passed' && finalPlan?.classification === 'full'
              ? 'verified'
              : transaction.completion === 'kept' && transaction.verification.status === 'passed' && finalPlan?.classification === 'partial'
                ? 'partial'
                : transaction.reason === 'cancelled'
                  ? 'cancelled'
                  : 'unverified';
      const resultEvidence = transaction.completion === 'kept' && finalPresentation !== undefined
        ? finalPresentation
        : stored.presentation;
      const result: TransitiveRemediationApplyResult = {
        outcome,
        message:
          outcome === 'verified'
            ? 'The transitive vulnerabilities were resolved without changing the direct dependency.'
            : outcome === 'partial'
              ? 'The safe transitive update was applied, but some selected vulnerabilities remain.'
              : outcome === 'rolled-back'
                ? 'The fix could not be verified, so the dependency files were restored.'
                : outcome === 'cancelled'
                  ? 'The transitive fix was cancelled and any staged dependency-file changes were restored.'
                  : outcome === 'recovery-required'
                    ? 'The operation could not restore every dependency file automatically. Review the project before continuing.'
                    : finalPlan?.automaticApplyAllowed === true && transaction.verification.status === 'failed'
                      ? 'The security outcome was verified, but project verification failed and the changes were kept.'
                      : 'The dependency change finished, but the reviewed security outcome could not be verified.',
        verification,
        rollback,
        resolvedAdvisories: outcome === 'recovery-required'
          ? []
          : transaction.completion === 'kept' ? resultEvidence.resolvedAdvisories : [],
        remainingAdvisories: outcome === 'recovery-required'
          ? []
          : transaction.completion === 'kept'
          ? resultEvidence.remainingAdvisories
          : [...stored.presentation.resolvedAdvisories, ...stored.presentation.remainingAdvisories]
              .slice(0, MAX_REMEDIATION_PRESENTED_ADVISORIES),
        introducedAdvisories: outcome === 'recovery-required'
          ? []
          : transaction.completion === 'kept' ? resultEvidence.introducedAdvisories : [],
      };
      this.options.sink.postMessage({
        status: 'remediation-apply-result',
        package: stored.packageName,
        analysisId: stored.id,
        result,
      });

      if (this.options.readAndApplyMutationLocalState !== undefined) {
        const local = await this.options.readAndApplyMutationLocalState();
        if (local !== undefined && this.options.refreshMutationEnrichmentInBackground !== undefined) {
          this.options.refreshMutationEnrichmentInBackground(
            randomBytes(16).toString('hex'),
            stored.packageName,
            local.structurallyCurrent
          );
        }
      } else if (!this.options.isDisposed()) {
        await this.options.reloadFinalState();
      }
    } catch (cause) {
      if (!this.options.isDisposed() && !abort.signal.aborted) {
        this.options.sink.postMessage({
          status: 'remediation-error',
          package: stored.packageName,
          error: toProtocolError(cause),
        });
      }
    } finally {
      if (this.activeRemediationAbort === abort) this.activeRemediationAbort = undefined;
      if (this.activeRemediationAnalysisId === stored.id) this.activeRemediationAnalysisId = undefined;
      this.handleCancelRemediationPlan({ analysisId: stored.id });
      await this.releaseReservation(stored.packageName);
    }
  }

  /**
   * Execution phase, shared by confirm-upgrade and use-smart-plan: look up
   * the stored analysis (via resolveAnalysisForExecution in
   * upgradeAnalysisLookup.ts), re-read the project from disk, recheck
   * eligibility, then execute.
   */
  private async executeStoredAnalysis(
    analysisId: string,
    wantsSmartPlan: boolean,
    optIn: VerificationOptInRequest & { securityAcknowledged?: boolean } = {}
  ): Promise<void> {
    const stored = this.analysis;
    const now = Date.now();
    const lookup = resolveAnalysisForExecution({
      stored:
        stored === undefined
          ? undefined
          : {
              id: stored.id,
              compatibilityStatus: stored.compatibilityStatus,
              hasSmartPlan: stored.smartPlanProposal !== null,
              expiresAt: stored.expiresAt,
            },
      requestedAnalysisId: analysisId,
      now,
      wantsSmartPlan,
    });
    if (!lookup.ok || stored === undefined) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: stored?.eligibility.packageName ?? 'unknown',
        error: ANALYSIS_LOOKUP_ERRORS[lookup.ok ? 'STALE_ANALYSIS' : lookup.reason],
      });
      if (stored !== undefined && now >= stored.expiresAt) {
        this.analysis = undefined;
        await this.releaseReservation(stored.eligibility.packageName);
      }
      return;
    }
    if (requiresSecurityAcknowledgement(stored.security) && optIn.securityAcknowledged !== true) {
      this.options.sink.postMessage({
        status: 'upgrade-error', package: stored.eligibility.packageName,
        error: { code: 'SECURITY_ACKNOWLEDGEMENT_REQUIRED',
          message: 'Acknowledge the known vulnerabilities added by this upgrade before continuing.' },
      });
      return;
    }
    if (!this.reserve(stored.eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: stored.eligibility.packageName,
        error: {
          code: 'UPGRADE_IN_PROGRESS',
          message: 'Another dependency change is already in progress for this project.',
        },
      });
      return;
    }
    // `wantsSmartPlan` guarantees `hasSmartPlan` was true for `lookup.ok` to
    // be true, so `smartPlanProposal` is never null here: the `??`
    // fallback below only exists to satisfy the type checker, not because
    // this path is reachable.
    const proposal = wantsSmartPlan ? (stored.smartPlanProposal ?? stored.proposal) : stored.proposal;
    const executionSourceGeneration = this.sourceGeneration.capture();

    // Single-use: cleared now, regardless of outcome, so a retry always goes
    // through a fresh handleAnalyzeUpgrade.
    this.analysis = undefined;

    const controller = await this.options.ensureController();
    if (controller === undefined) {
      await this.releaseReservation(stored.eligibility.packageName);
      return;
    }

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;

      // A modal can remain open while project/config files change. Re-read
      // and repeat the host-owned eligibility check immediately before the
      // snapshot. The stored analysis is never execution authority.
      const disk = await this.projectLoader(selected);
      const sourceStillMatches = disk.root === controller.root && resolvedProjectSourceMatches(disk, stored.snapshot) &&
        await reviewWorkspaceStillMatches(disk, stored.workspaceLayoutFingerprint);
      const rechecked = controller.validateBulkUpgradeRequest(
        stored.requests,
        stored.publishedTargetsByPackage
      );
      const currentProjectEvidence = sourceStillMatches && stored.projectCompatibilityEvidenceFingerprint !== null
        ? await collectProjectCompatibilityEvidence({
            platform: this.options.platform,
            folder: selected.folder,
            dir: selected.dir,
            manifestText: disk.manifestText,
            packageName: stored.eligibility.packageName,
          }).catch(() => null)
        : null;
      const projectEvidenceStillMatches = projectCompatibilityEvidenceIsCurrent(
        stored.projectCompatibilityEvidenceFingerprint,
        currentProjectEvidence?.evidenceFingerprint ?? null
      );
      if (!sourceStillMatches || !projectEvidenceStillMatches || !rechecked.ok) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project dependency or analyzed source files changed while the analysis was open. Refresh and try again.',
          },
        });
        return;
      }
      // `stored` was detached from this.analysis above, so the accepted
      // opt-in only affects this one run.
      await applyVerificationOptIn(this.options.platform, stored, {
        currentSetting: this.getUpgradeConfiguration().verificationScripts,
        manifestText: disk.manifestText,
        request: optIn,
      });

      const source = controller.upgradeSource;
      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
      const allowlistedPaths = [manifestPath, expectedLockfilePath];
      // Every upgrade writes package.json itself and then reconciles with a
      // bare install. `npm install pkg@x` / `pnpm add pkg@x` would apply the
      // user's save-prefix (turning an exact pin into ^x) and re-sort the
      // dependency blocks. Pass one stages exact targets so the package
      // manager resolves exactly the reviewed versions. If a declaration had
      // a ^ or ~ operator, pass two restores that operator around the target
      // and updates only the lockfile's recorded specifier.
      const stagedChanges = proposal.changes.map((change) => ({
        packageName: change.packageName,
        target: change.targetVersion,
        classification: change.classification,
      }));
      const stagedManifest = buildStagedManifest(disk.manifestText, stagedChanges);
      const styledManifest = buildStagedManifest(disk.manifestText, stagedChanges, { rangeStyle: 'preserve' });

      const files = await createNodeUpgradeTransactionFileAdapter({
        workspaceRoot: selected.folder.path,
        allowlistedPaths,
      });

      const taskTitle = `Packageawy: Upgrade ${stored.eligibility.packageName}`;
      const prepared = this.session.prepareManifestReconciliation({
        cwd: controller.root,
        importerId: source.importerId,
        ignoreScripts: stored.ignoreScripts,
        packageManager: source.packageManager,
        taskTitle,
        taskScope: stored.eligibility.packageName,
      });
      const preparedRestyle = styledManifest === stagedManifest
        ? null
        : this.session.prepareManifestReconciliation({
            cwd: controller.root,
            importerId: source.importerId,
            ignoreScripts: true,
            packageManager: source.packageManager,
            lockfileOnly: true,
            taskTitle: `${taskTitle} (keep version ranges)`,
            taskScope: stored.eligibility.packageName,
          });
      for (const candidate of [prepared, preparedRestyle]) {
        if (candidate === null || candidate.ok) continue;
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: { code: candidate.code, message: candidate.message },
        });
        return;
      }
      if (!prepared.ok || (preparedRestyle !== null && !preparedRestyle.ok)) return;
      const install = createRangePreservingInstall({
        manifestPath,
        stagedManifest,
        styledManifest,
        resolve: () => prepared.execute(),
        restyle: preparedRestyle === null ? null : () => preparedRestyle.execute(),
      });

      if (!this.sourceGeneration.isCurrent(executionSourceGeneration)) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed before the upgrade could begin. Refresh and try again.',
          },
        });
        return;
      }
      if (!this.reservation.beginMutation(stored.eligibility.packageName)) return;
      const transaction = await runUpgradeTransaction({
        allowlistedPaths,
        files,
        manifestStage: {
          path: manifestPath,
          expectedContents: Buffer.from(disk.manifestText, 'utf8'),
          contents: Buffer.from(stagedManifest, 'utf8'),
        },
        install,
        ...(stored.verificationScripts.length === 0
          ? {}
          : {
              verifier: {
                verify: () =>
                  this.session.verify({
                    packageName: stored.eligibility.packageName,
                    cwd: controller.root,
                    packageManager: source.packageManager,
                    scripts: stored.verificationScripts,
                  }),
              },
              verificationFailureDecider: {
                decide: async () => {
                  if (this.options.isDisposed()) return 'rollback' as const;
                  const choice = await this.options.platform.showModalWarning(
                    'The dependency installed, but post-upgrade verification failed.',
                    'Rollback restores only package.json and the active lockfile captured by this upgrade transaction; ' +
                      'it does not restore node_modules or files changed by lifecycle/verification scripts.',
                    ['Rollback', 'Keep Changes']
                  );
                  return choice === 'Keep Changes' ? ('keep' as const) : ('rollback' as const);
                },
              },
            }),
      });

      let finalProject: ResolvedProject | undefined;
      let structurallyCurrent = false;
      let appliedState: ReturnType<typeof inspectAppliedUpgradeState> = {
        confirmed: false,
        changes: proposal.changes.map((change) => ({
          packageName: change.packageName,
          previousVersion: change.currentVersion,
          requestedVersion: change.targetVersion,
          currentVersion: null,
          declaredRange: null,
          classification: null,
        })),
      };
      try {
        if (this.options.readAndApplyMutationLocalState === undefined) {
          finalProject = await this.projectLoader(selected);
        } else {
          const localRead = await this.options.readAndApplyMutationLocalState();
          finalProject = localRead?.project;
          structurallyCurrent = localRead?.structurallyCurrent === true;
        }
        if (finalProject !== undefined) appliedState = inspectAppliedUpgradeState(finalProject, proposal.changes);
      } catch {
        // A successful task is not enough to claim the requested state was
        // applied. Keep the explicit unconfirmed result and let the normal
        // enrichment reload recover/display whatever can still be read.
      }

      const usedTargetedRefresh =
        finalProject !== undefined &&
        this.options.readAndApplyMutationLocalState !== undefined &&
        this.options.refreshMutationEnrichmentInBackground !== undefined;
      const refreshId = randomBytes(16).toString('hex');
      if (this.options.isDisposed()) return;

      const application: UpgradeResultPresentation['application'] = classifyUpgradeApplication(
        transaction.completion,
        structurallyCurrent,
        appliedState.confirmed
      );
      const verification: UpgradeResultPresentation['verification'] =
        transaction.verification.status === 'passed'
          ? 'passed'
          : transaction.verification.status === 'failed'
            ? 'failed'
            : transaction.verification.status === 'not-run' && transaction.verification.reason === 'not-configured'
              ? 'not-configured'
              : 'not-run';

      if (transaction.install.status === 'succeeded' || application === 'rolled-back') {
        this.options.sink.postMessage({
          status: 'upgrade-result',
          result: {
            package: stored.eligibility.packageName,
            refreshId,
            install: transaction.install.status === 'succeeded' ? 'succeeded' : 'failed',
            application,
            verification,
            changes: appliedState.changes,
            refreshingDerivedData: usedTargetedRefresh,
          },
        });
      }

      if (usedTargetedRefresh) {
        this.options.refreshMutationEnrichmentInBackground?.(
          refreshId,
          stored.eligibility.packageName,
          structurallyCurrent
        );
      } else if (!this.options.isDisposed()) {
        // Compatibility fallback for embedders/tests that have not supplied
        // the targeted-refresh hooks. The result above is still surfaced
        // before this potentially expensive scan.
        await this.options.reloadFinalState();
      }
      if (this.options.isDisposed()) return;

      const presentation = describeUpgradeTransactionOutcome(
        stored.eligibility.packageName,
        source.packageManager,
        transaction,
        structurallyCurrent && appliedState.confirmed
      );
      if (
        presentation.kind === 'verified' ||
        (presentation.kind === 'unverified' && transaction.verification.status === 'not-run')
      ) {
        this.options.platform.showInformationMessage(presentation.message);
      } else if (presentation.kind === 'error') {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: presentation.error,
        });
      } else {
        this.options.platform.showWarningMessage(presentation.message);
      }
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: stored.eligibility.packageName,
          error: toProtocolError(cause),
        });
      }
    } finally {
      await this.releaseReservation(stored.eligibility.packageName);
    }
  }

  /**
   * Execution phase for a removal: look up the stored analysis, re-run the same
   * disk-reread + eligibility recheck executeStoredAnalysis runs for an
   * upgrade, then stage package.json with the removed keys deleted and
   * reconcile via the same manifest-reconciliation path a mixed-
   * classification coordinated upgrade already uses. See
   * UpgradeExecutionSession.prepareManifestReconciliation, which accepts no
   * package/version input at all and simply reconciles whatever the host
   * already staged.
   */
  private async executeStoredRemoval(
    analysisId: string,
    optIn: VerificationOptInRequest = {},
    resultInDialog = false
  ): Promise<void> {
    const stored = this.removal;
    const now = Date.now();
    if (stored === undefined || stored.id !== analysisId || now >= stored.expiresAt) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored?.reservationKey ?? 'unknown',
        error: { code: 'STALE_ANALYSIS', message: 'This removal analysis is no longer current. Analyze again.' },
      });
      if (stored !== undefined && now >= stored.expiresAt) {
        this.removal = undefined;
        await this.releaseReservation(stored.reservationKey);
      }
      return;
    }
    if (!this.reserve(stored.reservationKey)) {
      this.options.sink.postMessage({
        status: 'remove-error',
        package: stored.reservationKey,
        error: {
          code: 'UPGRADE_IN_PROGRESS',
          message: 'Another dependency change is already in progress for this project.',
        },
      });
      return;
    }
    const executionSourceGeneration = this.sourceGeneration.capture();

    // Single-use: cleared now, regardless of outcome, so a retry always goes through a fresh handleAnalyzeBulkRemove.
    this.removal = undefined;

    const controller = await this.options.ensureController();
    if (controller === undefined) {
      await this.releaseReservation(stored.reservationKey);
      return;
    }

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;

      const disk = await this.projectLoader(selected);
      const sourceStillMatches =
        disk.root === controller.root &&
        disk.manifestText === stored.snapshot.manifestText &&
        disk.lockfileText === stored.snapshot.lockfileText &&
        disk.lockfilePath === stored.snapshot.lockfilePath &&
        disk.registry === stored.snapshot.registry &&
        disk.packageManager === stored.snapshot.packageManager &&
        (disk.otherPackageManager ?? null) === (stored.snapshot.otherPackageManager ?? null) &&
        disk.importerId === stored.snapshot.importerId;
      const rechecked = stored.requests.length === 0
        ? { ok: true as const }
        : controller.validateBulkRemoveRequest(stored.requests);
      if (!sourceStillMatches || !rechecked.ok) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project dependency files changed while the analysis was open. Refresh and try again.',
          },
        });
        return;
      }
      if (stored.smartCleanupEvidence !== undefined) {
        const capability = smartCleanupProjectCapability(controller.upgradeSource);
        if (!capability.executionSupported) {
          this.options.sink.postMessage({
            status: 'remove-error',
            package: stored.reservationKey,
            error: { code: 'NOT_ELIGIBLE', message: capability.reason },
          });
          return;
        }
        if (!stored.smartCleanupEvidence.isCurrent()) {
          this.options.sink.postMessage({
            status: 'remove-error',
            package: stored.reservationKey,
            error: {
              code: 'STALE_ANALYSIS',
              message: 'Project usage evidence changed while the Smart Cleanup review was open. Analyze again.',
            },
          });
          return;
        }
      }
      // `stored` was detached from this.removal above, so the accepted
      // opt-in only affects this one run.
      await applyVerificationOptIn(this.options.platform, stored, {
        currentSetting: this.options.platform.getSetting<unknown[]>('upgrade.verificationScripts', []),
        manifestText: disk.manifestText,
        request: optIn,
      });

      const source = controller.upgradeSource;
      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
      const allowlistedPaths = [manifestPath, expectedLockfilePath];

      const stagedManifest = stored.eligibilities.length === 0
        ? disk.manifestText
        : buildStagedManifestForRemoval(
            disk.manifestText,
            stored.eligibilities.map((item) => ({ packageName: item.packageName, classification: item.classification }))
          );
      const files = await createNodeUpgradeTransactionFileAdapter({
        workspaceRoot: selected.folder.path,
        allowlistedPaths,
      });

      const prepared = this.session.prepareManifestReconciliation({
        cwd: controller.root,
        importerId: source.importerId,
        ignoreScripts: stored.ignoreScripts,
        packageManager: source.packageManager,
      });
      if (!prepared.ok) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: { code: prepared.code, message: prepared.message },
        });
        return;
      }

      if (!this.sourceGeneration.isCurrent(executionSourceGeneration)) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project files changed before removal could begin. Refresh and try again.',
          },
        });
        return;
      }
      if (stored.smartCleanupEvidence !== undefined && !stored.smartCleanupEvidence.isCurrent()) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: {
            code: 'STALE_ANALYSIS',
            message: 'Project usage evidence changed before Smart Cleanup could begin. Analyze again.',
          },
        });
        return;
      }
      if (!this.reservation.beginMutation(stored.reservationKey)) return;
      const transaction = await runUpgradeTransaction({
        allowlistedPaths,
        files,
        ...(stored.eligibilities.length === 0
          ? {}
          : {
              manifestStage: {
                path: manifestPath,
                expectedContents: Buffer.from(disk.manifestText, 'utf8'),
                contents: Buffer.from(stagedManifest, 'utf8'),
              },
            }),
        install: {
          execute: async () => {
            this.options.sink.postMessage({ status: 'remove-progress', analysisId: stored.id, phase: 'installing' });
            const outcome = await prepared.execute();
            return outcome.ok
              ? { status: 'succeeded' as const }
              : { status: 'failed' as const, code: outcome.code, message: outcome.message };
          },
        },
        verifier: {
          verify: async () => {
            this.options.sink.postMessage({ status: 'remove-progress', analysisId: stored.id, phase: 'verifying' });
            const checks: Array<{ id: string; status: 'passed' | 'failed'; message?: string }> = [];
            try {
              const appliedManifestText = await readFile(manifestPath, 'utf8');
              const appliedLockfileText = await readFile(expectedLockfilePath, 'utf8');
              if (appliedManifestText !== stagedManifest) {
                checks.push({ id: 'smart-cleanup-structure', status: 'failed', message: 'package.json does not match the reviewed cleanup plan.' });
              } else {
                const appliedGraph = buildDependencyGraph({
                  root: controller.root,
                  manifest: parseManifest(appliedManifestText),
                  lockfileText: appliedLockfileText,
                  packageManager: source.packageManager,
                  importerId: source.importerId,
                });
                const direct = new Map(directNodes(appliedGraph).map((node) => [node.name, node.version]));
                const removalStillPresent = stored.eligibilities.find((item) => direct.has(item.packageName));
                const structuralFailure = removalStillPresent === undefined
                  ? null
                  : `${removalStillPresent.packageName} is still a direct dependency.`;
                checks.push(structuralFailure === null
                  ? { id: 'smart-cleanup-structure', status: 'passed' }
                  : { id: 'smart-cleanup-structure', status: 'failed', message: structuralFailure });
              }
            } catch (cause) {
              checks.push({
                id: 'smart-cleanup-structure',
                status: 'failed',
                message: `Could not verify the applied dependency graph: ${cause instanceof Error ? cause.message : String(cause)}`,
              });
            }
            if (checks.some((check) => check.status === 'failed')) {
              const message = checks.find((check) => check.status === 'failed')?.message;
              return {
                status: 'failed' as const,
                checks,
                ...(message === undefined ? {} : { message }),
              };
            }
            if (stored.verificationScripts.length === 0) return { status: 'passed' as const, checks };
            const scripts = await this.session.verify({
              packageName: stored.reservationKey,
              cwd: controller.root,
              packageManager: source.packageManager,
              scripts: stored.verificationScripts,
            });
            return scripts.status === 'passed'
              ? { status: 'passed' as const, checks: [...checks, ...scripts.checks] }
              : { ...scripts, checks: [...checks, ...scripts.checks] };
          },
        },
        verificationFailureDecider: {
          decide: async (result) => {
            if (result.checks.some((check) => check.id === 'smart-cleanup-structure' && check.status === 'failed')) {
              return 'rollback' as const;
            }
            if (this.options.isDisposed()) return 'rollback' as const;
            const choice = await this.options.platform.showModalWarning(
              'Cleanup was applied, but a configured verification check failed.',
              'Rollback restores only package.json and the active lockfile captured by this cleanup transaction; ' +
                'it does not restore node_modules or files changed by lifecycle/verification scripts.',
              ['Rollback', 'Keep Changes']
            );
            return choice === 'Keep Changes' ? ('keep' as const) : ('rollback' as const);
          },
        },
      });

      // Record the bytes a kept Smart Cleanup left on disk before anything
      // else can write, so a later restore can prove the files are unchanged.
      const restoreFiles =
        stored.smartCleanupRequestId !== undefined &&
        stored.eligibilities.length > 0 &&
        transaction.completion === 'kept' &&
        transaction.keptSnapshot !== undefined
          ? await captureSmartCleanupRestoreFiles(files, transaction.keptSnapshot)
          : undefined;

      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({ status: 'remove-progress', analysisId: stored.id, phase: 'refreshing' });
      }
      // Reload the kept/restored/partial state while the coordinator still owns the project-wide mutation lock.
      // Smart Cleanup also performs one bounded final reread so its report is
      // correlated to the exact source that produced the refreshed snapshot.
      const finalEvidence = !this.options.isDisposed() && stored.smartCleanupRequestId !== undefined
        ? await this.options.reloadSmartCleanupFinalState?.()
        : undefined;
      if (
        !this.options.isDisposed() &&
        (stored.smartCleanupRequestId === undefined || this.options.reloadSmartCleanupFinalState === undefined)
      ) {
        await this.options.reloadFinalState();
      }
      if (this.options.isDisposed()) return;

      const presentation = describeRemoveTransactionOutcome(
        stored.eligibilities.map((item) => item.packageName),
        source.packageManager,
        transaction
      );
      const removedPackages = stored.eligibilities.map((item) => item.packageName);
      // With no build or test scripts, only the dependency-file structure
      // check ran. That is not project verification, so it is not reported
      // as passed.
      const structureOnly = transaction.verification.status === 'passed' && stored.verificationScripts.length === 0;
      const verification =
        structureOnly
          ? 'not-configured'
          : transaction.verification.status === 'passed'
          ? 'passed'
          : transaction.verification.status === 'failed'
            ? 'failed'
            : transaction.verification.status === 'cancelled'
              ? 'not-run'
              : transaction.verification.reason === 'not-configured'
                ? 'not-configured'
                : 'not-run';
      const smartCleanupPresentation: SmartCleanupCompletionPresentation | undefined =
        stored.smartCleanupRequestId === undefined
          ? undefined
          : stored.smartCleanupBefore === undefined || finalEvidence === undefined
            ? {
                status: 'partial',
                metrics: [],
                removedAdvisories: [],
                introducedAdvisories: [],
                completedActionIds: [],
                skippedActionIds: [],
                failedActionIds: removedPackages.map((packageName) => `remove-direct:${packageName}`),
                reason: 'Fresh correlated dashboard evidence was unavailable after cleanup.',
              }
            : (() => {
                const refreshId = randomBytes(12).toString('hex');
                const actionStatus = presentation.kind === 'rolled-back' ? 'skipped' as const : 'completed' as const;
                const deprecatedDirectPackages = verifiedDeprecatedPackagesAfter(stored.smartCleanupBefore, finalEvidence);
                const afterEvidence: SmartCleanupFinalRefreshEvidence = {
                  ...finalEvidence,
                  ...(deprecatedDirectPackages === undefined ? {} : { deprecatedDirectPackages }),
                };
                const completion = buildSmartCleanupCompletionReport({
                  operation: {
                    requestId: stored.smartCleanupRequestId,
                    analysisId: stored.id,
                    projectId: stored.smartCleanupBefore.projectId,
                    refreshId,
                    sourceGeneration: stored.smartCleanupBefore.sourceGeneration,
                    sourceFingerprint: stored.smartCleanupBefore.sourceFingerprint,
                  },
                  before: stored.smartCleanupBefore,
                  after: {
                    ...afterEvidence,
                    requestId: stored.smartCleanupRequestId,
                    analysisId: stored.id,
                    refreshId,
                  },
                  actions: [
                    ...removedPackages.map((packageName) => {
                      const removed = !afterEvidence.snapshot.rows.some((row) => row.name === packageName);
                      return {
                        actionId: `remove-direct:${packageName}`,
                        packageName,
                        status: presentation.kind === 'rolled-back' ? 'skipped' as const : removed ? actionStatus : 'failed' as const,
                        ...(presentation.kind === 'rolled-back'
                          ? { message: 'Project dependency files were restored.' }
                          : removed
                            ? {}
                            : { message: 'The dependency still appears in the refreshed project inventory.' }),
                      };
                    }),
                  ],
                });
                return toSmartCleanupCompletionPresentation(completion, stored.smartCleanupBefore, afterEvidence);
              })();
      const keepRestorePoint = (): { restoreAvailable?: true } => {
        if (restoreFiles === undefined || smartCleanupPresentation === undefined) return {};
        this.smartCleanupRestore = {
          analysisId: stored.id,
          projectId: selected.id,
          projectRoot: controller.root,
          packageManager: source.packageManager,
          ignoreScripts: stored.ignoreScripts,
          packages: removedPackages,
          reservationKey: stored.reservationKey,
          adapter: files,
          files: restoreFiles,
        };
        this.smartCleanupRestoreDropped = undefined;
        return { restoreAvailable: true };
      };
      if (presentation.kind === 'verified') {
        const message = structureOnly
          ? `Removed ${describeRemovedPackages(removedPackages)}. Dependency files were checked. No build or test scripts ran.`
          : presentation.message;
        this.options.sink.postMessage({
          status: 'remove-result',
          result: {
            analysisId: stored.id,
            packages: removedPackages,
            outcome: 'verified',
            verification,
            rollback: 'not-needed',
            message,
            ...(smartCleanupPresentation === undefined ? {} : { smartCleanup: smartCleanupPresentation }),
            ...keepRestorePoint(),
          },
        });
        // The Manage dialog that started this removal shows the result itself.
        if (!resultInDialog) this.options.platform.showInformationMessage(message);
      } else if (presentation.kind === 'error') {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: presentation.error,
        });
      } else {
        if (presentation.kind === 'unverified' || presentation.kind === 'rolled-back') {
          this.options.sink.postMessage({
            status: 'remove-result',
            result: {
              analysisId: stored.id,
              packages: removedPackages,
              outcome: presentation.kind,
              verification,
              rollback: presentation.kind === 'rolled-back' ? 'succeeded' : 'not-needed',
              message: presentation.message,
              ...(smartCleanupPresentation === undefined ? {} : { smartCleanup: smartCleanupPresentation }),
              ...(presentation.kind === 'unverified' ? keepRestorePoint() : {}),
            },
          });
        }
        if (!resultInDialog) this.options.platform.showWarningMessage(presentation.message);
      }
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'remove-error',
          package: stored.reservationKey,
          error: toProtocolError(cause),
        });
      }
    } finally {
      await this.releaseReservation(stored.reservationKey);
    }
  }
}
