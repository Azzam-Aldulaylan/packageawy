import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { UpdateKind } from '../../../src/host/updateClassification.js';
import type { AvailableVersionCaption, CurrentVersionTag } from '../../../src/host/versionDisplay.js';
import { availableVersionDisplay, currentVersionDisplay } from '../../../src/host/versionDisplay.js';
import { SIGN_IN_CELL_LABEL, registrySignInCellTitle } from '../../../src/host/registrySignIn.js';
import { StatusBadge } from './StatusBadge.js';
import { InfoTooltip } from './Tooltip.js';
import { UpdateVersionWarning } from './UpdateVersionWarning.js';

const TAG_LABELS: Record<CurrentVersionTag, string> = {
  'workspace-link': 'workspace',
  file: 'file:',
  git: 'git',
  alias: 'alias',
  tarball: 'tarball',
  'no-lockfile': 'unresolved',
  unresolved: 'unresolved',
};

/**
 * Same terminology `npm outdated` uses for its Current/Wanted/Latest
 * columns, so the meanings carry over for anyone already familiar with it.
 */
const CURRENT_EXPLANATION = 'Version installed according to the lockfile.';
const WANTED_EXPLANATION = 'Newest version allowed by the range in package.json.';
const LATEST_EXPLANATION = 'Newest stable version published to npm.';
const SUGGESTED_EXPLANATION =
  'The version shown in bold is the one the Upgrade button installs. It is usually the latest, or a smaller security fix when one is available.';

const CLASSIFICATION_LABEL: Record<UpdateKind, string> = { major: 'Major', minor: 'Minor', patch: 'Patch' };
/** Only Major gets a colour accent: routine minor/patch bumps stay neutral so the row isn't shouting. */
const CLASSIFICATION_TONE: Record<UpdateKind, 'neutral' | 'warning'> = {
  major: 'warning',
  minor: 'neutral',
  patch: 'neutral',
};

function ClassificationBadge({ kind }: { kind: UpdateKind | null }): ReactElement | null {
  if (kind === null) return null;
  return <StatusBadge label={CLASSIFICATION_LABEL[kind]} tone={CLASSIFICATION_TONE[kind]} />;
}

export function CurrentVersionCell({ row }: { row: PackageRow }): ReactElement {
  const display = currentVersionDisplay(row.current, row.range, row.unresolvable);
  const text = display.kind === 'dash' ? '—' : display.value;
  if (display.tag === null) return <>{text}</>;
  return (
    <>
      {text} <StatusBadge label={TAG_LABELS[display.tag]} />
    </>
  );
}

function availableCaptionText(caption: AvailableVersionCaption): string {
  if (caption.kind === 'latest') return 'Latest';
  if (caption.kind === 'latest-within-range') return 'Latest · within range';
  return `Latest: ${caption.version}`;
}

/**
 * The Available column. The bold value is the version the Upgrade button
 * installs (see availableVersionDisplay), and only that offered version gets
 * a warning triangle when it has known vulnerabilities. The installed
 * version's own findings stay in the Vulnerabilities column.
 */
export function AvailableVersionCell({
  row,
  resolutionAvailable = true,
  signInHost,
}: {
  row: PackageRow;
  resolutionAvailable?: boolean;
  /** Registry host that asked for sign-in for this package, if any. */
  signInHost?: string | undefined;
}): ReactElement {
  const name = row.registryName ?? row.name;
  const unavailable = resolutionAvailable ? null : signInHost !== undefined ? (
    <span className="version-cell__caption" title={registrySignInCellTitle(signInHost)}>
      {SIGN_IN_CELL_LABEL}
    </span>
  ) : (
    <span className="version-cell__caption">Unavailable</span>
  );
  // Without registry metadata only an audit-found security fix still stands:
  // show it with the metadata problem as its caption.
  if (unavailable !== null && row.upgradeTo === null) return unavailable;

  const display = availableVersionDisplay(row);
  if (display.kind === 'dash') return <span aria-hidden="true">—</span>;

  const { caption } = display;
  return (
    <span className="version-cell">
      <span className="version-cell__row">
        <span className={caption?.kind === 'other-latest' ? 'version-cell__value version-cell__value--primary' : 'version-cell__value'}>
          {display.value}
        </span>
        {display.suggested ? <UpdateVersionWarning name={name} version={display.value} current={row.current} /> : null}
        <ClassificationBadge kind={display.updateKind} />
      </span>
      {unavailable ?? (caption === null ? null : (
        <span className={caption.kind === 'other-latest' ? 'version-cell__caption version-cell__caption--muted' : 'version-cell__caption'}>
          {availableCaptionText(caption)}
        </span>
      ))}
    </span>
  );
}

/**
 * Header content only, never a `<th>` itself. PackageTable's sortable
 * header wraps every column's label in a `<button>` to carry the click
 * handler, and a `<button>` cannot contain another interactive element
 * (the Available column's info trigger below), so that trigger has to be
 * a sibling passed separately rather than nested inside this label.
 */
export function CurrentHeaderLabel(): ReactElement {
  return <>Current</>;
}

/**
 * The Current column's terminology affordance: same hover/focus/click
 * InfoTooltip pattern as AvailableHeaderInfo below, so "Current" is not the
 * one header explained only through a native `title` (hover-only, not
 * keyboard-reachable). Rendered as SortableHeader's sibling `extra`, not
 * nested inside the sort button, for the same reason as AvailableHeaderInfo.
 */
export function CurrentHeaderInfo(): ReactElement {
  return <InfoTooltip label="What Current means" content={<p>{CURRENT_EXPLANATION}</p>} />;
}

export function AvailableHeaderLabel(): ReactElement {
  return <>Available</>;
}

/**
 * The Available column's terminology affordance: a single icon covering
 * Current/Wanted/Latest together, since the compact cell above no longer
 * always shows a "Wanted"/"Latest" text label to hang a tooltip off of
 * directly. Rendered as PackageTable's sortable header's sibling `extra`,
 * not nested inside the sort button. See this file's header-label doc.
 * Opens on hover, click, or keyboard focus (see InfoTooltip).
 */
export function AvailableHeaderInfo(): ReactElement {
  return (
    <InfoTooltip
      label="Version terminology"
      content={
        <dl>
          <dt>Current</dt>
          <dd>{CURRENT_EXPLANATION}</dd>
          <dt>Wanted</dt>
          <dd>{WANTED_EXPLANATION}</dd>
          <dt>Latest</dt>
          <dd>{LATEST_EXPLANATION}</dd>
          <dt>Suggested</dt>
          <dd>{SUGGESTED_EXPLANATION}</dd>
        </dl>
      }
    />
  );
}
