import { createContext, useContext } from 'react';
import type { ReactElement } from 'react';
import type { UndoBackupEntry } from '../../../src/host/webviewProtocol.js';
import { StatusBanner } from './StatusBanner.js';
import { undoLabel } from '../../../src/host/recoveryCopy.js';

/** Result actions must still match the host's currently available transaction. */
export const UndoBackupContext = createContext<{
  entries: readonly UndoBackupEntry[];
  disabled: boolean;
  openingId?: string | null;
  error?: { id: string; message: string } | null;
  review(id: string): void;
}>({ entries: [], disabled: true, review: () => {} });

export function UndoChangeButton({ undoId }: { undoId: string | undefined }): ReactElement | null {
  const undo = useContext(UndoBackupContext);
  const entry = undo.entries.find(candidate => candidate.analysisId === undoId);
  if (entry === undefined) return null;
  const opening = undo.openingId === entry.analysisId;
  return <>
    <button type="button" className="button button--secondary" data-undo-id={entry.analysisId} data-undo-location="result"
      disabled={undo.disabled} aria-busy={opening} onClick={() => undo.review(entry.analysisId)}>{undoLabel(entry.operation)}</button>
    <UndoChangeFeedback undoId={entry.analysisId} />
  </>;
}

/** Keep request feedback beside the action on every result surface. */
export function UndoChangeFeedback({ undoId }: { undoId: string }): ReactElement | null {
  const undo = useContext(UndoBackupContext);
  if (undo.openingId === undoId) return <p role="status" aria-live="polite">Opening the backup...</p>;
  if (undo.error?.id !== undoId) return null;
  return <StatusBanner tone="error">Couldn't open the backup. {undo.error.message}</StatusBanner>;
}
