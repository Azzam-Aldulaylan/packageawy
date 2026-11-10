import type { ReactElement } from 'react';

import type { Severity } from '../../../src/core/types.js';
import { severityDisplay } from '../../../src/host/severityDisplay.js';

/**
 * Colour alone never carries the meaning here: the label text (Critical,
 * High, ... Safe) is what a screen reader or colour-blind user relies on;
 * the themed colour is a reinforcing cue, not the only signal.
 */
export function SeverityBadge({
  severity,
  advisoriesAvailable = true,
  checked = true,
}: {
  severity: Severity | null;
  advisoriesAvailable?: boolean;
  checked?: boolean;
}): ReactElement {
  const { label, className, reason } = severityDisplay(severity, advisoriesAvailable, checked);
  return <span className={`severity severity--${className}`} title={reason} aria-label={reason === undefined ? undefined : `${label}. ${reason}`}>{label}</span>;
}
