import type { CleanupEvidence, DeprecatedCleanupFinding } from './types.js';

export interface BuildDeprecatedCleanupFindingOptions {
  findingId: string;
  packageName: string;
  message: string;
  directUsage: 'used' | 'not-found' | 'unknown';
  /** Present only when a separate unused-package finding justified removal. */
  relatedRemovalAction?: {
    id: string;
    confidence: 'low-risk' | 'review-required';
  };
  suggestedReplacement?: string;
}

export function buildDeprecatedCleanupFinding(
  options: BuildDeprecatedCleanupFindingOptions
): DeprecatedCleanupFinding {
  const evidence: CleanupEvidence[] = [{
    kind: 'deprecation',
    message: options.message,
    ...(options.suggestedReplacement === undefined
      ? {}
      : { suggestedReplacement: options.suggestedReplacement }),
  }];

  if (options.directUsage === 'unknown') {
    return {
      id: options.findingId,
      kind: 'deprecated',
      packageName: options.packageName,
      confidence: 'unknown',
      recommendation: 'unknown',
      summary: `${options.packageName} is deprecated, but its project usage is unknown`,
      evidence,
      relatedActionIds: [],
    };
  }

  if (options.directUsage === 'used') {
    return {
      id: options.findingId,
      kind: 'deprecated',
      packageName: options.packageName,
      confidence: 'review-required',
      recommendation: 'remediation-required',
      summary: `${options.packageName} is deprecated and still used by the project`,
      evidence,
      relatedActionIds: [],
    };
  }

  if (options.relatedRemovalAction !== undefined) {
    return {
      id: options.findingId,
      kind: 'deprecated',
      packageName: options.packageName,
      confidence: options.relatedRemovalAction.confidence,
      recommendation: 'remove-if-unused',
      summary: `${options.packageName} is deprecated and has a separately justified removal action`,
      evidence,
      relatedActionIds: [options.relatedRemovalAction.id],
    };
  }

  return {
    id: options.findingId,
    kind: 'deprecated',
    packageName: options.packageName,
    confidence: 'review-required',
    recommendation: 'informational',
    summary: `${options.packageName} is deprecated, but no automatic cleanup action is justified`,
    evidence,
    relatedActionIds: [],
  };
}
