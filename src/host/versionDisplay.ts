/**
 * Pure display decision for the Available column.
 *
 * The bold value is the version the Upgrade button and the upgrade review
 * start on (`upgradeTo`), so the table, the action and the review always
 * name the same version. Rows with no offered upgrade (already current,
 * npm aliases, catalog-owned versions) fall back to Latest, then Wanted.
 * When the offered version is not the latest, Latest is shown underneath.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 */

import type { PackageRow, UnresolvableReason } from '../core/types.js';
import type { UpdateKind } from './updateClassification.js';
import { classifyUpdate } from './updateClassification.js';

export type AvailableVersionCaption =
  /** The bold value is the latest release, ahead of what is installed. */
  | { kind: 'latest' }
  /** As above, and a plain install within the declared range already gets it. */
  | { kind: 'latest-within-range' }
  /** The bold value is an offered upgrade that is not the latest release. */
  | { kind: 'other-latest'; version: string };

export type AvailableVersionDisplay =
  | { kind: 'dash' }
  | {
      kind: 'version';
      value: string;
      /** True when `value` is the offered upgrade (`upgradeTo`). */
      suggested: boolean;
      caption: AvailableVersionCaption | null;
      updateKind: UpdateKind | null;
    };

type AvailableVersionFields = Pick<PackageRow, 'current' | 'wanted' | 'latest' | 'upgradeTo'>;

/** The single version the Available column shows and sorts by. */
export function availablePrimaryVersion(row: Pick<PackageRow, 'wanted' | 'latest' | 'upgradeTo'>): string | null {
  return row.upgradeTo ?? row.latest ?? row.wanted ?? null;
}

export function availableVersionDisplay(row: AvailableVersionFields): AvailableVersionDisplay {
  const value = availablePrimaryVersion(row);
  if (value === null) return { kind: 'dash' };

  const { current, wanted, latest } = row;
  const hasUpdate = current !== null && value !== current;
  const updateKind = hasUpdate && current !== null ? classifyUpdate(current, value) : null;
  let caption: AvailableVersionCaption | null = null;
  if (latest !== null && value !== latest) caption = { kind: 'other-latest', version: latest };
  else if (hasUpdate && value === latest) caption = wanted === latest ? { kind: 'latest-within-range' } : { kind: 'latest' };

  return { kind: 'version', value, suggested: row.upgradeTo !== null, caption, updateKind };
}

/**
 * A row's tag can be a real `UnresolvableReason` (workspace link, file:/
 * git:/npm:-alias/tarball specifier, or genuinely no lockfile at all) or the
 * generic `'unresolved'` marker used for a row that has none of those
 * reasons but still has no resolved version: a dependency declared in
 * package.json but missing from an otherwise-present lockfile (not yet
 * installed, or the lockfile has drifted). Deliberately a distinct value
 * from `UnresolvableReason` rather than reusing `'no-lockfile'`: this row's
 * `unresolvable` field itself stays undefined, so pipeline fetching (Wanted/
 * Latest) is never skipped for it, only the display layer needs to know
 * "no resolved version" to decide whether to tag it.
 */
export type CurrentVersionTag = UnresolvableReason | 'unresolved';

export type CurrentVersionDisplay =
  | { kind: 'resolved'; value: string; tag: CurrentVersionTag | null }
  | { kind: 'declared-range'; value: string; tag: CurrentVersionTag }
  | { kind: 'dash'; tag: CurrentVersionTag };

/**
 * The Current column's display decision: display only, never a stand-in
 * for `PackageRow.current` itself: a `'declared-range'` result is a
 * package.json spec/range (e.g. "^18.2.0" or "file:../x"), not a real
 * installed version, and must never be treated as one (upgrade eligibility
 * in particular keys off `current` staying null. See that field's doc).
 *
 * Falls back to the declared range only when there's no resolved version at
 * all: the common case this covers is a workspace link, an unresolvable
 * specifier, or no lockfile, all of which pair `current: null` with a
 * non-empty `range` the caller already has for free from `PackageRow`.
 *
 * The tag is shown whenever there's a reason to (an explicit
 * `unresolvable`) OR whenever `current` is null at all, even when
 * `unresolvable` is undefined, a null `current` means whatever is shown is
 * not a real installed version, and must never be presented as if it were
 * one. Without this, a declared dependency merely missing from an
 * otherwise-present lockfile would show its bare range with no tag,
 * indistinguishable from a real lockfile-resolved version.
 */
export function currentVersionDisplay(
  current: string | null,
  range: string,
  unresolvable: UnresolvableReason | undefined
): CurrentVersionDisplay {
  if (current !== null) return { kind: 'resolved', value: current, tag: unresolvable ?? null };
  const tag: CurrentVersionTag = unresolvable ?? 'unresolved';
  if (range !== '') return { kind: 'declared-range', value: range, tag };
  return { kind: 'dash', tag };
}
