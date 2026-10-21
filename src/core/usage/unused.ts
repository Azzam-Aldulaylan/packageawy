/**
 * Turn a completed usage scan into a "likely unused" finding, never an
 * absolute "unused dependency" claim from static analysis alone.
 *
 * Only direct dependencies are ever considered here (the caller is expected
 * to have scanned only direct dependency names): transitive dependencies
 * are never labeled unused.
 */

import { isFrameworkConventionPackage } from './frameworkConventions.js';
import { typesPackageTarget } from './packageNameMatch.js';
import type { DependencyFinding } from '../hygiene/types.js';
import type { PeerRequirementEvidence } from '../upgrade/peerRequirement.js';
import type { DependencyUsageResult } from './types.js';

/** Project facts beyond the workspace scan that can show a package is in use. */
export interface UnusedFindingContext {
  /** Other installed packages that declare this package as a peer dependency. */
  peerRequirements?: readonly PeerRequirementEvidence[];
  /** Every direct dependency name of the project. */
  directDependencies?: ReadonlySet<string>;
}

/**
 * Returns null when the package is in use, so there is nothing to report:
 * it has at least one reference, another installed package requires it as
 * a peer, or it is `@types/<name>` and `<name>` is a direct dependency.
 * Otherwise a `likely-unused` finding, graded:
 *
 *   - `low` confidence whenever the scan itself was incomplete (`truncated`):
 *     an absence of evidence from a partial scan proves nothing.
 *   - `low` confidence when another installed package lists it as an
 *     optional peer dependency.
 *   - `low` confidence when the package name matches a known
 *     framework/tooling convention (see frameworkConventions.ts), which
 *     includes every `@types/*` package: commonly loaded without a
 *     reference this scanner can see.
 *   - `high` confidence otherwise: a full scan found no static imports,
 *     requires, dynamic imports, package.json scripts, or recognized
 *     configuration references at all.
 */
export function buildUnusedFinding(
  packageName: string,
  usage: DependencyUsageResult,
  context: UnusedFindingContext = {}
): DependencyFinding | null {
  if (usage.references.length > 0) return null;

  const peerRequirements = context.peerRequirements ?? [];
  if (peerRequirements.some((requirement) => !requirement.optional)) return null;

  const typesTarget = typesPackageTarget(packageName);
  if (typesTarget !== null && context.directDependencies?.has(typesTarget) === true) return null;

  const optionalPeerOwners = peerRequirements.map((requirement) => requirement.requiredBy);
  const conventionPackage = isFrameworkConventionPackage(packageName);
  const lowConfidence = usage.truncated || optionalPeerOwners.length > 0 || conventionPackage;

  const reason = usage.truncated
    ? 'The workspace scan did not cover every eligible file, so this may be a false positive.'
    : optionalPeerOwners.length > 0
      ? `No code references found, but this package is an optional peer dependency of ${optionalPeerOwners.join(', ')}.`
      : typesTarget !== null
        ? `No imports of ${typesTarget} found, but TypeScript can load these types without an import.`
        : conventionPackage
          ? 'No code references found, but this package type is commonly loaded through framework/config conventions.'
          : 'No static imports, requires, dynamic imports, package.json scripts, or recognized configuration references were found.';

  return {
    packageName,
    kind: 'likely-unused',
    confidence: lowConfidence ? 'low' : 'high',
    severity: lowConfidence ? 'info' : 'warning',
    summary: lowConfidence ? `${packageName} may be unused` : `${packageName} appears unused`,
    evidence: {
      kind: 'likely-unused',
      reason,
      scannedFileCount: usage.scannedFileCount,
      truncated: usage.truncated,
    },
  };
}
