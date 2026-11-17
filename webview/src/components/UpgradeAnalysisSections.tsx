import type { ReactElement, ReactNode, RefObject } from 'react';

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
import { dependencyWarningCount, deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import { IconChevronRight } from '../icons.js';
import { applicableIncompleteProjectChecks } from '../../../src/host/upgradeReviewUiState.js';
import { UpgradeAnalysisLoading } from './UpgradeAnalysisLoading.js';

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
  const findings = dependencyWarningCount(compatibility);
  const incomplete = compatibility.status === 'unknown' || compatibility.completeness !== 'complete' || compatibility.resolverVerification?.status === 'unknown';
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
  const unknown = security?.status === 'unknown';
  const value = unavailable ? 'Security check unavailable'
    : summary === null ? 'Security check unavailable'
      : !unknown && summary.beforeCount === 0 && summary.introducedCount === 0 && summary.confirmedRemainingCount === 0 &&
          summary.unknownCount === 0 ? 'No known vulnerabilities reported'
        : !unknown && resolved + summary.introducedCount + summary.confirmedRemainingCount + summary.unknownCount === 0
          ? 'No longer reached through this upgrade'
        : [
            resolved > 0 ? `${resolved} resolved` : null,
            summary.introducedCount > 0 ? `${summary.introducedCount} introduced` : null,
            summary.confirmedRemainingCount > 0 ? `${summary.confirmedRemainingCount} remain` : null,
            summary.unknownCount > 0 ? `${summary.unknownCount} undetermined` : null,
            unknown && summary.unknownCount === 0 ? 'Security outcome unknown' : null,
          ].filter((entry): entry is string => entry !== null).join(', ');
  const findings = summary !== null && summary.confirmedRemainingCount + summary.introducedCount > 0;
  return {
    area: 'security', label: 'Security impact', value,
    tone: findings ? 'error' : unavailable || unknown || summary === null || summary.unknownCount > 0 ? 'unknown' : 'ok',
    needsReview: unavailable || unknown || summary === null || findings || summary.unknownCount > 0,
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

/** Streamed section counters never authorize revealing the review. */
export function UpgradeAnalysisSections({ sections: _sections }: { sections?: UpgradeAnalysisSectionsState }): ReactElement {
  return <UpgradeAnalysisLoading />;
}
