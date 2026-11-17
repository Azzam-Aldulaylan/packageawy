import { ChangeApplyingLoading, upgradeApplyingLabel, useApplyingFailureFocus } from './AnalysisLoading.js';
import { DependencyChangeStatus } from './DependencyChangeStatus.js';
import { memo, useCallback, useContext, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import { UpgradeSecurityAcknowledgement, useUpgradeSecurityAcknowledgement } from './UpgradeSecurityAcknowledgement.js';
import { semanticButtonClassName, upgradeConfirmationAction } from '../../../src/host/actionButtonSemantics.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { hasPlannerAddedCoordination, upgradeAnalysisFreshness } from '../../../src/host/upgradeReviewUiState.js';
import { dependencyWarningCount } from '../../../src/host/upgradeReviewDecision.js';
import { trapFocus } from '../focusTrap.js';
import { IconRefresh, IconX } from '../icons.js';
import { CompatibilitySection } from './CompatibilitySection.js';
import { ProjectCompatibilitySection } from './ProjectCompatibilitySection.js';
import { SecuritySection } from './SecuritySection.js';
import { SmartPlanSection } from './SmartPlanSection.js';
import { UpgradeDecisionBrief } from './UpgradeReviewSummary.js';
import { buildUpgradeReviewSignals } from './UpgradeAnalysisSections.js';
import type { UpgradeReviewArea } from './UpgradeAnalysisSections.js';
import { UpgradeReviewAnnouncement, UpgradeAnalysisLoading } from './UpgradeAnalysisLoading.js';
import { VerificationSection } from './VerificationSection.js';
import { selectedSuggestions, VerificationOptInContext } from './VerificationSuggestions.js';

/**
 * The one headline the whole modal commits to: everything else (the
 * Compatibility card's findings, Security's vulnerability list)
 * explains why, but never repeats what the overall answer is. The status
 * line sits here, directly under the header, as the one place a 2-second read answers
 * "is this upgrade OK".
 */
export function overallStatusDetail(analysis: { compatibility: UpgradeAnalysisPresentation['compatibility'] }): string | undefined {
  const { compatibility } = analysis;
  if (compatibility.completeness === 'partial') return 'Some compatibility checks could not be completed.';
  if (compatibility.status === 'compatible') return 'No blocking dependency conflicts were detected.';
  if (compatibility.status === 'warning') {
    const count = dependencyWarningCount(compatibility);
    return count > 0
      ? `Review ${count} dependency ${count === 1 ? 'warning' : 'warnings'} before upgrading.`
      : 'Review the dependency warning details before upgrading.';
  }
  if (compatibility.status === 'conflict') return 'Another dependency blocks this upgrade.';
  return undefined;
}

/**
 * The bulk modal body shares its summary and loading placeholders with the
 * single-package review. Only the final host analysis supplies result cards.
 */
function UpgradeAnalysisBodyContent({
  packageName,
  targetVersion,
  currentVersion,
  analysis,
  error = null,
  onRetry,
  retryDisabled = false,
  onOpenAdvisory,
  onOpenUsageReference,
  onConfigureVerification,
  publisherLtsByPackage,
  advisoriesOff = false,
  onOpenArea,
}: {
  packageName: string;
  targetVersion: string;
  currentVersion: string;
  error?: string | null;
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean;
  analysis: UpgradeAnalysisPresentation | null;
  advisoriesOff?: boolean;
  onOpenArea: (area: UpgradeReviewArea) => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[], reference?: string) => void;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
  onConfigureVerification: () => void;
  publisherLtsByPackage?: ReadonlyMap<string, string> | undefined;
}): ReactElement {
  const securityNeedsAttention = analysis?.security?.status === 'remains';
  const verificationOptIn = useContext(VerificationOptInContext);
  const summary = <UpgradeDecisionBrief
    row={{ name: packageName, current: currentVersion, range: currentVersion }}
    targetVersion={targetVersion}
    analysis={analysis}
    advisoriesOff={advisoriesOff}
    coordinated={analysis?.smartPlan != null && hasPlannerAddedCoordination(analysis.changes, analysis.smartPlan.changes)}
    signals={analysis === null ? [] : buildUpgradeReviewSignals(
      analysis, true, advisoriesOff,
      selectedSuggestions(analysis.verification, verificationOptIn.selectionFor(analysis.analysisId))
    )}
    usage={undefined}
    showUsage={false}
    error={error}
    onRetry={onRetry}
    retryDisabled={retryDisabled}
    onOpenArea={onOpenArea}
  />;
  if (analysis === null) return <>{summary}{error === null ? <UpgradeAnalysisLoading /> : null}</>;

  return (
    <>
      {summary}

      {analysis.smartPlan !== null && hasPlannerAddedCoordination(analysis.changes, analysis.smartPlan.changes) ? (
        <SmartPlanSection
          requestedChanges={analysis.changes}
          smartPlan={analysis.smartPlan}
          compatibility={analysis.compatibility}
        />
      ) : null}

      {analysis.changes.length > 1 || publisherLtsByPackage?.has(packageName) === true ? (
        <section className="analysis-card analysis-card--full" aria-labelledby="analysis-selected-upgrades-heading">
          <h3 className="analysis-card__title" id="analysis-selected-upgrades-heading">Selected upgrades</h3>
          <ol className="smart-plan__changes">
            {analysis.changes.map((change) => (
              <li className="smart-plan__change" key={change.packageName}>
                <span className="smart-plan__package">{change.packageName}</span>
                <span className="smart-plan__versions">{change.currentVersion} → {change.targetVersion}</span>
                {publisherLtsByPackage?.has(change.packageName) === true ? (
                  <span className="upgrade-target-picker__meta">Publisher LTS {publisherLtsByPackage.get(change.packageName)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="modal__grid">
        <div className="analysis-review-area" data-review-area="dependency" tabIndex={-1}>
          <CompatibilitySection
            compatibility={analysis.compatibility}
            context={{ package: analysis.package, currentVersion: analysis.currentVersion }}
          />
        </div>
        <div className="analysis-review-area" data-review-area="project" tabIndex={-1}>
          <ProjectCompatibilitySection analysis={analysis.projectCompatibility} onOpenUsageReference={onOpenUsageReference} />
        </div>
        <div className="analysis-review-area" data-review-area="security" tabIndex={-1}>
          <SecuritySection
            security={analysis.security}
            rootPackageName={analysis.package}
            onOpenAdvisory={onOpenAdvisory}
            emphasize={securityNeedsAttention}
            advisoriesOff={advisoriesOff}
          />
        </div>
        <div className="analysis-review-area" data-review-area="verification" tabIndex={-1}>
          <VerificationSection
            analysisId={analysis.analysisId}
            verification={analysis.verification}
            onConfigureVerification={onConfigureVerification}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The app-wide minute clock updates freshness chrome even when the analysis
 * evidence itself is unchanged. Keep the potentially large compatibility,
 * security, and dependency-path result tree out of those periodic renders.
 */
export const UpgradeAnalysisBody = memo(UpgradeAnalysisBodyContent);

/**
 * The Upgrade Analysis / confirmation experience: a centered dialog inside
 * the dashboard webview, replacing the native `showWarningMessage` modal.
 * `analysis === null` renders the loading phase. Once it arrives, the modal
 * never mutates its contents: it only ever echoes `analysis.analysisId`
 * back in confirm/cancel/use-smart-plan (see webviewProtocol.ts on
 * why the webview never constructs execution authority). Used only for the
 * bulk-upgrade flow. The embedded single-package review uses the same
 * summary and final-result reveal in UpgradeReviewPanel.tsx.
 */
export function UpgradeAnalysisModal({
  packageName,
  targetVersion,
  currentVersion = 'Unknown',
  error = null,
  analysis,
  busy,
  hardStale,
  now,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onRefresh,
  onConfigureVerification,
  onOpenAdvisory,
  onOpenUsageReference,
  pendingChanges,
  publisherLtsByPackage,
  advisoriesOff = false,
}: {
  packageName: string;
  targetVersion: string;
  currentVersion?: string;
  error?: string | null;
  analysis: UpgradeAnalysisPresentation | null;
  advisoriesOff?: boolean;
  busy: boolean;
  hardStale: boolean;
  now: number;
  onConfirm: (securityAcknowledged?: boolean) => void;
  onUseSmartPlan: (securityAcknowledged?: boolean) => void;
  onCancel: () => void;
  onRefresh: () => void;
  onConfigureVerification: () => void;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[], reference?: string) => void;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
  pendingChanges?: readonly { packageName: string; targetVersion: string }[];
  publisherLtsByPackage?: ReadonlyMap<string, string>;
}): ReactElement {
  const consent = useUpgradeSecurityAcknowledgement(analysis);
  const { reviewRef, loadingRef } = useApplyingFailureFocus(busy, error);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const openReviewArea = useCallback((area: UpgradeReviewArea): void => {
    const section = dialogRef.current?.querySelector<HTMLElement>(`[data-review-area="${area}"]`);
    section?.scrollIntoView({ block: 'start' });
    section?.focus({ preventScroll: true });
  }, []);

  // Focus trap + initial focus + restoration: a hand-rolled dialog pattern
  // rather than a library: this is the one interactive overlay in the whole
  // webview, and the CSP already forbids pulling in a remote dependency.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    return node === null ? undefined : trapFocus(node);
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Never closable mid-execution: a Task is already running and
        // rollback semantics, not a client-side dismiss, own that outcome.
        if (!busy) {
          event.preventDefault();
          onCancel();
        }
        return;
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  const coordinated =
    analysis?.smartPlan !== null && analysis?.smartPlan !== undefined
      ? hasPlannerAddedCoordination(analysis.changes, analysis.smartPlan.changes)
      : false;
  const action = analysis !== null
    ? upgradeConfirmationAction(coordinated ? analysis : { ...analysis, smartPlan: null })
    : null;
  const freshness = analysis === null ? 'fresh' : upgradeAnalysisFreshness(analysis.analyzedAt, analysis.expiresAt, now);
  const expired = freshness === 'expired';
  const executionBlocked = hardStale || expired;
  const displayedChanges = analysis?.changes ?? pendingChanges ?? [{ packageName, targetVersion }];
  const bulk = displayedChanges.length > 1;
  const majorCount = analysis?.changes.filter((change) => change.majorUpdate).length ?? 0;

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-analysis-title"
        ref={dialogRef}
      >
        <header className="modal__header">
          <div className="modal__header-text">
            <p className="modal__eyebrow">Review upgrade</p>
            <h2 className="modal__title" id="upgrade-analysis-title">
              {bulk ? `${displayedChanges.length} dependency upgrades` : packageName}
            </h2>
            {!bulk ? <p className="modal__version-line">
              <span className="modal__version modal__version--from">{analysis?.currentVersion ?? currentVersion}</span>
              <span className="modal__version-arrow" aria-hidden="true">
                →
              </span>
              <span className="modal__version modal__version--to">{targetVersion}</span>
            </p> : null}
            {majorCount > 0 || analysis?.majorUpdate === true ? (
              <div className="modal__badges">
                <span className="status-badge status-badge--warning">
                  {bulk ? `${majorCount} major update${majorCount === 1 ? '' : 's'}` : 'Major update'}
                </span>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onCancel}
            disabled={busy}
            ref={closeButtonRef}
            aria-label="Cancel upgrade"
          >
            <IconX />
          </button>
        </header>

        <div ref={reviewRef} className="modal__body">
          <UpgradeReviewAnnouncement analysis={analysis} advisoriesOff={advisoriesOff} />
          <DependencyChangeStatus />
          {analysis !== null && (freshness !== 'fresh' || hardStale) ? (
            <p className={`stale-status${hardStale || expired ? ' stale-status--hard' : ''}`}>
              <IconRefresh className="stale-status__icon stale-status__icon--static" />
              {hardStale
                ? 'Project files changed since this analysis ran. Refresh before continuing.'
                : expired
                  ? 'This analysis expired and can no longer authorize an upgrade. Analyze again to continue.'
                  : 'Analysis is more than one hour old. Refresh is recommended. Project files have not been marked as changed.'}
              <button type="button" className="button button--subtle stale-status__action" onClick={onRefresh}>
                {expired ? 'Analyze again' : 'Refresh'}
              </button>
            </p>
          ) : null}
          {busy && analysis !== null ? <ChangeApplyingLoading loadingRef={loadingRef} label={upgradeApplyingLabel(coordinated && analysis.smartPlan !== null ? analysis.smartPlan.changes : analysis.changes)} /> : <UpgradeAnalysisBody
            error={error}
            onRetry={error === null ? undefined : onRefresh}
            retryDisabled={busy}
            packageName={packageName}
            targetVersion={targetVersion}
            currentVersion={currentVersion}
            analysis={analysis}
            onOpenAdvisory={onOpenAdvisory}
            onOpenUsageReference={onOpenUsageReference}
            onConfigureVerification={onConfigureVerification}
            publisherLtsByPackage={publisherLtsByPackage}
            advisoriesOff={advisoriesOff}
            onOpenArea={openReviewArea}
          />}
          {!busy ? <UpgradeSecurityAcknowledgement consent={consent} /> : null}
        </div>

        <footer className="modal__footer">
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            {analysis !== null && analysis.compatibility.status === 'conflict' && !coordinated
              ? 'Close'
              : 'Cancel'}
          </button>
          {action !== null ? (
            <button
              type="button"
              className={semanticButtonClassName(action.variant)}
              onClick={() => (action.onClick === 'confirm' ? onConfirm : onUseSmartPlan)(consent.acknowledged)}
              disabled={busy || analysis === null || executionBlocked || consent.blocked}
            >
              {action.label}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
