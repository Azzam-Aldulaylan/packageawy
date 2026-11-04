import type { DependencyFinding } from '../../src/core/hygiene/types.js';
import type { AttributedAdvisory, PackageRow, RemovalAssessment } from '../../src/core/types.js';
import { vulnerabilityIdentifiers } from '../../src/core/advisories/identifiers.js';
import { canonicalAdvisoryFindingKey } from '../../src/core/advisories/metrics.js';
import type { RemovalImpactState } from './removalImpactState.js';
import type {
  SmartCleanupDeprecatedFinding,
  SmartCleanupPlan,
  SmartCleanupRemovalRecommendation,
  SmartCleanupSecurityFinding,
} from './smartCleanupState.js';
import type { SmartCleanupExecutionCapability } from '../../src/host/webviewProtocol.js';
import { resolveDeprecatedRemediation } from '../../src/core/cleanup/deprecatedRemediation.js';

function dependencyType(row: PackageRow): SmartCleanupRemovalRecommendation['dependencyType'] {
  if (row.optional) return 'optional';
  return row.dev ? 'development' : 'production';
}

function advisoryDisplayId(advisory: AttributedAdvisory): string | null {
  return vulnerabilityIdentifiers(advisory.advisory)[0] ?? null;
}

export interface BuildSmartCleanupPlanOptions {
  projectName: string;
  requestId: string;
  rows: readonly PackageRow[];
  hygieneFindings: readonly DependencyFinding[];
  exactDeprecatedFindings: readonly DependencyFinding[];
  removalImpact: RemovalImpactState;
  capability: SmartCleanupExecutionCapability;
}

/**
 * Presentation adapter over host-gathered evidence. It does not grant
 * mutation authority: execution still sends package names through the
 * existing host validation, fresh disk reread, and single-use removal plan.
 */
export function buildSmartCleanupPlan(options: BuildSmartCleanupPlanOptions): SmartCleanupPlan {
  const rowsByName = new Map(options.rows.map((row) => [row.name, row]));
  const assessmentByName: ReadonlyMap<string, { assessment: RemovalAssessment; usageId: string }> = options.removalImpact.phase === 'done'
    ? options.removalImpact.assessments
    : new Map<string, { assessment: RemovalAssessment; usageId: string }>();
  const unusedNames = new Set(
    options.hygieneFindings
      .filter((finding) => finding.kind === 'likely-unused')
      .map((finding) => finding.packageName)
  );
  const recommendations: SmartCleanupRemovalRecommendation[] = [...unusedNames]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((packageName) => {
      const row = rowsByName.get(packageName);
      if (row === undefined) return [];
      const assessment = assessmentByName.get(packageName)?.assessment;
      const evidenceCapabilityReason = options.capability.executionSupported ? null : options.capability.reason;
      const confidence = evidenceCapabilityReason !== null
        ? 'blocked'
        : assessment?.status === 'low-risk'
        ? 'safe'
        : assessment?.status === 'review'
          ? 'review'
          : assessment?.status === 'blocked'
            ? 'blocked'
            : 'unknown';
      const evidence = evidenceCapabilityReason === null
        ? assessment?.evidence.map((entry) => entry.summary) ?? [
        'Removal-safety evidence is incomplete, so this dependency cannot be selected.',
          ]
        : [evidenceCapabilityReason, ...(assessment?.evidence.map((entry) => entry.summary) ?? [])];
      return [{
        id: `remove-direct:${packageName}`,
        kind: 'remove-direct-dependency' as const,
        packageName,
        dependencyType: dependencyType(row),
        confidence,
        rationale: evidenceCapabilityReason !== null
          ? 'This project can be analyzed, but Smart Cleanup removal is disabled for its current workspace or lockfile layout.'
          : confidence === 'safe'
          ? 'No project usage or blocking dependency requirement was found.'
          : confidence === 'review'
            ? 'No direct usage was found, but convention-based or incomplete evidence makes automatic removal uncertain. Review the evidence, then decide whether to include it.'
            : confidence === 'blocked'
              ? 'A known dependency requirement blocks automatic removal.'
              : `Not verified: ${evidence[0] ?? 'The removal-safety analysis did not return a reason.'}`,
        evidence,
      }];
    });
  const recommendationByPackage = new Map(recommendations.map((recommendation) => [recommendation.packageName, recommendation]));
  const actionIdByPackage = new Map(
    recommendations
      .filter((recommendation) => recommendation.confidence === 'safe' || recommendation.confidence === 'review')
      .map((recommendation) => [recommendation.packageName, recommendation.id])
  );

  const deprecated: SmartCleanupDeprecatedFinding[] = options.exactDeprecatedFindings
    .filter((finding) => finding.kind === 'deprecated' && finding.evidence.kind === 'deprecated')
    .sort((left, right) => left.packageName.localeCompare(right.packageName))
    .flatMap((finding) => {
      const row = rowsByName.get(finding.packageName);
      if (row === undefined || finding.evidence.kind !== 'deprecated') return [];
      const removalRecommendation = recommendationByPackage.get(finding.packageName);
      const assessment = assessmentByName.get(finding.packageName)?.assessment;
      const requiredBy = assessment?.evidence.flatMap((entry) =>
        entry.kind === 'peer-requirement' && !entry.optional
          ? [entry.requiredBy]
          : []
      ) ?? [];
      const relatedUpgrades = requiredBy.flatMap((packageName) => {
        const owner = rowsByName.get(packageName);
        return owner?.upgradeTo === null || owner?.upgradeTo === undefined
          ? []
          : [{ packageName, targetVersion: owner.upgradeTo }];
      });
      const nextStep = resolveDeprecatedRemediation({
        ...(removalRecommendation === undefined
          ? {}
          : {
              removalAction: {
                id: removalRecommendation.id,
                confidence: removalRecommendation.confidence,
              },
            }),
        upgradeTarget: row.upgradeTo,
        requiredBy,
        relatedUpgrades,
        ...(finding.evidence.suggestedReplacement === undefined
          ? {}
          : { suggestedReplacement: finding.evidence.suggestedReplacement }),
      });
      return [{
        id: `deprecated:${finding.packageName}`,
        packageName: finding.packageName,
        installedVersion: row.current,
        message: finding.evidence.message,
        ...(finding.evidence.suggestedReplacement === undefined
          ? {}
          : { suggestedReplacement: finding.evidence.suggestedReplacement }),
        nextStep,
      }];
    });

  const securityByIdentity = new Map<string, Omit<SmartCleanupSecurityFinding, 'directRootActionIds' | 'directRoots' | 'directRootCount'> & {
    directRoots: Set<string>;
  }>();
  for (const row of options.rows) {
    for (const attributed of row.advisories) {
      const identity = canonicalAdvisoryFindingKey(attributed);
      const existing = securityByIdentity.get(identity);
      if (existing !== undefined) {
        existing.directRoots.add(row.name);
      } else {
        securityByIdentity.set(identity, {
          id: `security:${identity}`,
          advisoryId: advisoryDisplayId(attributed),
          packageName: attributed.flaggedPackage,
          severity: attributed.advisory.severity,
          summary: attributed.advisory.title,
          directRoots: new Set([row.name]),
        });
      }
    }
  }

  const severityRank = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 } as const;
  const security = [...securityByIdentity.values()].map(({ directRoots, ...finding }) => ({
    ...finding,
    directRoots: [...directRoots].sort((left, right) => left.localeCompare(right)),
    directRootActionIds: [...directRoots]
      .map((packageName) => actionIdByPackage.get(packageName))
      .filter((actionId): actionId is string => actionId !== undefined)
      .sort((left, right) => left.localeCompare(right)),
    directRootCount: directRoots.size,
  })).sort((left, right) =>
    severityRank[right.severity] - severityRank[left.severity] ||
    left.packageName.localeCompare(right.packageName) ||
    (left.advisoryId ?? '').localeCompare(right.advisoryId ?? '')
  );

  return {
    planId: `cleanup:${options.requestId}`,
    requestId: options.requestId,
    projectName: options.projectName,
    generatedAt: new Date().toISOString(),
    recommendations,
    deprecated,
    security,
  };
}
