import type { ReactElement } from 'react';

import type { Severity } from '../../../src/core/types.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';
import { InfoTooltip } from './Tooltip.js';

/**
 * Colour alone never carries the meaning here: the label text (Critical,
 * High, ... Safe) is what a screen reader or colour-blind user relies on;
 * the themed colour is a reinforcing cue, not the only signal.
 */
export function SeverityBadge({
  severity,
  advisoriesAvailable = true,
  checked = true,
  advisoriesOff = false,
}: {
  severity: Severity | null;
  advisoriesAvailable?: boolean;
  checked?: boolean;
  advisoriesOff?: boolean;
}): ReactElement {
  const { label, className, reason } = severityDisplay(severity, advisoriesAvailable, checked, advisoriesOff);
  if (className === 'none') {
    return <InfoTooltip label={label} content={reason} className="severity-help" icon={<span className="severity severity--none">{label}</span>} />;
  }
  return <span className={`severity severity--${className}`} title={reason} aria-label={reason === undefined ? undefined : `${label}. ${reason}`}>{label}</span>;
}
