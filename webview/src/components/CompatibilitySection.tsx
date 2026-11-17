import { useState } from 'react';
import type { ReactElement } from 'react';

import { findingCopy } from '../../../src/host/findingCopy.js';
import { compatibilityOutcomeDisplay, resolverOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import { dependencyWarningCount } from '../../../src/host/upgradeReviewDecision.js';
import type { CompatibilityFinding, UpgradeAnalysisCompatibility } from '../../../src/host/webviewProtocol.js';
import { IconRoute } from '../icons.js';
import { OutcomeStatus } from './OutcomeStatus.js';

const DEFAULT_VISIBLE_CAP = 3;

function FindingItem({ finding, context }: { finding: CompatibilityFinding; context: { package: string; currentVersion: string } }): ReactElement {
  const copy = findingCopy(finding, context);
  const display = compatibilityOutcomeDisplay(finding.status);
  return (
    <li className={`finding finding--${display.className}`} data-finding-id={finding.id}>
      <OutcomeStatus
        label={finding.status === 'warning' ? `Warning: ${copy.label}` : copy.label}
        className={display.className}
        detail={
          <>
            {copy.lines.map((entry, index) => (
              <span className="finding__line" key={index}>
                {entry.code === true ? <code>{entry.text}</code> : entry.text}
              </span>
            ))}
          </>
        }
      />
    </li>
  );
}

/**
 * The Compatibility card: the reasons behind whatever the modal's own
 * overall status banner already announced, never a second announcement of
 * the same headline. Warning and conflict causes lead. Successful resolution
 * cannot hide a static warning about application compatibility.
 */
export function CompatibilityFindings({
  compatibility,
  context,
}: {
  compatibility: UpgradeAnalysisCompatibility;
  context: { package: string; currentVersion: string };
}): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const nonCompatible = compatibility.findings.filter((f) => f.status !== 'compatible');
  const conflicts = nonCompatible.filter((f) => f.status === 'conflict');
  const warnings = nonCompatible.filter((f) => f.status === 'warning');
  const rest = nonCompatible.filter((f) => f.status !== 'conflict' && f.status !== 'warning');
  // Every signal cause is visible as soon as its section opens.
  const restCap = Math.max(0, DEFAULT_VISIBLE_CAP - conflicts.length - warnings.length);
  const visibleRest = expanded ? rest : rest.slice(0, restCap);
  const visibleCompatible = expanded ? compatibility.findings.filter((f) => f.status === 'compatible') : [];
  const visible = [...conflicts, ...warnings, ...visibleRest, ...visibleCompatible];
  const hiddenCount = compatibility.findings.length - visible.length;
  const resolver = compatibility.resolverVerification;
  const resolverNeedsReview = resolver?.status === 'warning' || resolver?.status === 'conflict';
  const resolverItem = resolver === undefined ? null : (
    <OutcomeStatus
      label={resolver.status === 'warning' ? `Warning: ${resolverOutcomeDisplay(resolver.status).label}` : resolverOutcomeDisplay(resolver.status).label}
      className={resolverOutcomeDisplay(resolver.status).className}
      detail={resolverNeedsReview
        ? <>{resolver.explanation} Review the package manager findings before upgrading.</>
        : resolver.status === 'unknown'
          ? 'Static checks completed, but npm/pnpm verification was unavailable.'
          : `${resolver.packageManager} resolved the proposed dependency tree.`}
    />
  );

  return (
    <div className="compatibility-findings">
      {resolverNeedsReview ? resolverItem : null}
      {compatibility.status === 'warning' && dependencyWarningCount(compatibility) === 0 ? (
        <OutcomeStatus
          label="Warning details unavailable"
          className="warning"
          detail="Analyze again to get the dependency warning details before upgrading."
        />
      ) : null}

      {visible.length > 0 ? (
        <ul className="finding-list">
          {visible.map((finding) => (
            <FindingItem finding={finding} context={context} key={finding.id} />
          ))}
        </ul>
      ) : null}

      {!resolverNeedsReview ? resolverItem : null}

      {compatibility.status !== 'warning' && resolver === undefined && visible.length === 0 ? (
        <p className="analysis-card__hint">No peer-dependency or resolver signals were available to check for this package.</p>
      ) : null}

      {hiddenCount > 0 ? (
        <button type="button" className="button button--subtle analysis-card__more" onClick={() => setExpanded(true)}>
          Show {hiddenCount} more finding{hiddenCount === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}

export function CompatibilitySection({
  compatibility,
  context,
}: {
  compatibility: UpgradeAnalysisCompatibility;
  context: { package: string; currentVersion: string };
}): ReactElement {
  return (
    <section className="analysis-card analysis-card--full compatibility-card" aria-labelledby="analysis-compatibility-heading">
      <h3 className="analysis-card__title" id="analysis-compatibility-heading">
        <IconRoute className="analysis-card__title-icon" />
        Compatibility
      </h3>
      <CompatibilityFindings compatibility={compatibility} context={context} />
    </section>
  );
}
