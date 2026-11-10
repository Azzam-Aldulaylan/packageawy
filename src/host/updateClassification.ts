/**
 * Major/minor/patch classification for an available update: purely a
 * display/sort decision, never a substitute for upgrade eligibility.
 * Shares its version classifier with the upgrade confirmation. It
 * feeds the "Major" badge and the Updates card's intelligent default sort,
 * and tolerates invalid/missing versions by returning `null` instead of
 * throwing, since a dashboard count must never crash on unexpected data.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

import type { PackageRow } from '../core/types.js';
import { classifyUpdate } from '../core/version/updateClassification.js';
import type { UpdateKind } from '../core/version/updateClassification.js';

export { classifyUpdate };
export type { UpdateKind };

/** Highest tier first: used to rank rows for the Updates card's default sort. */
export const UPDATE_KIND_RANK: Record<UpdateKind, number> = {
  major: 3,
  minor: 2,
  patch: 1,
};

/**
 * Measure the offered upgrade first, so badges and summary counts describe
 * the action's actual target. Rows without an action still classify the
 * available latest/wanted release. `null` when there is nothing to classify.
 */
export function updateTarget(row: PackageRow): string | null {
  if (row.current === null) return null;
  if (row.upgradeTo !== null) return row.upgradeTo;
  if (row.latest !== null && row.latest !== row.current) return row.latest;
  if (row.wanted !== null && row.wanted !== row.current) return row.wanted;
  return null;
}

export function classifyRowUpdate(row: PackageRow): UpdateKind | null {
  const target = updateTarget(row);
  if (row.current === null || target === null) return null;
  return classifyUpdate(row.current, target);
}
