import type { CleanupAction, CleanupFinding } from './types.js';
import { canonicalCleanupActionBatch, defaultCleanupActionIds } from './selection.js';

const KIND_RANK: Record<CleanupFinding['kind'], number> = {
  unused: 0,
  deprecated: 1,
};

const CONFIDENCE_RANK: Record<CleanupFinding['confidence'], number> = {
  'low-risk': 0,
  'review-required': 1,
  blocked: 2,
  unknown: 3,
};

export function rankCleanupFindings(findings: readonly CleanupFinding[]): CleanupFinding[] {
  return [...findings].sort((left, right) =>
    KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
    CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
    left.packageName.localeCompare(right.packageName, 'en') ||
    left.id.localeCompare(right.id, 'en')
  );
}

export interface CleanupSummary {
  opportunities: number;
  unused: number;
  deprecated: number;
  executableActions: number;
  actionOverflow: number;
  defaultSelectedActions: number;
  reviewRequiredActions: number;
  blockedFindings: number;
  unknownFindings: number;
}

function isCleanupOpportunity(finding: CleanupFinding): boolean {
  return finding.kind !== 'unused' || finding.recommendation !== 'keep-direct';
}

export function summarizeCleanup(
  findings: readonly CleanupFinding[],
  actions: readonly CleanupAction[]
): CleanupSummary {
  const batch = canonicalCleanupActionBatch(actions);
  const opportunities = findings.filter(isCleanupOpportunity);
  return {
    opportunities: opportunities.length,
    unused: opportunities.filter((finding) => finding.kind === 'unused').length,
    deprecated: findings.filter((finding) => finding.kind === 'deprecated').length,
    executableActions: batch.actions.length,
    actionOverflow: batch.overflowCount,
    defaultSelectedActions: defaultCleanupActionIds(actions).length,
    reviewRequiredActions: batch.actions.filter((action) => action.confidence === 'review-required').length,
    blockedFindings: findings.filter((finding) => finding.confidence === 'blocked').length,
    unknownFindings: findings.filter((finding) => finding.confidence === 'unknown').length,
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Compact, claim-safe summary. */
export function cleanupSummaryHeadline(summary: CleanupSummary): string {
  return [
    plural(summary.opportunities, 'cleanup opportunity', 'cleanup opportunities'),
    plural(summary.defaultSelectedActions, 'recommended removal'),
  ].join(' · ');
}
