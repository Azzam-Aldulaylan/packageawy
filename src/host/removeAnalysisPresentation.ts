/**
 * Assembles the one JSON-safe payload the remove review/confirm modal
 * renders from: the removal analog of upgradeAnalysisPresentation.ts. See
 * that file's comment for why the wire shape lives in webviewProtocol.ts
 * rather than here.
 */

import type { DependencyClassification } from '../core/upgrade/plan.js';
import { buildUpgradeAnalysisVerification } from './upgradeAnalysisPresentation.js';
import type { RemoveAnalysisPresentation } from './webviewProtocol.js';

export interface BuildRemoveAnalysisPresentationOptions {
  analysisId: string;
  analyzedAt: string;
  expiresAt: string;
  /** The first, host-validated package in the requested removal. See BulkUpgradeMessage's anchor-package convention. */
  packageName: string;
  changes: readonly {
    packageName: string;
    classification: DependencyClassification;
    stillRequiredBy: readonly string[];
  }[];
  verificationScriptNames: readonly string[];
  suggestedScriptNames?: readonly string[];
  manifestPath: string;
  lockfilePath: string;
}

export function buildRemoveAnalysisPresentation(
  options: BuildRemoveAnalysisPresentationOptions
): RemoveAnalysisPresentation {
  return {
    analysisId: options.analysisId,
    analyzedAt: options.analyzedAt,
    expiresAt: options.expiresAt,
    package: options.packageName,
    changes: options.changes.map((change) => ({
      packageName: change.packageName,
      classification: change.classification,
      stillRequiredBy: [...change.stillRequiredBy],
    })),
    verification: buildUpgradeAnalysisVerification(options.verificationScriptNames, options.suggestedScriptNames),
    files: {
      manifestPath: options.manifestPath,
      lockfilePath: options.lockfilePath,
      // Same guarantee as an upgrade transaction: runUpgradeTransaction
      // always attempts a compare-and-swap restore of exactly these two
      // allowlisted files on failure.
      rollbackAvailable: true,
    },
  };
}
