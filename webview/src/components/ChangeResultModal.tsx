import { DialogFooter, DialogFooterScope } from './DialogFooter.js';
import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { RemovalFailureDetails, RemoveResultPresentation, ProtocolError, UpgradeResultPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeEnrichmentUiState } from '../../../src/host/upgradeReviewUiState.js';
import { trapFocus, isTopmostTrap } from '../focusTrap.js';
import { IconBrand, IconX } from '../icons.js';
import { RemovalErrorPanel, RemovalResultPanel } from './RemovalProgressPanels.js';
import { UpgradeChangeResult } from './ChangeResult.js';

/** Standalone completion for coordinated changes, including Smart plans. */
export function ChangeResultModal({ result, enrichment, onClose }: { result: UpgradeResultPresentation; enrichment: UpgradeEnrichmentUiState | null; onClose(): void }): ReactElement {
  return <ChangeResultDialog headingId="upgrade-result-heading" onClose={onClose}><UpgradeChangeResult result={result} enrichment={enrichment} /></ChangeResultDialog>;
}

export type RemovalChangeResultOutcome = { result: RemoveResultPresentation } | { error: ProtocolError; details: RemovalFailureDetails };

export function RemovalChangeResultModal({ outcome, onClose }: { outcome: RemovalChangeResultOutcome; onClose(): void }): ReactElement {
  return <ChangeResultDialog headingId={'result' in outcome ? 'removal-result-heading' : 'removal-error-heading'} onClose={onClose}>
    {'result' in outcome ? <RemovalResultPanel result={outcome.result} /> : <RemovalErrorPanel error={outcome.error} details={outcome.details} />}
  </ChangeResultDialog>;
}

function ChangeResultDialog({ headingId, onClose, children }: { headingId: string; onClose(): void; children: ReactNode }): ReactElement {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.querySelector<HTMLElement>(`#${headingId}`)?.focus();
    const untrap = node === null ? () => {} : trapFocus(node);
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && node !== null && isTopmostTrap(node)) { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { untrap(); document.removeEventListener('keydown', keydown); (previous?.isConnected && previous !== document.body ? previous : document.querySelector<HTMLElement>('.dashboard__title'))?.focus(); };
  }, [headingId, onClose]);
  return <DialogFooterScope><div className="modal-overlay" onClick={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="modal manage-modal" role="dialog" aria-modal="true" aria-label="Change result" ref={dialog}>
      <header className="modal__header"><h2 className="modal__title"><IconBrand aria-hidden="true" /> Change result</h2><button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog"><IconX /></button></header>
      <div className="modal__body">{children}</div>
      <DialogFooter primary={<button type="button" className="button button--primary" onClick={onClose}>Close</button>} />
    </div>
  </div></DialogFooterScope>;
}
