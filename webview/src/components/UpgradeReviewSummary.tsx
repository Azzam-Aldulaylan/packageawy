import type { ReactElement } from 'react';
import type { PackageRow } from '../../../src/core/types.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { classifyUpdate } from '../../../src/host/updateClassification.js';
import { dependencyWarningCount, deriveUpgradeReviewDecision } from '../../../src/host/upgradeReviewDecision.js';
import { summarizeProjectCompatibility } from '../../../src/host/projectCompatibilityUiState.js';
import { summarizeUpgradeSecurity } from '../../../src/host/upgradeSecuritySummary.js';
import { majorUpdateSummary } from '../../../src/host/findingCopy.js';
import { usageSummaryCounts } from '../../../src/host/dependencyDetailsCopy.js';
import { IconAlertTriangle, IconCheck, IconChevronRight, IconFile, IconHelpCircle, IconListChecks, IconRoute, IconShield, IconXCircle } from '../icons.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { StatusBanner } from './StatusBanner.js';
import { UpgradeSummarySkeleton } from './UpgradeAnalysisLoading.js';
import { upgradeReviewHasIncompleteChecks } from '../../../src/host/upgradeReviewUiState.js';
import type { UpgradeReviewArea, UpgradeReviewSignal, UpgradeReviewTone as ReviewTone } from './UpgradeAnalysisSections.js';
import type { UsageRequestState } from './UsageReferencesPanel.js';

const PENDING_REVIEW_SIGNALS: UpgradeReviewSignal[] = [
  { area: 'dependency', label: 'Dependency compatibility', value: 'Checking', tone: 'neutral', needsReview: false },
  { area: 'project', label: 'Project compatibility', value: 'Checking', tone: 'neutral', needsReview: false },
  { area: 'security', label: 'Security impact', value: 'Checking', tone: 'neutral', needsReview: false },
  { area: 'verification', label: 'Verification', value: 'Checking', tone: 'neutral', needsReview: false },
];

export function MajorUpdateNotice({ analysis }: { analysis: UpgradeAnalysisPresentation }): ReactElement | null {
  const warnings = analysis.compatibility.findings.filter((finding) => finding.kind === 'major-version-change');
  if (warnings.length === 0) return null;
  return <div className="upgrade-major-notice">
    <IconAlertTriangle aria-hidden="true" />
    <div>{warnings.map((finding) => {
      const change = analysis.changes.find((entry) => entry.packageName === finding.subject.name) ??
        analysis.smartPlan?.changes.find((entry) => entry.packageName === finding.subject.name);
      return <p key={finding.id}><strong>{finding.subject.name}: </strong>{majorUpdateSummary(finding, {
        package: finding.subject.name, currentVersion: change?.currentVersion ?? (finding.subject.name === analysis.package ? analysis.currentVersion : 'unknown'),
      })}</p>;
    })}</div>
  </div>;
}

const UPDATE_KIND_LABEL: Record<'major' | 'minor' | 'patch', string> = {
  major: 'Major',
  minor: 'Minor',
  patch: 'Patch',
};

function usageAnalysisLabel(usage: UsageRequestState | undefined): string {
  if (usage === undefined || usage.phase === 'analyzing') return 'Checking usage…';
  if (usage.phase === 'error') return 'Usage check failed';
  const count = usageSummaryCounts(usage.result.references).referencedInFiles;
  return count === 0 ? 'No references found' : `Used in ${count} file${count === 1 ? '' : 's'}`;
}

function joinedReviewAreas(areas: readonly string[]): string {
  if (areas.length < 2) return areas[0] ?? 'the analysis details below';
  if (areas.length === 2) return `${areas[0]} and ${areas[1]}`;
  return `${areas.slice(0, -1).join(', ')}, and ${areas.at(-1)}`;
}

/**
 * The one summary sentence set for the review. Findings to look at come
 * first. Checks that could not fully run are a coverage limit, not a
 * finding, so they get their own sentence instead of a "review" item.
 */
function upgradeReviewSummary(analysis: UpgradeAnalysisPresentation, coordinated: boolean, advisoriesOff: boolean): string {
  const findings: string[] = [];
  const sentences: string[] = [];
  const partialCoverage = upgradeReviewHasIncompleteChecks(analysis, advisoriesOff);
  if (analysis.compatibility.status === 'conflict') {
    if (coordinated) findings.push('the coordinated dependency changes');
    else sentences.push('Choose another target or resolve the dependency conflict first.');
  } else if (analysis.compatibility.status === 'warning') {
    const count = dependencyWarningCount(analysis.compatibility);
    findings.push(count > 0 ? `${count} dependency compatibility ${count === 1 ? 'warning' : 'warnings'}` : 'the dependency compatibility warnings');
  }

  const projectSummary = summarizeProjectCompatibility(analysis.projectCompatibility);
  if (projectSummary.total > 0) {
    findings.push(`${projectSummary.total} project compatibility ${projectSummary.total === 1 ? 'finding' : 'findings'}`);
  }

  let resolvedCount = 0;
  if (analysis.security !== null) {
    const security = summarizeUpgradeSecurity(analysis.security);
    resolvedCount = analysis.security.resolvedAdvisories.length;
    if (security.introducedCount > 0) findings.push(`${security.introducedCount} introduced vulnerabilit${security.introducedCount === 1 ? 'y' : 'ies'}`);
    if (analysis.security.checkState === 'unavailable') findings.push('Security check unavailable');
    if (security.confirmedRemainingCount > 0) {
      findings.push(`${security.confirmedRemainingCount} ${security.confirmedRemainingCount === 1 ? 'vulnerability that remains' : 'vulnerabilities that remain'}`);
    }
    if (security.unknownCount > 0) {
      findings.push(`${security.unknownCount} undetermined security ${security.unknownCount === 1 ? 'outcome' : 'outcomes'}`);
    }
  }

  if (findings.length > 0) sentences.push(`Review ${joinedReviewAreas(findings)} before upgrading.`);
  if (coordinated) sentences.push('The coordinated plan changes dependencies only, not your source or configuration.');
  if (resolvedCount > 0) sentences.push(`Fixes ${resolvedCount} known ${resolvedCount === 1 ? 'vulnerability' : 'vulnerabilities'}.`);
  sentences.push(partialCoverage
    ? 'Some checks could not complete. Run your build and tests after upgrading.'
    : sentences.length > 0 || findings.length > 0 ? 'Run your build and tests after upgrading.' : 'No issues were found. Run your build and tests after upgrading.');
  return sentences.join(' ');
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) ?? path;
}

function iconForReviewSignal(area: UpgradeReviewSignal['area'], tone: ReviewTone): ReactElement {
  if (area === 'security') return <IconShield />;
  if (area === 'verification') return <IconListChecks />;
  if (tone === 'error') return <IconXCircle />;
  if (tone === 'warning') return <IconAlertTriangle />;
  if (tone === 'unknown') return <IconHelpCircle />;
  if (tone === 'neutral') return <IconHelpCircle />;
  return area === 'dependency' ? <IconRoute /> : <IconCheck />;
}

function UpgradeReviewSignalRow({ signal, onOpen, disabled }: {
  signal: UpgradeReviewSignal;
  disabled: boolean;
  onOpen: (area: UpgradeReviewArea) => void;
}): ReactElement {
  const content = (
    <>
      <span className="upgrade-decision__signal-icon" aria-hidden="true">{iconForReviewSignal(signal.area, signal.tone)}</span>
      <span className="upgrade-decision__signal-label">{signal.label}</span>
      <span className="upgrade-decision__signal-value">{signal.value}</span>
      <IconChevronRight className="upgrade-decision__signal-arrow" />
    </>
  );
  return (
    <li className={`upgrade-decision__signal upgrade-decision__signal--${signal.tone}`}>
      <button type="button" disabled={disabled} onClick={() => onOpen(signal.area)} aria-label={`${signal.label}: ${signal.value}. View details`}>
        {content}
      </button>
    </li>
  );
}

export function UpgradeDecisionBrief({
  row,
  targetVersion,
  analysis,
  coordinated,
  advisoriesOff = false,
  signals,
  usage,
  onOpenArea,
  error = null,
  onRetry,
  retryDisabled = false,
  showUsage = true,
}: {
  row: Pick<PackageRow, 'name' | 'current' | 'range'>;
  targetVersion: string;
  analysis: UpgradeAnalysisPresentation | null;
  coordinated: boolean;
  advisoriesOff?: boolean;
  signals: readonly UpgradeReviewSignal[];
  usage: UsageRequestState | undefined;
  onOpenArea: (area: UpgradeReviewArea) => void;
  error?: string | null;
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean;
  showUsage?: boolean;
}): ReactElement {
  const decision = analysis === null ? null : deriveUpgradeReviewDecision(analysis, coordinated);
  const updateKind = classifyUpdate(analysis?.currentVersion ?? row.current ?? row.range, targetVersion);
  const signalsNeedingReview = signals.filter((signal) => signal.needsReview);
  const firstReviewSignal = signalsNeedingReview[0];

  return (
    <section className={`upgrade-decision upgrade-decision--${decision?.headline.className ?? 'pending'}`} aria-busy={analysis === null && error === null} aria-labelledby="upgrade-decision-heading">
      <div className="upgrade-decision__lead">
        {decision === null ? <span className="status-badge status-badge--neutral">{error === null ? 'Checking upgrade' : 'Review unavailable'}</span> : <OutcomeStatus label={decision.headline.label} className={decision.headline.className} size="large" />}
        <h3 id="upgrade-decision-heading">Upgrade {row.name}</h3>
        <div className="upgrade-decision__versions">
          <code>{analysis?.currentVersion ?? row.current ?? row.range}</code>
          <span aria-hidden="true">→</span>
          <code>{targetVersion}</code>
          <span className="status-badge status-badge--neutral">{updateKind !== null ? UPDATE_KIND_LABEL[updateKind] : 'Unknown'} update</span>
        </div>
        {error !== null ? <StatusBanner
          tone="error"
          className="upgrade-review__error"
          {...(onRetry === undefined ? {} : { action: { label: 'Retry', onClick: onRetry, disabled: retryDisabled } })}
        >{error}</StatusBanner> : null}
        {analysis === null ? (error === null ? <UpgradeSummarySkeleton /> : null) : <>
          <MajorUpdateNotice analysis={analysis} />
          <p className="upgrade-decision__reason">{upgradeReviewSummary(analysis, coordinated, advisoriesOff)}</p>
        </>}
        {decision?.caution && firstReviewSignal !== undefined ? (
          <button type="button" className="button button--secondary upgrade-decision__review" onClick={() => onOpenArea(firstReviewSignal.area)}>
            Start with {firstReviewSignal.label}
            <IconChevronRight />
          </button>
        ) : null}
        {analysis !== null ? <div className="upgrade-decision__context">
          {showUsage ? <span><IconFile /> {usageAnalysisLabel(usage)}</span> : null}
          <span>
            Will update <code>{baseName(analysis.files.manifestPath)}</code> and <code>{baseName(analysis.files.lockfilePath)}</code>
            {analysis.files.rollbackAvailable ? ' · Restore point included' : ''}
          </span>
        </div> : null}
      </div>
      <ul className="upgrade-decision__signals" aria-label="Upgrade review status">
        {(analysis === null ? PENDING_REVIEW_SIGNALS : signals).map((signal) => <UpgradeReviewSignalRow signal={analysis === null && error !== null ? { ...signal, value: 'Not checked' } : signal} onOpen={onOpenArea} disabled={analysis === null} key={signal.area} />)}
      </ul>
    </section>
  );
}

