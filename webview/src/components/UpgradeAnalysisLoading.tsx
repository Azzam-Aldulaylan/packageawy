import type { ReactElement } from 'react';
import { AnalysisLoading } from './AnalysisLoading.js';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { upgradeReviewHasIncompleteChecks } from '../../../src/host/upgradeReviewUiState.js';

export function UpgradeSummarySkeleton(): ReactElement {
  return <div className="upgrade-summary-skeleton" aria-hidden="true">
    <span className="upgrade-skeleton-line" />
    <span className="upgrade-skeleton-line upgrade-skeleton-line--short" />
  </div>;
}

/** Static placeholders respect reduced motion without a separate animation mode. */
export function UpgradeAnalysisLoading(): ReactElement {
  return <div className="upgrade-tab">
    <AnalysisLoading label="Analyzing upgrade..." detail="Checking compatibility, security and project files" />
    <div className="upgrade-tab__details" aria-hidden="true">
      {['Dependency compatibility', 'Project compatibility', 'Security impact', 'Planned dependency changes', 'Verification'].map((label) => (
        <div className="upgrade-section-skeleton" key={label}>
          <span>{label}</span>
          <span className="upgrade-skeleton-line" />
        </div>
      ))}
    </div>
  </div>;
}

/** Keep this live region mounted through loading so completion is announced once. */
export function UpgradeReviewAnnouncement({ analysis, advisoriesOff = false }: {
  analysis: UpgradeAnalysisPresentation | null;
  advisoriesOff?: boolean;
}): ReactElement {
  return <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {analysis == null ? '' : upgradeReviewHasIncompleteChecks(analysis, advisoriesOff)
      ? 'Upgrade review ready. Some checks could not complete.'
      : 'Upgrade review ready.'}
  </p>;
}
