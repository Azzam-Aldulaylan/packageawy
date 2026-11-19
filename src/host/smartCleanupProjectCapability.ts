import type { OtherPackageManager } from '../core/manifest/parse.js';
import type { PackageManagerKind } from '../core/types.js';
import type { MutationTargetResolution } from './mutationTarget.js';
import { otherPackageManagerMessage, requireMutationTarget } from './packageManagerSupport.js';

export interface SmartCleanupProjectSource {
  packageManager: PackageManagerKind;
  importerId: string;
  lockfileName: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
  otherPackageManager?: OtherPackageManager | null;
  mutationTarget?: MutationTargetResolution | null;
}

export type SmartCleanupProjectCapability =
  | { executionSupported: true }
  | { executionSupported: false; reason: string };

/**
 * Removal-first execution is intentionally narrower than read-only analysis.
 * Workspace members sharing a root lockfile, lockfile-less projects, and
 * npm-shrinkwrap projects remain analysis-only until their whole-workspace
 * mutation semantics have dedicated coverage.
 */
export function smartCleanupProjectCapability(
  source: SmartCleanupProjectSource
): SmartCleanupProjectCapability {
  if (source.otherPackageManager !== undefined && source.otherPackageManager !== null) {
    return { executionSupported: false, reason: otherPackageManagerMessage(source.otherPackageManager) };
  }
  if (source.importerId !== '.') {
    const removal = requireMutationTarget(source);
    const advice = removal.ok
      ? 'You can remove it from Manage dependency.'
      : removal.error.message;
    return {
      executionSupported: false,
      reason: ["This package shares the workspace lockfile, so Smart Cleanup can't remove it here.", advice].filter(Boolean).join(' '),
    };
  }
  if (source.lockfileName === null) {
    return {
      executionSupported: false,
      reason: 'Smart Cleanup needs a package-lock.json or pnpm-lock.yaml to remove packages.',
    };
  }
  if (source.lockfileName === 'npm-shrinkwrap.json') {
    return {
      executionSupported: false,
      reason: "Smart Cleanup can't remove packages in projects that use npm-shrinkwrap.json.",
    };
  }
  if (source.packageManager !== 'npm' && source.packageManager !== 'pnpm') {
    return {
      executionSupported: false,
      reason: `Smart Cleanup can't remove packages in projects that use ${source.packageManager}.`,
    };
  }
  return { executionSupported: true };
}
