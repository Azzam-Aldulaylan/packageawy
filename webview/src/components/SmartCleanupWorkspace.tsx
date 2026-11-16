import { useContext, useEffect, useId, useRef } from 'react';
import { DependencyChangeContext, DependencyChangeStatus } from './DependencyChangeStatus.js';
import type { Dispatch, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';

import type { RemoveAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { trapFocus } from '../focusTrap.js';
import {
  IconAlertTriangle,
  IconBroom,
  IconCheck,
  IconChevronRight,
  IconHelpCircle,
  IconHistory,
  IconRefresh,
  IconShield,
  IconTrash,
  IconX,
  IconXCircle,
} from '../icons.js';
import {
  canCloseSmartCleanup,
  selectedSmartCleanupRecommendations,
  SMART_CLEANUP_MAX_ACTIONS,
} from '../smartCleanupState.js';
import type {
  SmartCleanupAction,
  SmartCleanupConfidence,
  SmartCleanupDeprecatedFinding,
  SmartCleanupRemovalRecommendation,
  SmartCleanupRestoreState,
  SmartCleanupResult,
  SmartCleanupResultAdvisory,
  SmartCleanupSecurityFinding,
  SmartCleanupState,
} from '../smartCleanupState.js';
import { SmartCleanupCategorySection } from './SmartCleanupCategorySection.js';
import { SmartCleanupFindingList } from './SmartCleanupFindingList.js';
import { DirectionalButton } from './DirectionalButton.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import { SeverityBadge } from './SeverityBadge.js';
import { StatusBanner } from './StatusBanner.js';
import { VerificationSuggestions } from './VerificationSuggestions.js';

const CONFIDENCE_LABEL: Record<SmartCleanupConfidence, string> = {
  safe: 'Recommended removal',
  review: 'Needs review',
  blocked: 'Blocked',
  unknown: 'Not verified',
};

const PHASE_TITLE: Record<SmartCleanupState['phase'], string> = {
  analyzing: 'Analyzing cleanup opportunities',
  partial: 'Cleanup plan is partially ready',
  ready: 'Review cleanup recommendations',
  stale: 'Project changed since analysis',
  cancelled: 'Cleanup analysis cancelled',
  empty: 'This project is already tidy',
  unsupported: 'Smart Cleanup is not available here',
  confirming: 'Confirm cleanup',
  executing: 'Applying cleanup',
  'rolling-back': 'Restoring project files',
  complete: 'Cleanup complete',
  'cancelled-rolled-back': 'Cleanup cancelled and restored',
  incomplete: 'Cleanup needs attention',
  unknown: 'Smart Cleanup',
  failed: 'Cleanup analysis could not finish',
};

export interface SmartCleanupWorkspaceProps {
  state: SmartCleanupState;
  dispatch: Dispatch<SmartCleanupAction>;
  onClose: () => void;
  onAnalyze: () => void;
  onCancelAnalysis: () => void;
  removalPreflight: RemoveAnalysisPresentation | null;
  preflightBusy: boolean;
  onPrepareRemoval: (actionIds: readonly string[]) => void;
  onConfirmRemoval: (analysisId: string) => void;
  onKeepDependency: (actionId: string) => void;
  onBackToReview: () => void;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
  reviewEvidenceRefreshing?: boolean;
  onRestoreFiles?: (analysisId: string) => void;
}

function StatusIcon({ confidence }: { confidence: SmartCleanupConfidence }): ReactElement {
  if (confidence === 'safe') return <IconCheck />;
  if (confidence === 'review') return <IconAlertTriangle />;
  if (confidence === 'blocked') return <IconXCircle />;
  return <IconHelpCircle />;
}

function RecommendationItem({
  recommendation,
  selected,
  reviewed,
  selectionFull,
  onToggleSafe,
  onReview,
  onToggleReviewed,
}: {
  recommendation: SmartCleanupRemovalRecommendation;
  selected: boolean;
  reviewed: boolean;
  selectionFull: boolean;
  onToggleSafe: () => void;
  onReview: () => void;
  onToggleReviewed: () => void;
}): ReactElement {
  const reasonId = `${useId()}-reason`;
  const cannotSelect = recommendation.confidence === 'blocked' || recommendation.confidence === 'unknown';
  const needsReview = recommendation.confidence === 'review';
  const disabled = cannotSelect || (needsReview && !reviewed) || (selectionFull && !selected);
  const evidenceLabel = needsReview
    ? 'Evidence to review'
    : recommendation.confidence === 'blocked'
      ? 'Why removal is blocked'
      : recommendation.confidence === 'unknown'
        ? 'Why removal could not be verified'
        : 'Why removal is recommended';

  return (
    <li className="smart-cleanup-action" data-confidence={recommendation.confidence}>
      <div className="smart-cleanup-action__choice">
        <input
          className="smart-cleanup-action__checkbox"
          type="checkbox"
          checked={selected}
          disabled={disabled}
          aria-label={`Remove ${recommendation.packageName}`}
          aria-describedby={reasonId}
          onChange={needsReview ? onToggleReviewed : onToggleSafe}
        />
      </div>
      <div className="smart-cleanup-action__identity">
        <code className="smart-cleanup-action__package">{recommendation.packageName}</code>
        <span className="smart-cleanup-confidence" data-confidence={recommendation.confidence}>
          <StatusIcon confidence={recommendation.confidence} />
          {CONFIDENCE_LABEL[recommendation.confidence]}
        </span>
      </div>
      <span className="smart-cleanup-action__type">{recommendation.dependencyType}</span>
      <p className="smart-cleanup-action__reason" id={reasonId}>
        {recommendation.rationale}
        {cannotSelect ? ' This item cannot be included in cleanup.' : ''}
        {recommendation.transitiveNote === undefined ? null : (
          <span className="smart-cleanup-action__transitive">
            <IconAlertTriangle /> {recommendation.transitiveNote}. Removing the direct declaration will not necessarily
            remove the package from the installed graph.
          </span>
        )}
      </p>
      <div className="smart-cleanup-action__evidence">
        {needsReview ? (
          reviewed ? (
            <p className="smart-cleanup-action__reviewed"><IconCheck />Evidence reviewed. Use the checkbox to include this removal.</p>
          ) : (
            <button type="button" className="button button--small button--caution" onClick={onReview}>
              Review evidence
            </button>
          )
        ) : null}
        {recommendation.evidence.length > 0 ? (
          <details className="smart-cleanup-evidence" open={needsReview && reviewed ? true : undefined}>
            <summary>{evidenceLabel}</summary>
            <ul>
              {recommendation.evidence.map((evidence, index) => (
                <li key={`${index}:${evidence}`}>{evidence}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function InformationalList({ children }: { children: ReactNode }): ReactElement {
  return <ul className="smart-cleanup-information-list">{children}</ul>;
}

function DeprecatedItem({
  finding,
  onOpenDependencyReview,
}: {
  finding: SmartCleanupDeprecatedFinding;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
}): ReactElement {
  const action = finding.nextStep;
  const actionLabel = action.kind === 'review-removal'
    ? 'Review removal'
    : action.kind === 'review-upgrade'
      ? `Review upgrade to ${action.targetVersion}`
      : action.kind === 'review-related-upgrades'
        ? 'Review related dependencies'
        : null;
  const targetTab: ManageTabId = action.kind === 'review-removal'
    ? 'removal'
    : action.kind === 'review-upgrade'
      ? 'upgrade'
      : 'usage';
  return (
    <li className="smart-cleanup-information-item smart-cleanup-information-item--deprecated">
      <div className="smart-cleanup-information-item__heading">
        <code>{finding.packageName}</code>
        <span className="smart-cleanup-information-item__badge" data-tone="warning">
          Deprecated
        </span>
        <span className="smart-cleanup-information-item__badge" data-tone="neutral">
          Installed {finding.installedVersion ?? 'version unknown'}
        </span>
      </div>
      <p>{finding.message}</p>
      {finding.suggestedReplacement === undefined ? null : (
        <span className="smart-cleanup-information-item__meta">
          Maintainer suggests <code>{finding.suggestedReplacement}</code>
        </span>
      )}
      <div className="smart-cleanup-information-item__actions">
        {action.kind === 'review-related-upgrades' ? (
          action.upgrades.map(({ packageName, targetVersion }) => (
            <DirectionalButton
              key={packageName}
              direction="forward"
              className="button button--small button--secondary"
              onClick={() => onOpenDependencyReview(packageName, 'upgrade')}
            >
              Review {packageName} to {targetVersion}
            </DirectionalButton>
          ))
        ) : actionLabel === null ? null : (
          <DirectionalButton
            direction="forward"
            className="button button--small button--secondary"
            onClick={() => onOpenDependencyReview(finding.packageName, targetTab)}
          >
            {actionLabel}
          </DirectionalButton>
        )}
        <span>{action.reason}</span>
        {action.kind === 'review-removal' ? <span>Deprecation alone never authorizes removal.</span> : null}
      </div>
    </li>
  );
}

function SecurityItem({
  finding,
  selectedRoots,
}: {
  finding: SmartCleanupSecurityFinding;
  selectedRoots: readonly string[];
}): ReactElement {
  const selectedRootCount = selectedRoots.length;
  const allRootsSelected = selectedRootCount === finding.directRootCount;
  const remainingRoots = finding.directRoots.filter((packageName) => !selectedRoots.includes(packageName));
  return (
    <li className="smart-cleanup-information-item smart-cleanup-information-item--security">
      <div className="smart-cleanup-security__heading">
        <strong>{finding.packageName}</strong>
        {finding.advisoryId === null ? null : <code>{finding.advisoryId}</code>}
        <SeverityBadge severity={finding.severity} />
      </div>
      <p>{finding.summary}</p>
      <dl className="smart-cleanup-security__paths">
        <div>
          <dt>Selected direct {selectedRootCount === 1 ? 'package' : 'packages'}</dt>
          <dd>{selectedRoots.map((packageName) => <code key={packageName}>{packageName}</code>)}</dd>
        </div>
        {remainingRoots.length === 0 ? null : (
          <div>
            <dt>Also introduced through</dt>
            <dd>{remainingRoots.map((packageName) => <code key={packageName}>{packageName}</code>)}</dd>
          </div>
        )}
      </dl>
      <span className="smart-cleanup-information-item__meta">
        {allRootsSelected
          ? `All ${finding.directRootCount} direct ${finding.directRootCount === 1 ? 'path is' : 'paths are'} selected, so this advisory is expected to leave the installed graph.`
          : `${selectedRootCount} of ${finding.directRootCount} direct paths are selected, so this advisory is expected to remain.`}
        {' '}The refreshed dashboard confirms the result after cleanup.
      </span>
    </li>
  );
}

function EmptyCategory({ children }: { children: ReactNode }): ReactElement {
  return <p className="smart-cleanup-category__empty">{children}</p>;
}

function AnalysisView({ state }: { state: SmartCleanupState }): ReactElement {
  return (
    <div className="smart-cleanup-analysis" aria-busy="true">
      <p>Checking the project in stages. Completed evidence appears as soon as it is available.</p>
      <ol className="smart-cleanup-analysis__steps">
        {state.analysisSteps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="smart-cleanup-analysis__step-icon" aria-hidden="true">
              {step.status === 'complete' ? <IconCheck /> : step.status === 'unavailable' ? <IconHelpCircle /> : <span />}
            </span>
            <span>
              <strong>{step.label}</strong>
              {step.detail === undefined ? null : <small>{step.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReviewView({
  state,
  dispatch,
  onOpenDependencyReview,
}: {
  state: SmartCleanupState;
  dispatch: Dispatch<SmartCleanupAction>;
  onOpenDependencyReview: (packageName: string, tab: ManageTabId) => void;
}): ReactElement {
  const plan = state.plan;
  if (plan === null) return <EmptyCategory>No cleanup evidence is available.</EmptyCategory>;

  const safeRemovalCount = plan.recommendations.filter((recommendation) => recommendation.confidence === 'safe').length;
  const review = plan.recommendations.filter((recommendation) => recommendation.confidence === 'review').length;
  const blocked = plan.recommendations.filter(
    (recommendation) => recommendation.confidence === 'blocked' || recommendation.confidence === 'unknown'
  ).length;
  const selectedCount = state.selectedActionIds.size;
  const safeRemovalsSelected = plan.recommendations
    .filter((recommendation) => recommendation.confidence === 'safe')
    .slice(0, SMART_CLEANUP_MAX_ACTIONS)
    .every((recommendation) => state.selectedActionIds.has(recommendation.id));
  const safeSelected = safeRemovalsSelected;
  const selectableActionCount = safeRemovalCount + review;
  // The header, the Unused signal and the Unused section describe the same
  // list, so they all use these three words for its counts.
  const unusedBreakdown = [
    `${safeRemovalCount} recommended`,
    ...(review > 0 ? [`${review} ${review === 1 ? 'needs' : 'need'} review`] : []),
    ...(blocked > 0 ? [`${blocked} unavailable`] : []),
  ].join(' · ');
  const selectedSecurity = plan.security.flatMap((finding) => {
    const selectedActionIds = new Set(
      finding.directRootActionIds.filter((actionId) => state.selectedActionIds.has(actionId))
    );
    const selectedRoots = plan.recommendations
      .filter((recommendation) => selectedActionIds.has(recommendation.id))
      .map((recommendation) => recommendation.packageName)
      .sort((left, right) => left.localeCompare(right));
    return selectedRoots.length === 0 ? [] : [{ finding, selectedRoots }];
  });

  return (
    <>
      {state.phase === 'partial' || state.message !== null ? (
        <StatusBanner tone="warning">
          {state.message ?? 'Some checks were unavailable. Only recommendations with complete evidence can be selected.'}
        </StatusBanner>
      ) : null}

      <section className="smart-cleanup-outcome" aria-label="Cleanup recommendation summary">
        <div className="smart-cleanup-outcome__lead">
          <div className="smart-cleanup-outcome__title">
            <span aria-hidden="true"><IconBroom /></span>
            <div>
              <h3>
                {state.phase === 'partial'
                  ? 'Review the available cleanup evidence'
                  : review > 0 ? 'Cleanup plan needs your review' : 'Recommended cleanup is ready'}
              </h3>
              <p>{unusedBreakdown}</p>
            </div>
          </div>
          {safeRemovalCount > 0 ? (
            <p className="smart-cleanup-outcome__guidance">
              A recommended removal means the supported source, script, configuration, and dependency checks found no
              known blocker. Static analysis cannot guarantee runtime safety, so review the evidence and run your build
              and tests after cleanup.
            </p>
          ) : null}
        </div>
        <ul className="smart-cleanup-outcome__signals">
          {([
            {
              category: 'unused' as const,
              icon: <IconTrash />,
              label: 'Unused dependencies',
              value: `${safeRemovalCount} recommended`,
              tone: review > 0 ? 'warning' : 'ok',
            },
            {
              category: 'deprecated' as const,
              icon: <IconAlertTriangle />,
              label: 'Deprecated packages',
              value: `${plan.deprecated.length} ${plan.deprecated.length === 1 ? 'finding' : 'findings'}`,
              tone: plan.deprecated.length > 0 ? 'warning' : 'neutral',
            },
            {
              category: 'security' as const,
              icon: <IconShield />,
              label: 'Security impact',
              value: `${plan.security.length} advisory ${plan.security.length === 1 ? 'finding' : 'findings'}`,
              tone: plan.security.length > 0 ? 'security' : 'neutral',
            },
          ]).map((signal) => (
            <li key={signal.category} className="smart-cleanup-outcome__signal" data-tone={signal.tone}>
              <button
                type="button"
                aria-expanded={state.expandedCategories.has(signal.category)}
                onClick={() => dispatch({ type: 'toggle-category', category: signal.category })}
              >
                <span className="smart-cleanup-outcome__signal-icon" aria-hidden="true">{signal.icon}</span>
                <span className="smart-cleanup-outcome__signal-label">{signal.label}</span>
                <span className="smart-cleanup-outcome__signal-value">{signal.value}</span>
                <IconChevronRight className="smart-cleanup-outcome__signal-arrow" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="smart-cleanup-selection-bar">
        <div className="smart-cleanup-selection-bar__status">
          <span aria-hidden="true"><IconCheck /></span>
          <p>
            <strong>{selectedCount}</strong> selected
            {selectableActionCount > SMART_CLEANUP_MAX_ACTIONS ? ` · first batch is limited to ${SMART_CLEANUP_MAX_ACTIONS}` : ''}
          </p>
        </div>
        <div>
          <button
            type="button"
            className="button button--small button--secondary"
            onClick={() => dispatch({ type: safeSelected ? 'clear-selection' : 'select-all-safe' })}
          >
            {safeSelected && selectedCount > 0 ? 'Clear selection' : 'Select recommendations'}
          </button>
        </div>
      </div>

      <div className="smart-cleanup-categories">
        <SmartCleanupCategorySection
          category="unused"
          title="Unused"
          summary={unusedBreakdown}
          detail="Supported code and configuration checks"
          count={plan.recommendations.length}
          expanded={state.expandedCategories.has('unused')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'unused' })}
        >
          {plan.recommendations.length === 0 ? (
            <EmptyCategory>No unused direct dependencies were found.</EmptyCategory>
          ) : (
            <div className="smart-cleanup-action-grid">
              <div className="smart-cleanup-action-grid__header" aria-hidden="true">
                <span />
                <span>Package</span>
                <span>Dependency type</span>
                <span>Reason</span>
                <span>Evidence</span>
              </div>
              <ul className="smart-cleanup-actions">
                {plan.recommendations.map((recommendation) => (
                  <RecommendationItem
                    key={recommendation.id}
                    recommendation={recommendation}
                    selected={state.selectedActionIds.has(recommendation.id)}
                    reviewed={state.reviewedActionIds.has(recommendation.id)}
                    selectionFull={selectedCount >= SMART_CLEANUP_MAX_ACTIONS}
                    onToggleSafe={() => dispatch({ type: 'toggle-safe-action', actionId: recommendation.id })}
                    onReview={() => dispatch({ type: 'review-action', actionId: recommendation.id })}
                    onToggleReviewed={() => dispatch({ type: 'toggle-reviewed-action', actionId: recommendation.id })}
                  />
                ))}
              </ul>
            </div>
          )}
        </SmartCleanupCategorySection>

        <SmartCleanupCategorySection
          category="deprecated"
          title="Deprecated"
          summary="Publisher status and next steps"
          detail="Maintainer guidance"
          count={plan.deprecated.length}
          expanded={state.expandedCategories.has('deprecated')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'deprecated' })}
        >
          {plan.deprecated.length === 0 ? (
            <EmptyCategory>No deprecated direct dependencies were found.</EmptyCategory>
          ) : (
            <SmartCleanupFindingList
              items={plan.deprecated}
              getKey={(finding) => finding.id}
              getSearchText={(finding) => `${finding.packageName} ${finding.installedVersion ?? ''} ${finding.message} ${finding.suggestedReplacement ?? ''}`}
              renderItem={(finding) => <DeprecatedItem finding={finding} onOpenDependencyReview={onOpenDependencyReview} />}
              searchLabel="Search deprecated findings"
              emptyMessage="No deprecated dependency matches this search."
            />
          )}
        </SmartCleanupCategorySection>

        <SmartCleanupCategorySection
          category="security"
          title="Security impact of selection"
          summary={selectedCount === 0 ? 'Select removals to preview' : 'Current graph estimate, verified afterward'}
          detail="Refreshed after cleanup"
          count={selectedSecurity.length}
          expanded={state.expandedCategories.has('security')}
          onToggle={() => dispatch({ type: 'toggle-category', category: 'security' })}
        >
          {selectedCount === 0 ? (
            <EmptyCategory>Select unused dependencies to preview which vulnerable dependency roots would be removed.</EmptyCategory>
          ) : selectedSecurity.length === 0 ? (
            <EmptyCategory>The selected dependencies do not currently introduce any known vulnerable dependency roots.</EmptyCategory>
          ) : (
            <InformationalList>
              {selectedSecurity.map(({ finding, selectedRoots }) => (
                <SecurityItem key={finding.id} finding={finding} selectedRoots={selectedRoots} />
              ))}
            </InformationalList>
          )}
        </SmartCleanupCategorySection>
      </div>
    </>
  );
}

function samePackageSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort((a, b) => a.localeCompare(b));
  const actual = [...right].sort((a, b) => a.localeCompare(b));
  return expected.every((name, index) => name === actual[index]);
}

function preflightMatchesSelection(
  state: SmartCleanupState,
  preflight: RemoveAnalysisPresentation | null
): preflight is RemoveAnalysisPresentation {
  if (preflight === null) return false;
  const selectedNames = selectedSmartCleanupRecommendations(state).map((recommendation) => recommendation.packageName);
  return samePackageSet(selectedNames, preflight.changes.map((change) => change.packageName));
}

function ConfirmationView({
  state,
  onKeepDependency,
  onPrepareRemoval,
  removalPreflight,
  preflightBusy,
}: {
  state: SmartCleanupState;
  onKeepDependency: (actionId: string) => void;
  onPrepareRemoval: (actionIds: readonly string[]) => void;
  removalPreflight: RemoveAnalysisPresentation | null;
  preflightBusy: boolean;
}): ReactElement {
  const selected = selectedSmartCleanupRecommendations(state);
  const preflightMatches = preflightMatchesSelection(state, removalPreflight);
  const checkedPreflight = preflightMatches ? removalPreflight : null;
  const warningCount = checkedPreflight?.changes.filter((change) => change.stillRequiredBy.length > 0).length ?? 0;
  const actionCount = selected.length;
  const checkState = checkedPreflight === null ? 'checking' : warningCount > 0 ? 'warning' : 'ready';

  return (
    <div className="smart-cleanup-confirmation">
      <section
        className="smart-cleanup-final-check"
        data-status={checkState}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {checkedPreflight === null
          ? <IconRefresh className={preflightBusy ? 'banner__icon--spin' : undefined} />
          : warningCount > 0 ? <IconAlertTriangle /> : <IconCheck />}
        <div>
          <h3>
            {checkedPreflight === null
              ? preflightBusy ? 'Checking the final cleanup plan…' : 'Starting the final cleanup check…'
              : warningCount === 0 ? 'Final check complete' : 'Final check needs your attention'}
          </h3>
          <p>
            {checkedPreflight === null
              ? 'Rereading the current dependency tree, simulating the selected actions together, and verifying project files.'
              : warningCount === 0
                ? `${actionCount} cleanup ${actionCount === 1 ? 'action is' : 'actions are'} ready to confirm.`
                : `${warningCount} ${warningCount === 1 ? 'dependency has' : 'dependencies have'} a fresh reference warning. Review the highlighted ${warningCount === 1 ? 'item' : 'items'} below.`}
          </p>
        </div>
      </section>

      <section className="smart-cleanup-confirmation__selection" aria-labelledby="smart-cleanup-selection-title">
        <div className="smart-cleanup-confirmation__selection-heading">
          <h3 id="smart-cleanup-selection-title">Selected cleanup</h3>
          <span>{actionCount} {actionCount === 1 ? 'action' : 'actions'}</span>
        </div>
        <ul className="smart-cleanup-confirmation__packages">
          {selected.map((recommendation) => {
            const freshChange = checkedPreflight?.changes.find((change) => change.packageName === recommendation.packageName);
            const retainedTransitively = freshChange !== undefined && freshChange.stillRequiredBy.length > 0;
            const status = checkedPreflight === null ? 'checking' : retainedTransitively ? 'warning' : 'ready';
            return (
              <li key={recommendation.id} data-status={status}>
                <div className="smart-cleanup-confirmation__package-copy">
                  <div className="smart-cleanup-confirmation__package-heading">
                    <code>{recommendation.packageName}</code>
                    {freshChange === undefined ? null : <span>{freshChange.classification}</span>}
                  </div>
                  <p>{recommendation.rationale}</p>
                  {retainedTransitively ? (
                    <div className="smart-cleanup-preflight__decision">
                      <p className="smart-cleanup-preflight__warning">
                        <IconAlertTriangle /> Still required transitively by {freshChange.stillRequiredBy.join(', ')}
                      </p>
                      <p>Removing this direct declaration will not necessarily remove the package from the installed graph.</p>
                      <button
                        type="button"
                        className="button button--small button--secondary"
                        onClick={() => {
                          const remainingActionIds = [...state.selectedActionIds]
                            .filter((actionId) => actionId !== recommendation.id)
                            .sort((left, right) => left.localeCompare(right));
                          onKeepDependency(recommendation.id);
                          if (remainingActionIds.length > 0) onPrepareRemoval(remainingActionIds);
                        }}
                      >
                        Keep direct dependency
                      </button>
                    </div>
                  ) : null}
                  {recommendation.evidence.length > 0 ? (
                    <details className="smart-cleanup-confirmation__evidence">
                      <summary>Reviewed evidence</summary>
                      <ul>
                        {recommendation.evidence.map((evidence, index) => (
                          <li key={`${index}:${evidence}`}>{evidence}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
                <span className="smart-cleanup-confirmation__status" data-status={status}>
                  {status === 'checking' ? 'Checking' : status === 'warning' ? 'Needs attention' : 'Ready'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {checkedPreflight === null ? null : (
        <section className="smart-cleanup-preflight" aria-label="Cleanup safety details">
          <dl className="smart-cleanup-preflight__facts">
            <div className="smart-cleanup-preflight__files">
              <dt>Files</dt>
              <dd>
                <span><strong>Manifest</strong><code>{checkedPreflight.files.manifestPath}</code></span>
                <span><strong>Lockfile</strong><code>{checkedPreflight.files.lockfilePath}</code></span>
              </dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                {checkedPreflight.verification.configured
                  ? checkedPreflight.verification.scriptNames.join(', ')
                  : 'No post-removal checks configured'}
                <VerificationSuggestions
                  analysisId={checkedPreflight.analysisId}
                  verification={checkedPreflight.verification}
                  actionLabel="this cleanup"
                />
              </dd>
            </div>
          </dl>
        </section>
      )}
      <div className="smart-cleanup-restore-note">
        <IconHistory />
        <p>
          {checkedPreflight?.files.rollbackAvailable === false
            ? 'No automatic restore point is available. Review source control before continuing.'
            : 'If cleanup fails, Packageawy restores your dependency files and stops if it sees they changed.'}
        </p>
      </div>
    </div>
  );
}

function ExecutionView({ state }: { state: SmartCleanupState }): ReactElement {
  const change = useContext(DependencyChangeContext);
  const progress = state.execution;
  return (
    <div className="smart-cleanup-execution" aria-busy="true">
      <div className="smart-cleanup-execution__mark"><IconBroom /></div>
      {change.task !== 'still-running' && !change.blocked ? <p>{state.phase === 'rolling-back' ? state.message : progress?.currentLabel ?? 'Preparing cleanup…'}</p> : null}
      {state.phase === 'rolling-back' ? <span>Keep this workspace open while files are restored.</span> : null}
      <p className="smart-cleanup-mutation-lock-note">Close is unavailable while project files are changing. It becomes available when cleanup or restoration finishes.</p>
    </div>
  );
}

function resultPackageName(actionId: string): string {
  const prefix = 'remove-direct:';
  return actionId.startsWith(prefix) ? actionId.slice(prefix.length) : actionId;
}

function ResultMetric({ metric }: { metric: SmartCleanupResult['metrics'][number] }): ReactElement {
  const maximum = Math.max(metric.before, metric.after, 1);
  const change = metric.before - metric.after;
  const changed = change !== 0;
  const changeLabel = change > 0 ? `${change} fewer` : change < 0 ? `${Math.abs(change)} more` : 'No change';
  return (
    <div
      className="smart-cleanup-metric"
      data-change={change > 0 ? 'improved' : change < 0 ? 'increased' : 'unchanged'}
      data-metric={metric.id}
    >
      <dt>{metric.label}</dt>
      <dd>
        {changed ? <span>{metric.before}</span> : null}
        {changed ? <span aria-hidden="true">→</span> : null}
        <strong>{metric.after}</strong>
        <em>{changeLabel}</em>
      </dd>
      <div className="smart-cleanup-metric__bars" aria-hidden="true">
        {changed ? <span style={{ width: `${Math.max(4, (metric.before / maximum) * 100)}%` }} /> : null}
        <strong style={{ width: `${Math.max(4, (metric.after / maximum) * 100)}%` }} />
      </div>
      <small>{metric.detail}</small>
    </div>
  );
}

function ResultPackages({
  title,
  actionIds,
  tone,
  detail,
}: {
  title: string;
  actionIds: readonly string[];
  tone: 'completed' | 'skipped' | 'failed';
  detail: string;
}): ReactElement | null {
  if (actionIds.length === 0) return null;
  return (
    <section className="smart-cleanup-result-packages" data-tone={tone}>
      <div className="smart-cleanup-result-row__heading">
        {tone === 'completed' ? <IconCheck /> : tone === 'failed' ? <IconXCircle /> : <IconAlertTriangle />}
        <div>
          <h4>{title}</h4>
          <p>{detail}</p>
        </div>
      </div>
      <ul>
        {actionIds.map((actionId) => <li key={actionId}><code>{resultPackageName(actionId)}</code></li>)}
      </ul>
    </section>
  );
}

function ResultAdvisoryItem({ advisory, outcome }: { advisory: SmartCleanupResultAdvisory; outcome: 'resolved' | 'introduced' }): ReactElement {
  const identifiers = advisory.identifiers.join(' · ');
  return (
    <li className="smart-cleanup-result-advisory" data-outcome={outcome}>
      <div>
        {identifiers === '' ? <span>Advisory source</span> : <code>{identifiers}</code>}
        <SeverityBadge severity={advisory.severity} />
      </div>
      <strong>{advisory.flaggedPackage}</strong>
      <span>{advisory.title}</span>
    </li>
  );
}

function RestoreNote({
  restore,
  onRestoreFiles,
}: {
  restore: SmartCleanupRestoreState;
  onRestoreFiles: ((analysisId: string) => void) | undefined;
}): ReactElement {
  if (restore.status === 'restored') {
    return (
      <p>
        package.json and the lockfile were put back as they were before the cleanup, and dependencies were reinstalled.
        Analyze the project again to see its current state.
      </p>
    );
  }
  if (restore.status === 'refused') return <p>{restore.message}</p>;
  const restoring = restore.status === 'restoring';
  return (
    <>
      <p>
        The cleanup changes were kept. Open recovery to review the saved dependency files and choose Restore backup or Keep current for each file.
      </p>
      {onRestoreFiles === undefined ? null : (
        <button
          type="button"
          className="button button--secondary"
          disabled={restoring}
          aria-busy={restoring ? 'true' : undefined}
          onClick={() => onRestoreFiles(restore.analysisId)}
        >
          {restoring ? 'Restoring dependency files…' : 'Review recovery files'}
        </button>
      )}
    </>
  );
}

function ResultView({
  result,
  phase,
  restore,
  onRestoreFiles,
}: {
  result: SmartCleanupResult;
  phase: SmartCleanupState['phase'];
  restore: SmartCleanupRestoreState | null;
  onRestoreFiles: ((analysisId: string) => void) | undefined;
}): ReactElement {
  const restoredLater = restore?.status === 'restored';
  const verified = phase === 'complete' && result.verification === 'passed' && !restoredLater;
  const filesCheckedOnly = phase === 'complete' && result.verification === 'not-configured' && !restoredLater;
  const completedRemovals = result.completedActionIds.filter((actionId) => actionId.startsWith('remove-direct:'));
  const completedCount = result.completedActionIds.length;
  const headline = restoredLater
    ? 'Dependency files restored'
    : verified
    ? 'Verified cleanup results'
    : filesCheckedOnly
    ? 'Cleanup applied'
    : phase === 'complete'
      ? 'Cleanup applied without verified checks'
    : phase === 'cancelled-rolled-back'
      ? 'Dependency files restored'
      : 'Review the incomplete cleanup';
  const headlineDetail = restoredLater
    ? 'The cleanup was reversed. The dependencies it removed are back in the project.'
    : verified
    ? `${completedCount} cleanup ${completedCount === 1 ? 'action completed' : 'actions completed'} and project verification passed.`
    : filesCheckedOnly
    ? `${completedCount} cleanup ${completedCount === 1 ? 'action completed' : 'actions completed'}. Dependency files were checked, but no build or test scripts ran, so run your build and tests before relying on the result.`
    : phase === 'complete'
      ? `${completedCount} cleanup ${completedCount === 1 ? 'action completed' : 'actions completed'}, but ${result.verification === 'failed' ? 'configured verification did not pass' : 'project verification did not run'}.`
      : phase === 'cancelled-rolled-back'
        ? 'Cleanup stopped and the saved dependency files were restored.'
        : `${result.failedActionIds.length} ${result.failedActionIds.length === 1 ? 'action needs' : 'actions need'} attention before the result can be trusted.`;
  const resultTone = verified ? 'verified' : phase === 'cancelled-rolled-back' || restoredLater || filesCheckedOnly ? 'restored' : 'attention';
  const verificationDetail = result.verification === 'passed'
    ? 'Configured project checks passed after cleanup.'
    : result.verification === 'failed'
      ? 'Configured project checks failed after cleanup.'
      : result.verification === 'not-configured'
        ? 'package.json and the lockfile match the cleanup plan. No build or test scripts are configured for verification.'
        : 'No post-cleanup project verification was run.';
  // A restore point is the next decision after a kept cleanup, so its note
  // sits right under the headline instead of below the change list.
  const recovery = (
    <div
      className="smart-cleanup-results__recovery"
      data-tone={result.rollback === 'incomplete' || restore?.status === 'refused' ? 'attention' : 'info'}
    >
      <IconHistory />
      {restore !== null ? <RestoreNote restore={restore} onRestoreFiles={onRestoreFiles} /> : <p>
        {result.rollback === 'restored'
          ? "The saved package.json and active lockfile were restored. Script side effects were not restored."
          : result.rollback === 'incomplete'
            ? 'Automatic restoration could not be fully verified. Review package.json and the active lockfile before continuing.'
            : 'The cleanup changes were kept. Use source control if you need to reverse them later.'}
      </p>}
    </div>
  );
  return (
    <div className="smart-cleanup-results">
      <section className="smart-cleanup-results__headline" data-tone={resultTone} data-verified={verified ? 'true' : undefined}>
        {verified || filesCheckedOnly ? <IconCheck /> : phase === 'cancelled-rolled-back' || restoredLater ? <IconHistory /> : <IconAlertTriangle />}
        <div>
          <h3>{headline}</h3>
          <p>{headlineDetail}</p>
        </div>
      </section>
      {restore === null ? null : recovery}
      {restoredLater ? null : (
        <dl className="smart-cleanup-metrics">
          {result.metrics.map((metric) => <ResultMetric key={metric.id} metric={metric} />)}
        </dl>
      )}
      <section className="smart-cleanup-result-changes" aria-labelledby="smart-cleanup-result-changes-title">
        <h3 id="smart-cleanup-result-changes-title">What changed</h3>
        <div className="smart-cleanup-result-change-list">
          <ResultPackages
            title={restoredLater ? 'Restored dependencies' : 'Removed dependencies'}
            actionIds={completedRemovals}
            tone={restoredLater ? 'skipped' : 'completed'}
            detail={restoredLater
              ? `${completedRemovals.length} direct ${completedRemovals.length === 1 ? 'dependency was' : 'dependencies were'} removed by the cleanup and ${completedRemovals.length === 1 ? 'is' : 'are'} back in the project.`
              : `${completedRemovals.length} direct ${completedRemovals.length === 1 ? 'dependency was' : 'dependencies were'} removed.`}
          />
          <ResultPackages
            title="Skipped actions"
            actionIds={result.skippedActionIds}
            tone="skipped"
            detail={`${result.skippedActionIds.length} selected ${result.skippedActionIds.length === 1 ? 'action was' : 'actions were'} not applied.`}
          />
          <ResultPackages
            title="Failed actions"
            actionIds={result.failedActionIds}
            tone="failed"
            detail={`${result.failedActionIds.length} ${result.failedActionIds.length === 1 ? 'action requires' : 'actions require'} manual review.`}
          />
          {restoredLater ? null : <section className="smart-cleanup-result-row" data-tone={result.verification === 'passed' ? 'verified' : 'attention'}>
            <div className="smart-cleanup-result-row__heading">
              {result.verification === 'passed' ? <IconCheck /> : <IconAlertTriangle />}
              <div>
                <h4>Verification</h4>
                <p>{verificationDetail}</p>
              </div>
            </div>
            <span>{result.verification === 'passed' ? 'Passed' : result.verification === 'failed' ? 'Failed' : 'Not run'}</span>
          </section>}
        </div>
      </section>
      {result.resolvedAdvisories.length > 0 || result.introducedAdvisories.length > 0 ? (
        <section className="smart-cleanup-result-security" aria-labelledby="smart-cleanup-result-security-title">
          <div className="smart-cleanup-result-security__heading">
            <h3 id="smart-cleanup-result-security-title">Security impact</h3>
            <p>{result.resolvedAdvisories.length} resolved · {result.introducedAdvisories.length} new</p>
          </div>
          {result.resolvedAdvisories.length > 0 ? (
            <section className="smart-cleanup-result-advisories" aria-labelledby="smart-cleanup-resolved-advisories">
              <h4 id="smart-cleanup-resolved-advisories">Resolved advisory findings</h4>
              <SmartCleanupFindingList
                items={result.resolvedAdvisories}
                getKey={(advisory) => `${advisory.sourceId}:${advisory.flaggedPackage}`}
                getSearchText={(advisory) => `${advisory.identifiers.join(' ')} ${advisory.flaggedPackage} ${advisory.title}`}
                renderItem={(advisory) => <ResultAdvisoryItem advisory={advisory} outcome="resolved" />}
                searchLabel="Search resolved advisories"
                emptyMessage="No resolved advisory matches this search."
                initialCount={6}
                searchThreshold={6}
              />
            </section>
          ) : null}
          {result.introducedAdvisories.length > 0 ? (
            <section className="smart-cleanup-result-advisories" aria-labelledby="smart-cleanup-introduced-advisories">
              <h4 id="smart-cleanup-introduced-advisories">New advisory findings requiring attention</h4>
              <SmartCleanupFindingList
                items={result.introducedAdvisories}
                getKey={(advisory) => `${advisory.sourceId}:${advisory.flaggedPackage}`}
                getSearchText={(advisory) => `${advisory.identifiers.join(' ')} ${advisory.flaggedPackage} ${advisory.title}`}
                renderItem={(advisory) => <ResultAdvisoryItem advisory={advisory} outcome="introduced" />}
                searchLabel="Search new advisories"
                emptyMessage="No new advisory matches this search."
                initialCount={6}
                searchThreshold={6}
              />
            </section>
          ) : null}
        </section>
      ) : null}
      {restore === null ? recovery : null}
      {result.detail === undefined || phase === 'complete' ? null : <p className="smart-cleanup-results__detail">{result.detail}</p>}
    </div>
  );
}

function TerminalView({ state }: { state: SmartCleanupState }): ReactElement {
  const icon = state.phase === 'empty' ? <IconCheck /> : state.phase === 'stale' ? <IconRefresh /> : <IconAlertTriangle />;
  return (
    <div className="smart-cleanup-terminal" data-phase={state.phase}>
      <span className="smart-cleanup-terminal__icon">{icon}</span>
      <p>{state.message ?? 'No additional details are available.'}</p>
      {state.phase === 'cancelled' && state.plan !== null ? <small>Completed evidence is retained for reference, but execution requires a fresh analysis.</small> : null}
    </div>
  );
}

function announcementForState(state: SmartCleanupState): string {
  if (state.phase === 'analyzing') {
    const completed = state.analysisSteps.filter((step) => step.status === 'complete').length;
    return `Cleanup analysis in progress. ${completed} of ${state.analysisSteps.length} checks complete.`;
  }
  if (state.phase === 'ready' || state.phase === 'partial') {
    const safe = state.plan?.recommendations.filter((recommendation) => recommendation.confidence === 'safe').length ?? 0;
    const review = state.plan?.recommendations.filter((recommendation) => recommendation.confidence === 'review').length ?? 0;
    return `Cleanup analysis ready. ${safe} recommended actions and ${review} actions need review.`;
  }
  if (state.phase === 'executing') return state.execution?.currentLabel ?? 'Cleanup is running.';
  if (state.phase === 'rolling-back') return 'Cleanup stopped. Restoring project files.';
  return PHASE_TITLE[state.phase];
}

export function SmartCleanupWorkspace({
  state,
  dispatch,
  onClose,
  onAnalyze,
  onCancelAnalysis,
  removalPreflight,
  preflightBusy,
  onPrepareRemoval,
  onConfirmRemoval,
  onKeepDependency,
  onBackToReview,
  onOpenDependencyReview,
  reviewEvidenceRefreshing = false,
  onRestoreFiles,
}: SmartCleanupWorkspaceProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousPhase = useRef(state.phase);
  const previouslyFocused = useRef<Element | null>(null);
  const canClose = canCloseSmartCleanup(state);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useEffect(() => {
    if (previousPhase.current === state.phase) return;
    previousPhase.current = state.phase;
    headingRef.current?.focus();
  }, [state.phase]);

  useEffect(() => {
    const node = dialogRef.current;
    return node === null ? undefined : trapFocus(node);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && canClose) {
        event.preventDefault();
        onClose();
        return;
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, [canClose, onClose]);

  const onOverlayClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (canClose && event.target === event.currentTarget) onClose();
  };

  const showReview = state.phase === 'ready' || state.phase === 'partial';
  const showTerminal = ['stale', 'cancelled', 'empty', 'unsupported', 'failed'].includes(state.phase);

  return (
    <div className="modal-overlay smart-cleanup-overlay" onMouseDown={onOverlayClick}>
      <div
        className="modal smart-cleanup-workspace"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-cleanup-title"
        aria-describedby="smart-cleanup-project"
        data-phase={state.phase}
        ref={dialogRef}
      >
        <header className="smart-cleanup-header">
          <span className="smart-cleanup-header__icon" aria-hidden="true"><IconBroom /></span>
          <div className="smart-cleanup-header__copy">
            <h2 id="smart-cleanup-title" tabIndex={-1} ref={headingRef}>{PHASE_TITLE[state.phase]}</h2>
            <p id="smart-cleanup-project">Smart Cleanup · {state.projectName}</p>
          </div>
          <button
            type="button"
            className="modal__close"
            aria-label={canClose ? 'Close Smart Cleanup' : 'Close unavailable while project files are changing'}
            aria-describedby={canClose ? undefined : 'smart-cleanup-close-reason'}
            disabled={!canClose}
            onClick={onClose}
          >
            <IconX />
          </button>
        </header>

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcementForState(state)}
        </p>
        {!canClose ? <p className="sr-only" id="smart-cleanup-close-reason">Wait for cleanup or restoration to finish before closing.</p> : null}

        <div className="smart-cleanup-body">
          <DependencyChangeStatus />
          {state.phase === 'analyzing' ? <AnalysisView state={state} /> : null}
          {showReview ? (
            <>
              {reviewEvidenceRefreshing ? (
                <StatusBanner
                  tone="info"
                  icon={<IconRefresh className="banner__icon--spin" />}
                >
                  Refreshing removal evidence after package review. Your selections are preserved.
                </StatusBanner>
              ) : null}
              <ReviewView state={state} dispatch={dispatch} onOpenDependencyReview={onOpenDependencyReview} />
            </>
          ) : null}
          {state.phase === 'confirming' ? (
            <ConfirmationView
              state={state}
              onKeepDependency={onKeepDependency}
              onPrepareRemoval={onPrepareRemoval}
              removalPreflight={removalPreflight}
              preflightBusy={preflightBusy}
            />
          ) : null}
          {state.phase === 'executing' || state.phase === 'rolling-back' ? <ExecutionView state={state} /> : null}
          {(state.phase === 'complete' || state.phase === 'cancelled-rolled-back' || state.phase === 'incomplete') && state.result !== null
            ? <ResultView result={state.result} phase={state.phase} restore={state.restore} onRestoreFiles={onRestoreFiles} />
            : null}
          {showTerminal ? <TerminalView state={state} /> : null}
        </div>

        <footer className="smart-cleanup-footer">
          {state.phase === 'unknown' ? (
            <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
          ) : null}
          {state.phase === 'analyzing' ? (
            <button type="button" className="button button--secondary" onClick={onCancelAnalysis}>Cancel analysis</button>
          ) : null}
          {showReview ? (
            <>
              <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
              <button
                type="button"
                className="button button--primary"
                disabled={state.selectedActionIds.size === 0 || reviewEvidenceRefreshing}
                onClick={() => {
                  const actionIds = [...state.selectedActionIds].sort((left, right) => left.localeCompare(right));
                  dispatch({ type: 'show-confirmation' });
                  onPrepareRemoval(actionIds);
                }}
              >
                Review {state.selectedActionIds.size} selected
              </button>
            </>
          ) : null}
          {state.phase === 'confirming' ? (
            <>
              <DirectionalButton direction="back" onClick={onBackToReview}>Back</DirectionalButton>
              {preflightMatchesSelection(state, removalPreflight) ? (
                <button
                  type="button"
                  className="button button--danger"
                  disabled={preflightBusy}
                  onClick={() => onConfirmRemoval(removalPreflight.analysisId)}
                >
                  Confirm and clean {state.selectedActionIds.size} {state.selectedActionIds.size === 1 ? 'action' : 'actions'}
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  disabled
                >
                  {preflightBusy ? 'Checking final plan…' : 'Preparing final check…'}
                </button>
              )}
            </>
          ) : null}
          {state.phase === 'rolling-back' ? <span className="smart-cleanup-footer__status">Restoration in progress…</span> : null}
          {showTerminal ? (
            <>
              <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
              {state.phase !== 'empty' && state.phase !== 'unsupported' ? (
                <button type="button" className="button button--primary" onClick={onAnalyze}><IconRefresh />Analyze again</button>
              ) : null}
            </>
          ) : null}
          {state.phase === 'complete' || state.phase === 'cancelled-rolled-back' || state.phase === 'incomplete' ? (
            <>
              <button type="button" className="button button--secondary" disabled={!canClose} onClick={onClose}>Close</button>
              <button type="button" className="button button--primary" disabled={!canClose} onClick={onAnalyze}><IconRefresh />Analyze current project</button>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
