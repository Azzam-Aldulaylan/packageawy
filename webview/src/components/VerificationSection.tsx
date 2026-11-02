import type { ReactElement } from 'react';

import type { UpgradeAnalysisVerification } from '../../../src/host/webviewProtocol.js';
import { IconGear, IconListChecks } from '../icons.js';
import { OutcomeStatus } from './OutcomeStatus.js';
import { useVerificationOptIn, VerificationSuggestions } from './VerificationSuggestions.js';

export function VerificationSection({
  analysisId,
  verification,
  onConfigureVerification,
  configuredLabel = 'Post-upgrade checks configured',
  actionLabel = 'this upgrade',
}: {
  analysisId?: string | undefined;
  verification: UpgradeAnalysisVerification;
  onConfigureVerification: () => void;
  /** Override for a flow other than an upgrade: e.g. a removal's "Post-removal checks configured". */
  configuredLabel?: string;
  /** Names the change in "Run after ...", for example "this removal". */
  actionLabel?: string;
}): ReactElement {
  const { selected } = useVerificationOptIn(analysisId, verification);
  return (
    <section className="analysis-card" aria-labelledby="analysis-verification-heading">
      <h3 className="analysis-card__title" id="analysis-verification-heading">
        <IconListChecks className="analysis-card__title-icon" />
        Verification
      </h3>
      {verification.configured ? (
        <>
          <OutcomeStatus label={configuredLabel} className="compatible" />
          <ul className="verification__scripts">
            {verification.scriptNames.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {selected.length > 0 ? (
            <OutcomeStatus label="Selected checks run after this change" className="compatible" />
          ) : (
            <OutcomeStatus
              label="Application verification is not configured"
              className="warning"
              detail="The dependency installation can be verified, but the application's build/tests will not run automatically."
            />
          )}
          <VerificationSuggestions analysisId={analysisId} verification={verification} actionLabel={actionLabel} />
          <button type="button" className="button button--secondary verification__configure" onClick={onConfigureVerification}>
            <IconGear />
            Configure verification
          </button>
        </>
      )}
    </section>
  );
}
