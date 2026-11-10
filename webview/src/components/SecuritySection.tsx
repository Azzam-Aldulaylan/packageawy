import type { ReactElement } from 'react';

import { IntroducedSecurityFindings } from './IntroducedSecurityFindings.js';
import { securityOutcomeDisplay } from '../../../src/host/outcomeCopy.js';
import { unaffectedElsewhereText } from '../../../src/host/upgradeSecuritySummary.js';
import type { SecurityOutcome } from '../../../src/host/webviewProtocol.js';
import { IconShield } from '../icons.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { VulnerabilityCard } from './VulnerabilityCard.js';

function overallDetail(security: SecurityOutcome): string | undefined {
  if (security.checkState === 'off' || security.checkState === 'unavailable') return undefined;
  if (security.introduced?.length) return `${security.introduced.length} known vulnerabilit${security.introduced.length === 1 ? 'y is' : 'ies are'} added by this upgrade.`;
  const resolvedCount = security.resolvedAdvisories.length;
  const remainingCount = security.remaining.filter((r) => r.status === 'remains').length;
  const unknownCount = security.remaining.filter((r) => r.status === 'unknown').length;

  if (security.status === 'resolved') {
    return resolvedCount === 1
      ? '1 vulnerability resolved by this upgrade.'
      : `${resolvedCount} vulnerabilities resolved by this upgrade.`;
  }
  if (security.status === 'remains') {
    const parts: string[] = [];
    if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
    parts.push(`${remainingCount} remain${remainingCount === 1 ? 's' : ''}`);
    if (unknownCount > 0) parts.push(`${unknownCount} undetermined`);
    return parts.join(', ') + '.';
  }
  if (security.status === 'unknown') {
    return 'Some vulnerabilities could not be confirmed as fixed or remaining without deeper resolver evidence.';
  }
  return undefined;
}

export function SecuritySection({
  security,
  rootPackageName,
  onOpenAdvisory,
  emphasize,
  advisoriesOff = false,
}: {
  security: SecurityOutcome | null;
  rootPackageName: string;
  onOpenAdvisory: (packageName: string, advisoryId: string | number, path: string[], reference?: string) => void;
  emphasize: boolean;
  /** No advisory facts exist, so a null outcome must not read as "No known vulnerabilities". */
  advisoriesOff?: boolean;
}): ReactElement {
  const display = advisoriesOff || security?.checkState === 'off'
    ? { label: 'Off', className: 'unknown' }
    : security === null || security.checkState === 'unavailable'
      ? { label: 'Security check unavailable', className: 'unknown' }
      : security.introduced?.length
        ? { label: 'Upgrade adds known vulnerabilities', className: 'remains' }
        : securityOutcomeDisplay(security.status);

  return (
    <section
      className={`analysis-card analysis-card--full${emphasize ? ' analysis-card--emphasized' : ''}`}
      aria-labelledby="analysis-security-heading"
    >
      <h3 className="analysis-card__title" id="analysis-security-heading">
        <IconShield className="analysis-card__title-icon" />
        Security
      </h3>
      <OutcomeStatus label={display.label} className={display.className} detail={security === null ? undefined : overallDetail(security)} />

      {security !== null ? <IntroducedSecurityFindings security={security} onOpenAdvisory={onOpenAdvisory} /> : null}
      {security !== null && security.remaining.length > 0 ? (
        <ul className="advisories analysis-card__vulnerabilities">
          {security.remaining.map((entry) => (
            <VulnerabilityCard
              advisory={entry.advisory}
              flaggedPackage={entry.flaggedPackage}
              path={entry.path}
              patchedVersion={entry.patchedVersion}
              resolvedVersion={entry.resolvedVersion}
              rootPackageName={entry.path[0] ?? rootPackageName}
              onOpenAdvisory={onOpenAdvisory}
              key={`${String(entry.advisory.id)}:${entry.flaggedPackage}`}
            />
          ))}
        </ul>
      ) : null}
      {security === null || unaffectedElsewhereText(security) === null ? null : (
        <p className="security-outcome__elsewhere">{unaffectedElsewhereText(security)}</p>
      )}
    </section>
  );
}
