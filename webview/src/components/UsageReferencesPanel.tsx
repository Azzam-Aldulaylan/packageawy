import { useState } from 'react';
import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { DependencyFinding } from '../../../src/core/hygiene/types.js';
import type { DependencyReference, DependencyUsageResult } from '../../../src/core/usage/types.js';
import {
  deprecatedFindingFor,
  usageSignificanceCopy,
  usageScopeLabel,
  usageSummaryCounts,
} from '../../../src/host/dependencyDetailsCopy.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';
import {
  IconAlertTriangle,
  IconBroom,
  IconCheck,
  IconChevronRight,
  IconFile,
  IconRefresh,
  IconTarget,
} from '../icons.js';
import type { ManageTabId } from './ManageDependencyModal.js';

export type UsageRequestState =
  | { phase: 'analyzing' }
  | { phase: 'done'; usageId: string; result: DependencyUsageResult; cacheExpiresAt: string; fromCache: boolean }
  | { phase: 'error'; message: string };

const REFERENCE_PREVIEW_LIMIT = 5;

/** A compact "label / value" row: same shape used across every tab in this workspace (see OverviewPanel.tsx's GlanceRow). */
function GlanceRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div className="manage-glance__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function analyzedAge(scannedAt: string, now: number): string {
  const timestamp = Date.parse(scannedAt);
  if (!Number.isFinite(timestamp)) return 'Analyzed previously';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return 'Analyzed just now';
  if (minutes === 1) return 'Analyzed 1 minute ago';
  return `Analyzed ${minutes} minutes ago`;
}

function referenceLocationLabel(reference: DependencyReference): string {
  if (reference.kind === 'script') return `package.json script "${reference.context ?? ''}"`;
  if (reference.kind === 'config') return reference.context !== undefined ? `${reference.filePath} (${reference.context})` : reference.filePath;
  return reference.filePath;
}

/**
 * One usage reference: file/location, snippet, line. Opening it always
 * goes through the existing host-owned `open-usage-reference` trust
 * boundary (usageId + index only). A script/config reference has no
 * meaningful editor location to jump to, so it renders as static text
 * instead of a button, never a fabricated click target.
 */
function ReferenceRow({
  usageId,
  reference,
  index,
  onOpenReference,
}: {
  usageId: string;
  reference: DependencyReference;
  index: number;
  onOpenReference: (usageId: string, referenceIndex: number) => void;
}): ReactElement {
  const openable = reference.kind !== 'script' && reference.kind !== 'config';
  const body = (
    <>
      <IconFile className="usage-ref__icon" aria-hidden="true" />
      <span className="usage-ref__location">
        <span className="usage-ref__path">{referenceLocationLabel(reference)}</span>
        <code className="usage-ref__snippet">{reference.snippet}</code>
      </span>
      {reference.line > 0 ? <span className="usage-ref__line">Line {reference.line}</span> : null}
    </>
  );
  return (
    <li className="usage-ref">
      {openable ? (
        <button type="button" className="usage-ref__button" onClick={() => onOpenReference(usageId, index)}>
          {body}
        </button>
      ) : (
        <span className="usage-ref__button usage-ref__button--static">{body}</span>
      )}
    </li>
  );
}

/**
 * "Where is this used?": the full reference list, reusing exactly the
 * usage-analysis state Overview's glance row already summarizes (never a
 * second scan). Running/complete/error/stale are all distinct, named
 * states: a stale cached result is never presented as fresh.
 */
function WhereUsedCard({
  row,
  usage,
  now,
  onReanalyze,
  onOpenReference,
}: {
  row: PackageRow;
  usage: UsageRequestState | undefined;
  now: number;
  onReanalyze: () => void;
  onOpenReference: (usageId: string, referenceIndex: number) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="analysis-card usage-detail-card usage-detail-card--references" aria-labelledby="usage-where-heading">
      <div className="usage-card__head">
        <h3 className="analysis-card__title" id="usage-where-heading">
          <IconTarget className="analysis-card__title-icon" />
          Where is this used?
        </h3>
        {usage !== undefined && usage.phase === 'done' ? (
          <span className="usage-status usage-status--ok">
            <IconCheck className="usage-status__icon" />
            Analysis complete
          </span>
        ) : null}
      </div>
      <p className="usage-card__subtitle">Files and locations that import {row.name}.</p>

      {usage === undefined || usage.phase === 'analyzing' ? (
        <p className="usage-status">
          <IconRefresh className="usage-status__icon usage-status__icon--spin" />
          Checking usage…
        </p>
      ) : usage.phase === 'error' ? (
        <div className="usage-card__error">
          <p className="usage-status usage-status--error">
            <IconAlertTriangle className="usage-status__icon" />
            {usage.message}
          </p>
          <button type="button" className="button button--subtle" onClick={onReanalyze}>
            <IconRefresh />
            Re-analyze
          </button>
        </div>
      ) : (
        <>
          <div className="usage-card__meta">
            <p className="usage-card__meta-text">
              {analyzedAge(usage.result.scannedAt, now)}
              {usage.fromCache ? ' · cached' : ''}
            </p>
            <button type="button" className="button button--subtle" onClick={onReanalyze}>
              <IconRefresh />
              Re-analyze
            </button>
          </div>
          {usage.result.references.length === 0 ? (
            <p className="usage-card__empty">No references to {row.name} were found in this scan.</p>
          ) : (
            <>
              <ul className="usage-ref-list">
                {(expanded ? usage.result.references : usage.result.references.slice(0, REFERENCE_PREVIEW_LIMIT)).map(
                  (reference, index) => (
                    <ReferenceRow key={index} usageId={usage.usageId} reference={reference} index={index} onOpenReference={onOpenReference} />
                  )
                )}
              </ul>
              {!expanded && usage.result.references.length > REFERENCE_PREVIEW_LIMIT ? (
                <button type="button" className="usage-show-all" onClick={() => setExpanded(true)}>
                  Show all {usage.result.references.length} references
                  <IconChevronRight className="usage-show-all__icon" />
                </button>
              ) : null}
              {usage.result.truncated ? <p className="usage-card__truncated">Scan was capped, so results may be incomplete.</p> : null}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** One compact stat in the Hygiene grid: same shell for every finding, positive or negative, so "No" is a first-class, equally visible answer. */
function HygieneStat({
  ok,
  icon,
  label,
  value,
  onActivate,
}: {
  ok: boolean;
  icon: ReactElement;
  label: string;
  value: ReactElement | string;
  onActivate?: () => void;
}): ReactElement {
  const className = `hygiene-strip__item${ok ? '' : ' hygiene-strip__item--warn'}`;
  const content = (
    <>
      <span className="hygiene-strip__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="hygiene-strip__label">{label}</span>
      <span className="hygiene-strip__value">{value}</span>
    </>
  );
  if (onActivate === undefined) return <div className={className}>{content}</div>;
  return (
    <button type="button" className={`${className} hygiene-strip__item--link`} onClick={onActivate}>
      {content}
    </button>
  );
}

/**
 * The compact hygiene status strip: Deprecated / Likely unused / Security
 * issues, always all three, "No" included, so a clean
 * package reads as clearly clean rather than an empty section. Security
 * issues never repeats the full advisory list here (see
 * VulnerabilitiesPanel.tsx for that): it links there instead.
 */
function HygieneCard({
  row,
  deprecated,
  unusedFinding,
  onChangeTab,
}: {
  row: PackageRow;
  deprecated: DependencyFinding | undefined;
  unusedFinding: DependencyFinding | undefined;
  onChangeTab: (tab: ManageTabId) => void;
}): ReactElement {
  const worst = row.worstSeverity;
  const needsAttention = deprecated !== undefined || unusedFinding !== undefined || worst !== null;

  return (
    <section
      className={`analysis-card usage-detail-card usage-detail-card--hygiene${needsAttention ? ' usage-detail-card--warning' : ''}`}
      aria-labelledby="usage-hygiene-heading"
    >
      <h3 className="analysis-card__title" id="usage-hygiene-heading">
        <IconBroom className="analysis-card__title-icon" />
        Hygiene
      </h3>
      <div className="hygiene-strip">
        <HygieneStat
          ok={deprecated === undefined}
          icon={deprecated === undefined ? <IconCheck /> : <IconAlertTriangle />}
          label="Deprecated"
          value={deprecated === undefined ? 'No' : 'Yes'}
        />
        <HygieneStat
          ok={unusedFinding === undefined}
          icon={unusedFinding === undefined ? <IconCheck /> : <IconAlertTriangle />}
          label="Likely unused"
          value={unusedFinding === undefined ? 'No' : unusedFinding.confidence === 'high' ? 'Yes' : 'Possibly'}
        />
        <HygieneStat
          ok={worst === null}
          icon={worst === null ? <IconCheck /> : <IconAlertTriangle />}
          label="Security issues"
          value={worst === null ? 'None' : `${row.advisories.length} (worst: ${severityDisplay(worst).label})`}
          onActivate={() => onChangeTab('vulnerabilities')}
        />
      </div>
      <button type="button" className="hygiene-strip__removal-link" onClick={() => onChangeTab('removal')}>
        Review removal
        <IconChevronRight />
      </button>
    </section>
  );
}

/**
 * The Usage & references tab (full advisories live in VulnerabilitiesPanel.
 * See the tab split in ManageDependencyModal.tsx), laid out as a left summary rail beside the full detail sections
 * on the right, matching Overview and Vulnerabilities' own shell.
 */
export function UsageReferencesPanel({
  row,
  hygieneFindings,
  usage,
  onReanalyzeUsage,
  onOpenUsageReference,
  onChangeTab,
  now,
}: {
  row: PackageRow;
  hygieneFindings: readonly DependencyFinding[];
  usage: UsageRequestState | undefined;
  onReanalyzeUsage: (packageName: string) => void;
  onOpenUsageReference: (usageId: string, referenceIndex: number) => void;
  onChangeTab: (tab: ManageTabId) => void;
  now: number;
}): ReactElement {
  const deprecated = deprecatedFindingFor(hygieneFindings, row.name);
  const unusedFinding = hygieneFindings.find((finding) => finding.kind === 'likely-unused' && finding.packageName === row.name);

  const counts = usage !== undefined && usage.phase === 'done' ? usageSummaryCounts(usage.result.references) : null;

  return (
    <div className="usage-tab">
      <div className="usage-tab__summary">
        <section className="manage-summary-block usage-summary-card usage-summary-card--primary" aria-labelledby="usage-summary-heading">
          <h3 className="manage-section-heading" id="usage-summary-heading">
            Usage summary
          </h3>
          <dl className="manage-glance">
            <GlanceRow label="Usage scope">{counts === null ? '—' : usageScopeLabel(counts)}</GlanceRow>
            <GlanceRow label="Referenced in">{counts === null ? '—' : `${counts.referencedInFiles} file${counts.referencedInFiles === 1 ? '' : 's'}`}</GlanceRow>
            <GlanceRow label="Import statements">{counts === null ? '—' : `${counts.importStatements}`}</GlanceRow>
            <GlanceRow label="Dynamic imports">{counts === null ? '—' : `${counts.dynamicImports}`}</GlanceRow>
            <GlanceRow label="Package.json scripts">{counts === null ? '—' : `${counts.scripts}`}</GlanceRow>
            <GlanceRow label="Config references">{counts === null ? '—' : `${counts.configReferences}`}</GlanceRow>
          </dl>
        </section>

        <section className="vuln-recommended usage-summary-card usage-summary-card--insight" aria-labelledby="usage-why-it-matters-heading">
          <h3 className="manage-section-heading" id="usage-why-it-matters-heading">
            Why it matters
          </h3>
          <p className="vuln-recommended__message">{usageSignificanceCopy(row, counts)}</p>
        </section>
      </div>

      <div className="usage-tab__details">
        <WhereUsedCard
          row={row}
          usage={usage}
          now={now}
          onReanalyze={() => onReanalyzeUsage(row.name)}
          onOpenReference={onOpenUsageReference}
        />
        <HygieneCard row={row} deprecated={deprecated} unusedFinding={unusedFinding} onChangeTab={onChangeTab} />
      </div>
    </div>
  );
}
