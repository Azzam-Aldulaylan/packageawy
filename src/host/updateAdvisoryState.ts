import semver from 'semver';

import type { UpdateAdvisoryContext, UpdateAdvisoryResult } from './webviewProtocol.js';

export function sameUpdateAdvisoryContext(a: UpdateAdvisoryContext | undefined, b: UpdateAdvisoryContext): boolean {
  return a !== undefined && a.scanId === b.scanId && a.projectId === b.projectId &&
    a.sourceGeneration === b.sourceGeneration && a.settingsGeneration === b.settingsGeneration;
}

export function updateAdvisoryKey(name: string, version: string): string {
  return JSON.stringify([name, version]);
}

export function updateAdvisoryWarning(result: UpdateAdvisoryResult | undefined): string | undefined {
  if (result?.status !== 'checked' || result.count === 0) return undefined;
  return `${result.version} has ${result.count} known ${result.count === 1 ? 'vulnerability' : 'vulnerabilities'}. Highest severity: ${result.highestSeverity}.`;
}

/** Short form for the upgrade version list, e.g. "3 vulnerabilities (high)". */
export function updateAdvisoryTag(result: UpdateAdvisoryResult | undefined): string | undefined {
  if (result?.status !== 'checked' || result.count === 0) return undefined;
  return `${result.count} ${result.count === 1 ? 'vulnerability' : 'vulnerabilities'} (${result.highestSeverity})`;
}

/**
 * Whether `version` is the installed one. The installed version's own
 * vulnerabilities belong to the Vulnerabilities column, so offered-version
 * warnings skip it. Valid versions compare by their cleaned form, anything
 * else by exact text. No installed version never matches.
 */
export function isInstalledVersion(current: string | null | undefined, version: string | null): boolean {
  if (current === null || current === undefined || version === null) return false;
  const a = semver.clean(current);
  const b = semver.clean(version);
  return a !== null && b !== null ? a === b : current === version;
}
