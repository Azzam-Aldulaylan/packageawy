/**
 * Pure display decision for the Vulnerabilities column's severity badge.
 *
 * Lives here rather than under webview/src for the same reason as
 * upgradeAction.ts: webview/tsconfig.json has `noEmit: true`, so there is no
 * compiled `out/` counterpart to unit-test against if this lived there.
 * esbuild bundles the webview straight from TS source, so the import site is
 * unaffected by which directory this lives in.
 */

import type { AttributedAdvisory, Severity } from '../core/types.js';

export interface SeverityDisplay {
  label: string;
  /** CSS modifier class suffix, e.g. "critical" for `severity--critical`. */
  className: string;
  reason?: string;
}

const LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
  info: 'Info',
};

/**
 * A null severity reads as Safe only after the package's version was checked.
 * Missing version evidence gets a neutral label and an install hint.
 */
export function severityDisplay(severity: Severity | null, advisoriesAvailable = true, checked = true): SeverityDisplay {
  if (!checked && severity === null) {
    return { label: 'Not checked', className: 'info', reason: 'Install dependencies to check this package' };
  }
  if (!advisoriesAvailable) return { label: 'Unavailable', className: 'info' };
  if (severity === null) return { label: 'Safe', className: 'none' };
  return { label: LABELS[severity], className: severity };
}

/** Higher is worse/more urgent: Critical > High > Moderate > Low > Info. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

/**
 * Worst-first order for a row's advisory list, never the raw order they
 * arrived from the registry/audit response. Tie-broken, stably, by the
 * flagged package name and then the advisory title so equal-severity
 * entries never visibly reshuffle between renders.
 */
export function sortAdvisoriesBySeverity<T extends Pick<AttributedAdvisory, 'advisory' | 'flaggedPackage'>>(advisories: readonly T[]): T[] {
  return [...advisories].sort(
    (a, b) =>
      SEVERITY_RANK[b.advisory.severity] - SEVERITY_RANK[a.advisory.severity] ||
      a.flaggedPackage.localeCompare(b.flaggedPackage) ||
      a.advisory.title.localeCompare(b.advisory.title)
  );
}
