import { DialogFooterActions } from './DialogFooter.js';
import { memo, useContext, useRef } from 'react';
import type { ReactElement, RefObject } from 'react';

import { UpgradeSecurityAcknowledgement, useUpgradeSecurityAcknowledgement } from './UpgradeSecurityAcknowledgement.js';
import type { PackageRow } from '../../../src/core/types.js';
import { noUpgradeExplanation } from '../../../src/host/upgradeAction.js';
import { upgradeConfirmationAction } from '../../../src/host/actionButtonSemantics.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { hasPlannerAddedCoordination, upgradeAnalysisFreshness } from '../../../src/host/upgradeReviewUiState.js';
import {
  IconRefresh,
  IconTrendUp,
} from '../icons.js';
import { DirectionalButton } from './DirectionalButton.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import {
  CompatibilityCheckCard,
  CoordinatedUpgradePlanCard,
  CoordinationUnavailableCard,
  SecurityOutcomeCard,
  SimpleUpgradePlanCard,
  VerificationStepsCard,
} from './UpgradeAnalysisCards.js';
import { buildUpgradeReviewSignals, UpgradeAnalysisSections, UpgradeReviewDisclosure } from './UpgradeAnalysisSections.js';
import type { UpgradeReviewArea, UpgradeReviewSignal, UpgradeReviewTone as ReviewTone } from './UpgradeAnalysisSections.js';
import { ProjectCompatibilitySection } from './ProjectCompatibilitySection.js';
import { UpgradeDecisionBrief } from './UpgradeReviewSummary.js';
import { ChangeApplyingLoading, upgradeApplyingLabel, useApplyingFailureFocus } from './AnalysisLoading.js';
import { UpgradeReviewAnnouncement } from './UpgradeAnalysisLoading.js';
import { StatusBanner } from './StatusBanner.js';
import { UpgradeTargetSelector } from './UpgradeTargetSelector.js';
import { selectedSuggestions, VerificationOptInContext } from './VerificationSuggestions.js';
import type { UpgradeTargetLoadState } from './UpgradeTargetSelector.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';

/**
 * This is the evidence-heavy half of a completed review. It does not depend
 * on the freshness clock, so memoizing it avoids reconciling compatibility
 * findings, vulnerability paths, and verification rows every minute while
 * the surrounding freshness/action chrome still updates normally.
 */
const UpgradeReviewDetails = memo(function UpgradeReviewDetails({
  row,
  analysis,
  coordinated,
  signals,
  sectionRefs,
  onChangeTab,
  onOpenAdvisory,
  onOpenUsageReference,
  onConfigureVerification,
}: {
  row: PackageRow;
  analysis: UpgradeAnalysisPresentation;
  coordinated: boolean;
  signals: readonly UpgradeReviewSignal[];
  sectionRefs: Readonly<Record<UpgradeReviewArea, RefObject<HTMLDetailsElement | null>>>;
  onChangeTab: (tab: ManageTabId) => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
  onConfigureVerification: () => void;
}): ReactElement {
  const signal = (area: UpgradeReviewSignal['area']): UpgradeReviewSignal => {
    const match = signals.find((entry) => entry.area === area);
    if (match === undefined) throw new Error(`Missing upgrade review signal for ${area}`);
    return match;
  };
  const dependency = signal('dependency');
  const project = signal('project');
  const security = signal('security');
  const verification = signal('verification');
  const planTone: ReviewTone = analysis.compatibility.status === 'conflict' && !coordinated
    ? 'error'
    : coordinated
      ? 'warning'
      : 'neutral';
  const planValue = coordinated
    ? `${analysis.smartPlan?.changes.length ?? analysis.changes.length} coordinated ${analysis.smartPlan?.changes.length === 1 ? 'change' : 'changes'}`
    : analysis.compatibility.status === 'conflict'
      ? 'No coordinated resolution'
      : `${analysis.changes.length} selected ${analysis.changes.length === 1 ? 'change' : 'changes'}`;

  return (
    <div className="upgrade-tab__details">
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.dependency}
        label={dependency.label}
        value={dependency.value}
        tone={dependency.tone}
      >
        <CompatibilityCheckCard
          compatibility={analysis.compatibility}
          projectCompatibility={analysis.projectCompatibility}
          context={{ package: row.name, currentVersion: analysis.currentVersion }}
        />
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.project}
        label={project.label}
        value={project.value}
        tone={project.tone}
      >
        <ProjectCompatibilitySection analysis={analysis.projectCompatibility} onOpenUsageReference={onOpenUsageReference} />
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.security}
        label={security.label}
        value={security.value}
        tone={security.tone}
      >
        {analysis.security !== null ? (
          <SecurityOutcomeCard row={row} security={analysis.security} onChangeTab={onChangeTab} onOpenAdvisory={onOpenAdvisory} />
        ) : (
          <p className="usage-card__subtitle">Security check unavailable</p>
        )}
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.plan}
        label="Planned dependency changes"
        value={planValue}
        tone={planTone}
      >
        {analysis.smartPlan !== null && coordinated ? (
          <CoordinatedUpgradePlanCard
            requestedChanges={analysis.changes}
            smartPlan={analysis.smartPlan}
            compatibility={analysis.compatibility}
          />
        ) : analysis.compatibility.status === 'conflict' ? (
          <CoordinationUnavailableCard row={row} changes={analysis.changes} />
        ) : (
          <SimpleUpgradePlanCard changes={analysis.changes} />
        )}
      </UpgradeReviewDisclosure>
      <UpgradeReviewDisclosure
        sectionRef={sectionRefs.verification}
        label={verification.label}
        value={verification.value}
        tone={verification.tone}
      >
        <VerificationStepsCard
          analysisId={analysis.analysisId}
          verification={analysis.verification}
          onConfigureVerification={onConfigureVerification}
        />
      </UpgradeReviewDisclosure>
    </div>
  );
});

function formatUpgradeAnalysisAge(analyzedAt: string, now: number): string {
  const timestamp = Date.parse(analyzedAt);
  if (!Number.isFinite(timestamp)) return 'previously';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ago`;
}

/** Age alone recommends refresh. Host-issued expiry or structural staleness blocks confirmation. */
function UpgradeFreshnessBar({
  analyzedAt,
  expiresAt,
  hardStale,
  now,
  onRefresh,
}: {
  analyzedAt: string;
  expiresAt: string;
  hardStale: boolean;
  now: number;
  onRefresh: () => void;
}): ReactElement | null {
  const freshness = upgradeAnalysisFreshness(analyzedAt, expiresAt, now);
  const expired = freshness === 'expired';
  if (freshness === 'fresh' && !hardStale) return null;
  return (
    <p className={`stale-status${hardStale || expired ? ' stale-status--hard' : ''}`}>
      <IconRefresh className="stale-status__icon stale-status__icon--static" />
      {hardStale
        ? 'Project files changed since this analysis ran. Refresh before continuing.'
        : expired
          ? 'This analysis expired and can no longer authorize an upgrade. Analyze again to continue.'
          : `Analysis is more than one hour old. Refresh is recommended. Project files have not been marked as changed. Last analyzed ${formatUpgradeAnalysisAge(analyzedAt, now)}.`}
      <button type="button" className="button button--subtle stale-status__action" onClick={onRefresh}>
        {expired ? 'Analyze again' : 'Refresh'}
      </button>
    </p>
  );
}

/**
 * The Upgrade review tab: the same host-owned review/confirm experience
 * UpgradeAnalysisModal renders for a bulk upgrade, presented here as a
 * decision brief followed by prioritized evidence and recommendation guidance.
 * UpgradeAnalysisBody remains the shared body used by the bulk-upgrade modal.
 * `active` is true exactly when this row's upgrade is the one App.tsx
 * currently has loaded (`upgradeOrigin === 'manage-dependency' &&
 * activeUpgrade === row.name`): false means either nothing has been
 * analyzed yet, or the target version is simply displayed from `row` while
 * waiting for "Analyze upgrade" to be clicked.
 */
export function UpgradeReviewPanel({
  row,
  active,
  targetVersion,
  targetState,
  analysis,
  sections,
  hardStale,
  now,
  busy,
  error,
  disabled,
  usage,
  advisoriesAvailable,
  advisoriesOff = false,
  onAnalyzeUpgrade,
  onTargetChange,
  onConfirm,
  onUseSmartPlan,
  onCancel,
  onConfigureVerification,
  onRefresh,
  onRetryTargets,
  onRefreshDashboard,
  updateResolutionAvailable = true,
  refreshDisabled,
  onChangeTab,
  onOpenAdvisory,
  onOpenUsageReference,
}: {
  row: PackageRow;
  active: boolean;
  /** The upgrade target this row currently offers, or null when none is available. */
  targetVersion: string | null;
  targetState: UpgradeTargetLoadState;
  analysis: UpgradeAnalysisPresentation | null;
  /** Streamed progress is never used to reveal results before the final message. */
  sections: UpgradeAnalysisSectionsState;
  /** True when the host has flagged `analysis` as structurally stale. See UpgradeFreshnessBar. */
  hardStale: boolean;
  now: number;
  busy: boolean;
  error: string | null;
  disabled: boolean;
  usage: UsageRequestState | undefined;
  advisoriesAvailable: boolean;
  advisoriesOff?: boolean;
  onAnalyzeUpgrade: (target: string) => void;
  onTargetChange: (target: string) => void;
  onConfirm: (securityAcknowledged?: boolean) => void;
  onUseSmartPlan: (securityAcknowledged?: boolean) => void;
  onCancel: () => void;
  onConfigureVerification: () => void;
  onRefresh: () => void;
  /** Loads the version list again after it failed. */
  onRetryTargets?: (() => void) | undefined;
  /** Refreshes the dashboard when the version list failed because the project changed. */
  onRefreshDashboard?: (() => void) | undefined;
  /** False when this package's update check failed in the last scan. */
  updateResolutionAvailable?: boolean;
  /**
   * Disables the Refresh buttons (the dashboard's own rule). Separate from
   * `disabled`: upgrades are disabled after an incomplete scan, which is
   * exactly when Refresh is needed. Retry keeps `disabled`.
   */
  refreshDisabled?: boolean;
  onChangeTab: (tab: ManageTabId) => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  const consent = useUpgradeSecurityAcknowledgement(analysis);
  const { reviewRef, loadingRef } = useApplyingFailureFocus(busy, error);
  const verificationOptIn = useContext(VerificationOptInContext);
  const dependencyRef = useRef<HTMLDetailsElement>(null);
  const projectRef = useRef<HTMLDetailsElement>(null);
  const securityRef = useRef<HTMLDetailsElement>(null);
  const planRef = useRef<HTMLDetailsElement>(null);
  const verificationRef = useRef<HTMLDetailsElement>(null);
  const sectionRefs: Readonly<Record<UpgradeReviewArea, RefObject<HTMLDetailsElement | null>>> = {
    dependency: dependencyRef,
    project: projectRef,
    security: securityRef,
    plan: planRef,
    verification: verificationRef,
  };
  const openReviewArea = (area: UpgradeReviewArea): void => {
    const section = sectionRefs[area].current;
    if (section === null) return;
    section.open = true;
    requestAnimationFrame(() => {
      section.scrollIntoView({ block: 'start' });
      section.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    });
  };
  const targetSelector = row.upgradeTo === null ? null : (
    <UpgradeTargetSelector
      registryName={row.registryName ?? row.name}
      state={targetState}
      selectedVersion={targetVersion}
      fallbackVersion={row.upgradeTo}
      fallbackReason={row.upgradeReason}
      disabled={busy || disabled}
      {...(refreshDisabled === undefined ? {} : { refreshDisabled })}
      onChange={onTargetChange}
      {...(onRetryTargets === undefined ? {} : { onRetry: onRetryTargets })}
      {...(onRefreshDashboard === undefined ? {} : { onRefreshDashboard })}
    />
  );
  const withTargetSelector = (content: ReactElement): ReactElement => (
    <div ref={reviewRef} className="upgrade-review-stack">
      {targetSelector}
      <UpgradeReviewAnnouncement analysis={analysis} advisoriesOff={advisoriesOff} />
      {error !== null && (!active || analysis !== null) ? (
        <StatusBanner
          tone="error"
          className="upgrade-review__error"
          action={{
            label: 'Retry',
            onClick: onRefresh,
            disabled: busy || disabled,
            icon: <IconRefresh />,
          }}
        >
          {error}
        </StatusBanner>
      ) : null}
      {content}
    </div>
  );

  if (!active) {
    if (row.upgradeTo === null) {
      const noUpgrade = noUpgradeExplanation(row, updateResolutionAvailable);
      return withTargetSelector(
        <div className="review-panel__empty review-panel__empty--upgrade">
          <span className="review-panel__empty-icon" aria-hidden="true">
            <IconTrendUp />
          </span>
          <h3 className="review-panel__empty-heading">Upgrade review</h3>
          <p className="review-panel__empty-versions">{row.current ?? row.range}</p>
          <p className="review-panel__empty-status">{noUpgrade.text}</p>
          {noUpgrade.refresh && onRefreshDashboard !== undefined ? (
            <button type="button" className="button button--secondary" disabled={refreshDisabled ?? disabled} onClick={onRefreshDashboard}>
              Refresh
            </button>
          ) : null}
        </div>
      );
    }
    if (targetVersion === null) {
      return withTargetSelector(
        <div className="manage-panel-empty">
          <p>Choose a target version to continue.</p>
        </div>
      );
    }
    return withTargetSelector(
      <div className="review-panel__empty review-panel__empty--upgrade">
        <span className="review-panel__empty-icon" aria-hidden="true">
          <IconTrendUp />
        </span>
        <h3 className="review-panel__empty-heading">Upgrade review</h3>
        <p className="review-panel__empty-versions">
          {row.current ?? row.range}
          <span aria-hidden="true"> → </span>
          {targetVersion}
        </p>
        <p className="review-panel__empty-status">Not analyzed yet</p>
        <DialogFooterActions key="review-footer">
          <DirectionalButton
          direction="forward"
          className="button button--primary button--upgrade"
          disabled={busy || disabled || targetState.phase === 'loading'}
          onClick={() => onAnalyzeUpgrade(targetVersion)}
        >
          Analyze upgrade
        </DirectionalButton>
        </DialogFooterActions>
      </div>
    );
  }

  // An active request always records a concrete target before posting to the
  // host. This branch is defensive for an impossible state transition.
  if (targetVersion === null) {
    return withTargetSelector(
      <div className="manage-panel-empty">
        <p>Choose a target version and analyze again.</p>
      </div>
    );
  }

  if (analysis === null) {
    return withTargetSelector(
      <div className="review-panel">
        <UpgradeDecisionBrief row={row} targetVersion={targetVersion} analysis={null} coordinated={false} signals={[]} usage={usage} onOpenArea={openReviewArea} error={error} onRetry={onRefresh} retryDisabled={busy || disabled} />
        {error === null ? <UpgradeAnalysisSections sections={sections} /> : null}
        <DialogFooterActions key="review-footer">
          <button type="button" className="button button--secondary" onClick={onCancel}>Cancel</button>
        </DialogFooterActions>
      </div>
    );
  }

  if (busy) {
    return withTargetSelector(<div className="review-panel">
      <ChangeApplyingLoading loadingRef={loadingRef} label={upgradeApplyingLabel(analysis.smartPlan !== null && hasPlannerAddedCoordination(analysis.changes, analysis.smartPlan.changes) ? analysis.smartPlan.changes : analysis.changes)} />
      <DialogFooterActions key="review-footer">
        <button type="button" className="button button--secondary" disabled onClick={onCancel}>Close review</button>
      </DialogFooterActions>
    </div>);
  }

  const coordinated =
    analysis.smartPlan !== null && hasPlannerAddedCoordination(analysis.changes, analysis.smartPlan.changes);
  const expired = upgradeAnalysisFreshness(analysis.analyzedAt, analysis.expiresAt, now) === 'expired';
  const executionBlocked = hardStale || expired;
  const action = upgradeConfirmationAction(coordinated ? analysis : { ...analysis, smartPlan: null });
  const signals = buildUpgradeReviewSignals(
    analysis,
    advisoriesAvailable,
    advisoriesOff,
    selectedSuggestions(analysis.verification, verificationOptIn.selectionFor(analysis.analysisId))
  );

  return withTargetSelector(
    <div className="review-panel">
      <UpgradeFreshnessBar
        analyzedAt={analysis.analyzedAt}
        expiresAt={analysis.expiresAt}
        hardStale={hardStale}
        now={now}
        onRefresh={onRefresh}
      />
      <UpgradeDecisionBrief
        row={row}
        targetVersion={targetVersion}
        analysis={analysis}
        coordinated={coordinated}
        advisoriesOff={advisoriesOff}
        signals={signals}
        usage={usage}
        onOpenArea={openReviewArea}
      />
      <div className="upgrade-tab">
        <UpgradeReviewDetails
          row={row}
          analysis={analysis}
          coordinated={coordinated}
          signals={signals}
          sectionRefs={sectionRefs}
          onChangeTab={onChangeTab}
          onOpenAdvisory={onOpenAdvisory}
          onOpenUsageReference={onOpenUsageReference}
          onConfigureVerification={onConfigureVerification}
        />
      </div>

      <UpgradeSecurityAcknowledgement consent={consent} />
      <DialogFooterActions key="review-footer">
        <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
          Close review
        </button>
        {action !== null ? (
          <button
            type="button"
            className="button button--primary button--upgrade"
            onClick={() => (action.onClick === 'confirm' ? onConfirm : onUseSmartPlan)(consent.acknowledged)}
            disabled={busy || executionBlocked || consent.blocked}
          >
            {action.label}
          </button>
        ) : null}
      </DialogFooterActions>
    </div>
  );
}
