export { buildDeprecatedCleanupFinding } from './findings.js';
export type { BuildDeprecatedCleanupFindingOptions } from './findings.js';
export { resolveDeprecatedRemediation } from './deprecatedRemediation.js';
export type {
  DeprecatedRemediation,
  ResolveDeprecatedRemediationOptions,
} from './deprecatedRemediation.js';
export { buildRemovalCleanupFinding } from './removal.js';
export type { BuildRemovalCleanupFindingOptions, RemovalCleanupResult } from './removal.js';
export { buildCleanupReport } from './report.js';
export type { BuildCleanupReportOptions, CleanupMetricInput } from './report.js';
export {
  MAX_SMART_CLEANUP_ACTIONS,
  canonicalCleanupActionBatch,
  defaultCleanupActionIds,
  rankCleanupActions,
  resolveCleanupSelection,
} from './selection.js';
export type { CleanupActionBatch, CleanupSelectionResult } from './selection.js';
export { cleanupSummaryHeadline, rankCleanupFindings, summarizeCleanup } from './summary.js';
export type { CleanupSummary } from './summary.js';
export type {
  CleanupAction,
  CleanupActionOutcome,
  CleanupActionOutcomeStatus,
  CleanupAnalyzerOutcome,
  CleanupAnalyzerStatus,
  CleanupConfidence,
  CleanupEvidence,
  CleanupFinding,
  CleanupFindingKind,
  CleanupMetric,
  CleanupPlan,
  CleanupReport,
  CleanupReportMetrics,
  CleanupSecurityImpact,
  DeprecatedCleanupFinding,
  RemoveDirectDependencyAction,
  UnusedCleanupFinding,
} from './types.js';
