import { useState } from 'react';
import type { ReactElement } from 'react';
import type { UpgradeAnalysisPresentation } from '../../../src/host/webviewProtocol.js';
import { requiresSecurityAcknowledgement } from '../../../src/host/upgradeSecuritySummary.js';

/** Bind consent to the exact review and executable proposal, including planner changes. */
export function useUpgradeSecurityAcknowledgement(analysis: UpgradeAnalysisPresentation | null) {
  const key = JSON.stringify([analysis?.analysisId, analysis?.changes, analysis?.smartPlan, analysis?.security?.introduced]);
  const [consent, setConsent] = useState({ key, acknowledged: false });
  if (consent.key !== key) setConsent({ key, acknowledged: false });
  const required = requiresSecurityAcknowledgement(analysis?.security);
  const acknowledged = consent.key === key && consent.acknowledged;
  return { required, acknowledged, blocked: required && !acknowledged,
    setAcknowledged: (checked: boolean) => setConsent({ key, acknowledged: checked }) };
}

export function UpgradeSecurityAcknowledgement({ consent }: {
  consent: ReturnType<typeof useUpgradeSecurityAcknowledgement>;
}): ReactElement | null {
  if (!consent.required) return null;
  return <label className="verification-suggestions__option upgrade-security-acknowledgement">
    <input className="review-list__checkbox" type="checkbox" checked={consent.acknowledged}
      onChange={(event) => consent.setAcknowledged(event.currentTarget.checked)} />
    I understand this upgrade adds known vulnerabilities
  </label>;
}
