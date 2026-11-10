import type { ReactElement } from 'react';
import type { SecurityOutcome } from '../../../src/host/webviewProtocol.js';
import { SeverityBadge } from './SeverityBadge.js';

export function IntroducedSecurityFindings({ security, onOpenAdvisory }: {
  security: SecurityOutcome;
  onOpenAdvisory?: ((packageName: string, advisoryId: string | number, path: string[], reference?: string) => void) | undefined;
}): ReactElement | null {
  if (!security.introduced?.length) return null;
  return <section aria-label="Introduced vulnerabilities">
    <h4>Vulnerabilities added by this upgrade</h4>
    <ul className="security-remaining__list">
      {security.introduced.map((entry) => <li className="security-remaining__item"
        key={`${String(entry.advisory.id)}:${entry.flaggedPackage}`}>
        <SeverityBadge severity={entry.advisory.severity} />{' '}
        <code>{entry.flaggedPackage}@{entry.resolvedVersion}</code>{' '}
        <span>{entry.path.length === 1 ? 'Direct dependency' : 'Transitive dependency'}</span>
        <p>{entry.advisory.title}</p>
        {onOpenAdvisory ? <button type="button" className="button button--subtle"
          onClick={() => onOpenAdvisory(entry.path[0] ?? entry.flaggedPackage, entry.advisory.id, entry.path)}>
          Open advisory
        </button> : null}
      </li>)}
    </ul>
  </section>;
}
