/**
 * Pure row filtering for on-screen hygiene findings.
 */

import type { DependencyFinding } from '../core/hygiene/types.js';
import type { PackageRow } from '../core/types.js';

export type HygieneFilterId = 'all' | 'likely-unused';

export function rowMatchesHygieneFilter(
  row: PackageRow,
  filter: HygieneFilterId,
  findings: readonly DependencyFinding[]
): boolean {
  if (filter === 'all') return true;
  return findings.some((finding) => finding.kind === 'likely-unused' && finding.packageName === row.name);
}

export function hygieneFilterPredicate(
  filter: HygieneFilterId,
  findings: readonly DependencyFinding[]
): (row: PackageRow) => boolean {
  return (row) => rowMatchesHygieneFilter(row, filter, findings);
}

export function hygieneFilterCounts(
  rows: readonly PackageRow[],
  findings: readonly DependencyFinding[]
): Record<Exclude<HygieneFilterId, 'all'>, number> {
  let likelyUnused = 0;
  for (const row of rows) {
    if (rowMatchesHygieneFilter(row, 'likely-unused', findings)) likelyUnused += 1;
  }
  return { 'likely-unused': likelyUnused };
}
