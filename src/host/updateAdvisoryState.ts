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
