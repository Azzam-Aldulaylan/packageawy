import type { ReactElement, ReactNode, RefObject } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type {
  ProjectCompatibilityAnalysis,
  SecurityOutcome,
  UpgradeAnalysisCompatibility,
  UpgradeAnalysisPresentation,
  UpgradeAnalysisVerification,
} from '../../../src/host/webviewProtocol.js';
import type { UpgradeAnalysisSections as UpgradeAnalysisSectionsState } from '../../../src/host/upgradeAnalysisSections.js';
import { summarizeProjectCompatibility } from '../../../src/host/projectCompatibilityUiState.js';
import { summarizeUpgradeSecurity } from '../../../src/host/upgradeSecuritySummary.js';
import { deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import { hasPlannerAddedCoordination } from '../../../src/host/upgradeReviewUiState.js';
import { IconChevronRight } from '../icons.js';
import { LoadingRing } from './DependencyLoadingState.js';
import type { ManageTabId } from './ManageDependencyModal.js';
import {
  CompatibilityCheckCard,
  CoordinatedUpgradePlanCard,
  CoordinationUnavailableCard,
  SecurityOutcomeCard,
  SimpleUpgradePlanCard,
  VerificationStepsCard,
} from './UpgradeAnalysisCards.js';
import { PHASE_LABEL } from './UpgradeAnalysisLoading.js';
import { ProjectCompatibilitySection } from './ProjectCompatibilitySection.js';

/**
 * A single section's compact loading placeholder: deliberately not a large
 * skeleton or a second progress-bar system, just a small ring plus the same
 * phase copy UpgradeAnalysisLoading.tsx already uses, sized to sit in a
 * card's slot in the grid below.
 */
function SectionPlaceholder({ label }: { label: string }): ReactElement {
  return (
    <div className="analysis-card analysis-card--pending" role="status" aria-live="polite">
      <LoadingRing progress={undefined} />
      <p className="analysis-card__pending-label">{label}</p>
    </div>
  );
}

export type UpgradeReviewTone = 'ok' | 'warning' | 'error' | 'unknown' | 'neutral';
export type UpgradeReviewArea = 'dependency' | 'project' | 'security' | 'plan' | 'verification';

export interface UpgradeReviewSignal {
  area: Exclude<UpgradeReviewArea, 'plan'>;
  label: string;
  value: string;
  tone: UpgradeReviewTone;
  needsReview: boolean;
}

/** The one disclosure shell used before and after Upgrade Review completes. */
export function UpgradeReviewDisclosure({
  sectionRef,
  label,
  value,
  tone,
  expanded,
  children,
}: {
  sectionRef?: RefObject<HTMLDetailsElement | null> | undefined;
  label: string;
  value: string;
  tone: UpgradeReviewTone;
  expanded?: boolean | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <details
      className={`upgrade-review-disclosure upgrade-review-disclosure--${tone}`}
      ref={sectionRef}
      {...(expanded === undefined ? {} : { open: expanded })}
    >
      <summary>
        <span className="upgrade-review-disclosure__label">{label}</span>
        <span className="upgrade-review-disclosure__value">{value}</span>
        <IconChevronRight className="upgrade-review-disclosure__chevron" />
      </summary>
      <div className="upgrade-review-disclosure__body">{children}</div>
    </details>
  );
}

function dependencyReviewSignal(compatibility: UpgradeAnalysisCompatibility): UpgradeReviewSignal {
  const conflicts = compatibility.findings.filter((finding) => finding.status === 'conflict').length;
  const findings = compatibility.findings.filter((finding) => finding.status !== 'compatible').length;
  const incomplete = compatibility.status === 'unknown' || compatibility.completeness !== 'complete';
  const value = compatibility.status === 'conflict'
    ? conflicts > 0 ? `${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}` : 'Conflict found'
    : compatibility.status === 'warning'
      ? findings > 0 ? `Warning · ${findings} ${findings === 1 ? 'finding' : 'findings'}` : 'Warning'
      : incomplete ? 'Checks incomplete' : 'No conflicts found';
  return {
    area: 'dependency',
    label: 'Dependency compatibility',
    value,
    tone: compatibility.status === 'conflict' ? 'error' : compatibility.status === 'warning' ? 'warning' : incomplete ? 'unknown' : 'ok',
    needsReview: compatibility.status !== 'compatible' || incomplete,
  };
}

function applicableIncompleteProjectChecks(projectCompatibility: ProjectCompatibilityAnalysis): number {
  const incomplete = summarizeProjectCompatibility(projectCompatibility).incompleteAnalyzers.filter((entry) => !(
    entry.reason === 'deprecated-api-rules-unavailable' && projectCompatibility.identity.packageName !== 'next'
  )).length;
  if (projectCompatibility.analyzers.length === 0) return incomplete;
  const missingRequired = ['runtime-compatibility', 'import-compatibility'].filter((analyzerId) => !projectCompatibility.analyzers.some(
    (entry) => entry.analyzerId === analyzerId
  )).length;
  return incomplete + missingRequired;
}

function projectReviewSignal(projectCompatibility: ProjectCompatibilityAnalysis): UpgradeReviewSignal {
  const summary = summarizeProjectCompatibility(projectCompatibility);
  const projectState = deriveUpgradeReviewDecision({
    compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
    projectCompatibility,
  }).projectState;
  const coverageIncomplete = projectState === 'missing' || projectState === 'incomplete';
  const incomplete = applicableIncompleteProjectChecks(projectCompatibility);
  const value = summary.confirmed > 0
    ? `${summary.confirmed} confirmed ${summary.confirmed === 1 ? 'issue' : 'issues'}`
    : summary.total > 0
      ? `Review · ${summary.total} ${summary.total === 1 ? 'finding' : 'findings'}`
      : projectState === 'missing' ? 'Not checked'
        : coverageIncomplete ? incomplete > 0 ? `${incomplete} incomplete ${incomplete === 1 ? 'check' : 'checks'}` : 'Checks incomplete'
          : 'No issues found';
  return {
    area: 'project',
    label: 'Project compatibility',
    value,
    tone: summary.total > 0 ? 'warning' : coverageIncomplete ? 'unknown' : 'ok',
    needsReview: summary.total > 0 || coverageIncomplete,
  };
}

function securityReviewSignal(
  security: SecurityOutcome | null,
  advisoriesAvailable: boolean,
  advisoriesOff = false
): UpgradeReviewSignal {
  if (advisoriesOff || security?.checkState === 'off') {
    return { area: 'security', label: 'Security impact', value: 'Off', tone: 'neutral', needsReview: false };
  }
  const summary = security === null ? null : summarizeUpgradeSecurity(security);
  const unavailable = security === null || security.checkState === 'unavailable' ||
    (security.checkState === undefined && !advisoriesAvailable);
  const resolved = security?.resolvedAdvisories.length ?? 0;
  const value = unavailable ? 'Security check unavailable'
    : summary === null ? 'Security check unavailable'
      : summary.beforeCount === 0 && summary.introducedCount === 0 && summary.confirmedRemainingCount === 0 &&
          summary.unknownCount === 0 ? 'No known vulnerabilities reported'
        : resolved + summary.introducedCount + summary.confirmedRemainingCount + summary.unknownCount === 0
          ? 'No longer reached through this upgrade'
        : [
            resolved > 0 ? `${resolved} resolved` : null,
            summary.introducedCount > 0 ? `${summary.introducedCount} introduced` : null,
            summary.confirmedRemainingCount > 0 ? `${summary.confirmedRemainingCount} remain` : null,
            summary.unknownCount > 0 ? `${summary.unknownCount} undetermined` : null,
          ].filter((entry): entry is string => entry !== null).join(', ');
  const findings = summary !== null && summary.confirmedRemainingCount + summary.introducedCount > 0;
  return {
    area: 'security', label: 'Security impact', value,
    tone: findings ? 'error' : unavailable || summary === null || summary.unknownCount > 0 ? 'unknown' : 'ok',
    needsReview: unavailable || summary === null || findings || summary.unknownCount > 0,
  };
}

export function verificationReviewSignal(
  verification: UpgradeAnalysisVerification,
  selectedScripts: readonly string[] = []
): UpgradeReviewSignal {
  const scriptCount = verification.configured ? verification.scriptNames.length : 0;
  const optedIn = !verification.configured && selectedScripts.length > 0;
  return {
    area: 'verification',
    label: 'Verification',
    value: verification.configured
      ? `Install + ${scriptCount} ${scriptCount === 1 ? 'script' : 'scripts'} queued`
      : optedIn
        ? `${selectedScripts.join(', ')} will run`
        : 'Build/test checks not configured',
    tone: verification.configured || optedIn ? 'neutral' : 'warning',
    needsReview: !verification.configured && !optedIn,
  };
}

export function buildUpgradeReviewSignals(
  analysis: UpgradeAnalysisPresentation,
  advisoriesAvailable: boolean,
  advisoriesOff = false,
  selectedScripts: readonly string[] = []
): UpgradeReviewSignal[] {
  return [
    dependencyReviewSignal(analysis.compatibility),
    projectReviewSignal(analysis.projectCompatibility),
    securityReviewSignal(analysis.security, advisoriesAvailable, advisoriesOff),
    verificationReviewSignal(analysis.verification, selectedScripts),
  ];
}

/**
 * The Upgrade review tab's loading state, rendered while `analysis` is still
 * null: each of the five sections (Overview feeds Files/Verification;
 * Compatibility; Security; Smart plan) shows its real card the moment
 * its data arrives, instead of gating everything behind one spinner.
 * Never renders the headline/summary cards (Upgrade summary, At a glance,
 * Recommended action, Upgrade preview): those synthesize across every
 * section at once and only ever appear once the full `analysis` replaces
 * this component entirely (see UpgradeReviewPanel.tsx).
 */
export function UpgradeAnalysisSections({
  row,
  targetVersion,
  sections,
  advisoriesAvailable,
  advisoriesOff = false,
  onChangeTab,
  onConfigureVerification,
  onOpenAdvisory,
  onOpenUsageReference,
}: {
  row: PackageRow;
  targetVersion: string;
  sections: UpgradeAnalysisSectionsState;
  advisoriesAvailable: boolean;
  advisoriesOff?: boolean;
  onChangeTab: (tab: ManageTabId) => void;
  onConfigureVerification: () => void;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
  onOpenUsageReference?: ((usageId: string, referenceIndex: number) => void) | undefined;
}): ReactElement {
  const { overview, compatibility, projectCompatibility, security, smartPlan } = sections;
  const dependency = compatibility.status === 'complete'
    ? dependencyReviewSignal(compatibility.value)
    : { value: compatibility.status === 'loading' ? 'Checking…' : 'Waiting', tone: 'neutral' as const };
  const project = projectCompatibility.status === 'complete'
    ? projectReviewSignal(projectCompatibility.value)
    : { value: projectCompatibility.status === 'loading' ? 'Checking…' : 'Waiting', tone: 'neutral' as const };
  const securitySummary = security.status === 'complete'
    ? securityReviewSignal(security.value, advisoriesAvailable, advisoriesOff)
    : { value: 'Waiting', tone: 'neutral' as const };
  const planComplete = overview.status === 'complete' && (smartPlan.status === 'complete' || smartPlan.status === 'not-applicable');
  const coordinatedChangeCount = planComplete && smartPlan.status === 'complete' && smartPlan.value !== null &&
    hasPlannerAddedCoordination(overview.value.changes, smartPlan.value.changes)
    ? smartPlan.value.changes.length
    : null;
  const coordinated = coordinatedChangeCount !== null;
  const planValue = !planComplete
    ? smartPlan.status === 'loading' ? 'Planning…' : 'Waiting'
    : coordinated
      ? `${coordinatedChangeCount} coordinated ${coordinatedChangeCount === 1 ? 'change' : 'changes'}`
      : `${overview.value.changes.length} selected ${overview.value.changes.length === 1 ? 'change' : 'changes'}`;
  const verification = overview.status === 'complete'
    ? verificationReviewSignal(overview.value.verification)
    : { value: 'Waiting', tone: 'neutral' as const };

  return (
    <div className="upgrade-tab">
      <div className="upgrade-tab__details">
        <div className="analysis-loading analysis-loading--compact" role="status" aria-live="polite">
          <LoadingRing progress={undefined} />
          <p className="analysis-loading__title">
            Analyzing {row.name} {targetVersion}
          </p>
        </div>
        <UpgradeReviewDisclosure label="Dependency compatibility" value={dependency.value} tone={dependency.tone} expanded={compatibility.status === 'complete'}>
          {compatibility.status === 'complete' ? (
            <CompatibilityCheckCard
              compatibility={compatibility.value}
              projectCompatibility={projectCompatibility.status === 'complete' ? projectCompatibility.value : undefined}
              context={{ package: row.name, currentVersion: row.current ?? row.range }}
            />
          ) : <SectionPlaceholder label={compatibility.status === 'loading' ? PHASE_LABEL.compatibility : 'Waiting to check compatibility…'} />}
        </UpgradeReviewDisclosure>

        <UpgradeReviewDisclosure label="Project compatibility" value={project.value} tone={project.tone} expanded={projectCompatibility.status === 'complete'}>
          {projectCompatibility.status === 'complete' ? (
            <ProjectCompatibilitySection analysis={projectCompatibility.value} onOpenUsageReference={onOpenUsageReference} />
          ) : <SectionPlaceholder label={projectCompatibility.status === 'loading' ? PHASE_LABEL['project-compatibility'] : 'Waiting to check project compatibility…'} />}
        </UpgradeReviewDisclosure>

        <UpgradeReviewDisclosure label="Security impact" value={securitySummary.value} tone={securitySummary.tone} expanded={security.status === 'complete'}>
          {security.status === 'complete' ? (
            security.value === null
              ? <p className="usage-card__subtitle">{advisoriesOff ? 'Off' : 'Security check unavailable'}</p>
              : <SecurityOutcomeCard row={row} security={security.value} onChangeTab={onChangeTab} onOpenAdvisory={onOpenAdvisory} />
          ) : <SectionPlaceholder label="Checking known vulnerabilities…" />}
        </UpgradeReviewDisclosure>

        <UpgradeReviewDisclosure label="Planned dependency changes" value={planValue} tone={coordinated ? 'warning' : 'neutral'} expanded={planComplete}>
          {planComplete ? (
            coordinated && smartPlan.status === 'complete' && smartPlan.value !== null && compatibility.status === 'complete' ? (
              <CoordinatedUpgradePlanCard requestedChanges={overview.value.changes} smartPlan={smartPlan.value} compatibility={compatibility.value} />
            ) : compatibility.status === 'complete' && compatibility.value.status === 'conflict' ? (
              <CoordinationUnavailableCard row={row} changes={overview.value.changes} />
            ) : <SimpleUpgradePlanCard changes={overview.value.changes} />
          ) : <SectionPlaceholder label={smartPlan.status === 'loading' ? PHASE_LABEL['smart-plan'] : 'Waiting for compatibility results…'} />}
        </UpgradeReviewDisclosure>

        <UpgradeReviewDisclosure label="Verification" value={verification.value} tone={verification.tone} expanded={overview.status === 'complete'}>
          {overview.status === 'complete' ? (
            <VerificationStepsCard verification={overview.value.verification} onConfigureVerification={onConfigureVerification} />
          ) : <SectionPlaceholder label="Preparing verification…" />}
        </UpgradeReviewDisclosure>
      </div>
    </div>
  );
}
