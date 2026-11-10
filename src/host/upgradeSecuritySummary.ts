import type { SecurityOutcome } from './webviewProtocol.js';

export interface UpgradeSecuritySummary {
  beforeCount: number;
  introducedCount: number;
  confirmedRemainingCount: number;
  unknownCount: number;
  /** Honest after-state copy: zero is returned only when every advisory was proven resolved. */
  afterLabel: string;
}

/**
 * Builds the compact vulnerability counts used by Upgrade review. Unknown
 * resolver outcomes are not vulnerabilities proven absent, so they must never
 * collapse into a misleading zero-after-upgrade claim.
 */
export function summarizeUpgradeSecurity(security: SecurityOutcome): UpgradeSecuritySummary {
  const confirmedRemainingCount = security.remaining.filter((entry) => entry.status === 'remains').length;
  const unknownCount = security.remaining.filter((entry) => entry.status === 'unknown').length;
  const introducedCount = security.introduced?.length ?? 0;
  const beforeCount = security.resolvedAdvisories.length + confirmedRemainingCount + unknownCount;

  let afterLabel: string;
  if (unknownCount > 0) {
    const unknownLabel = `${unknownCount} undetermined`;
    const confirmedCount = confirmedRemainingCount + introducedCount;
    afterLabel = confirmedCount > 0 ? `${confirmedCount} remains, ${unknownLabel}` : unknownLabel;
  } else {
    afterLabel = String(confirmedRemainingCount + introducedCount);
  }

  if (security.checkState === 'off') afterLabel = 'Off';
  else if (security.checkState === 'unavailable') afterLabel = 'Security check unavailable';
  return { beforeCount, introducedCount, confirmedRemainingCount, unknownCount, afterLabel };
}

export function requiresSecurityAcknowledgement(security: SecurityOutcome | null | undefined): boolean {
  return security?.introduced?.some((entry) => entry.advisory.severity === 'high' || entry.advisory.severity === 'critical') ?? false;
}
