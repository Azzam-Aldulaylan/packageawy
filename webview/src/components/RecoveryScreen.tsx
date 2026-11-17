import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { RecoveryChoice, RecoveryPresentation, WebviewToHostMessage } from '../../../src/host/webviewProtocol.js';
import { undoLabel, RECOVERY_MESSAGES } from '../../../src/host/recoveryCopy.js';

/** Choices belong to this visible review only. Reopening never replays an action. */
export function RecoveryScreen({ recovery, send, close, changesBlocked = false }: {
  recovery: RecoveryPresentation;
  send(message: WebviewToHostMessage): void;
  close(): void;
  changesBlocked?: boolean;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const discardHeading = useRef<HTMLHeadingElement | null>(null);
  const discardButton = useRef<HTMLButtonElement | null>(null);
  const [undoTitle] = useState(() => recovery.state === 'undo-available' ? undoLabel(recovery.undoOperation) : null);
  const isUndo = undoTitle !== null || recovery.undoOperation !== undefined;
  const defaults = (): RecoveryChoice[] => recovery.files.map(file => ({ id: file.id, current: file.current, action: isUndo ? 'restore' : 'keep', approveDeletion: false }));
  const [stopped, setStopped] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pending, setPending] = useState('');
  const busy = pending !== '';
  const [choices, setChoices] = useState<RecoveryChoice[]>(defaults);
  const previousState = useRef<RecoveryPresentation['state'] | undefined>(undefined);
  const awaitingResult = useRef(false);
  useEffect(() => {
    if (previousState.current !== recovery.state || awaitingResult.current) headingRef.current?.focus();
    previousState.current = recovery.state;
    awaitingResult.current = false;
  }, [recovery]);
  useEffect(() => {
    if (confirmDiscard) {
      discardHeading.current?.focus();
      return () => discardButton.current?.focus();
    }
  }, [confirmDiscard]);
  useEffect(() => {
    setPending('');
    setConfirmDiscard(false);
    setDiscard(false);
    setChoices(recovery.files.map(file => ({ id: file.id, current: file.current, action: isUndo ? 'restore' : 'keep', approveDeletion: false })));
  }, [recovery, isUndo]);
  const request = (message: WebviewToHostMessage, feedback: string): void => {
    awaitingResult.current = message.type === 'apply-recovery' || message.type === 'dismiss-recovery';
    setPending(feedback);
    send(message);
  };
  const canReview = !changesBlocked && recovery.canApply && recovery.files.length > 0;
  const canStart = recovery.state !== 'open' && !recovery.canApply && !recovery.canDismiss && !['running', 'takeover', 'discovery-error'].includes(recovery.state);
  const patch = (id: string, fields: Partial<RecoveryChoice>): void => setChoices(previous => previous.map(choice => choice.id === id ? { ...choice, ...fields } : choice));
  const completed = recovery.state === 'completed';
  const matchesBackup = recovery.files.length > 0 && recovery.files.every(file => file.current === file.backup);
  const restored = recovery.files.filter(file => file.progress === 'restored' && file.current === file.backup);
  const canFinish = completed && matchesBackup && recovery.canDismiss;
  const needsApproval = (selected: RecoveryChoice[]): boolean => selected.some(choice => choice.action === 'restore' && recovery.files.some(file => file.id === choice.id && !file.existed) && !choice.approveDeletion);
  const allRestores = choices.map(choice => ({ ...choice, action: 'restore' as const }));
  const change = ({ cleanup: 'cleanup', removal: 'removal', upgrade: 'upgrade', remediation: 'transitive fix' })[recovery.undoOperation ?? 'cleanup'];
  const reinstallMessage = ({
    'not-run': 'Reinstall did not run. Run your package manager install command before using the project.',
    skipped: 'Reinstall was skipped. Run your package manager install command before using the project.',
    succeeded: 'Reinstall completed. You can check the project now.',
    failed: 'Reinstall failed. Run your package manager install command before using the project.',
    unknown: 'The reinstall result is unknown. Stop any running install and check the project before continuing.',
  })[recovery.reinstall ?? 'not-run'];
  return (
    <section className="recovery" aria-labelledby="recovery-title" aria-busy={busy}>
      <header className="recovery__heading">
        <h1 id="recovery-title" tabIndex={-1} ref={headingRef}>{completed ? (matchesBackup && restored.length > 0 ? 'Dependency files restored' : restored.length > 0 ? 'Some files restored' : 'No files restored') : undoTitle ?? 'Dependency recovery'}</h1>
      </header>
      {completed ? (
        <div className="recovery__result">
          <p>{matchesBackup ? 'The dependency files match the backup.' : 'Files kept as current still contain the change.'}</p>
          <ul>{recovery.files.map(file => <li key={file.id}>{file.path}: {file.current === file.backup ? (file.existed ? 'Matches backup' : 'Removed to match backup') : 'Current file kept'}</li>)}</ul>
          <p>{reinstallMessage}</p>
          <p>{canFinish ? 'Finish undo to delete the backup and allow dependency changes again.' : 'Keep the backup for later or delete it separately after reviewing the files.'}</p>
        </div>
      ) : <>
        <p>{isUndo ? 'Restore the backed up dependency files to undo this change.' : 'Packageawy saved a backup of your dependency files before the change. Choose what to keep for each file.'}</p>
        <p>Restoring puts package.json and the lockfile back. It does not undo script side effects.</p>
      </>}
      <p role="status" aria-live="polite">{pending || recovery.message}</p>
      {!completed ? <p className="recovery__warning">{RECOVERY_MESSAGES.warning}</p> : null}
      <details className="recovery__contents">
        <summary>View backup</summary>
        <p>Viewing the backup does not restore files. Use the restore action below.</p>
        {recovery.files.map(file => {
          const choice = choices.find(entry => entry.id === file.id);
          return (
            <fieldset className="recovery__file" key={file.id} disabled={!canReview || busy || confirmDiscard}>
              <legend>{file.path}</legend>
              <dl className="recovery__comparison">
                <div><dt>Backup</dt><dd>{file.existed ? `SHA-256: ${file.backup}` : 'Did not exist before the change'}</dd></div>
                <div><dt>Current</dt><dd>{file.current === 'absent' ? 'Does not exist' : `SHA-256: ${file.current}`}</dd></div>
                <div><dt>Progress</dt><dd>{file.progress}</dd></div>
              </dl>
              <details className="recovery__contents">
                <summary>Compare contents</summary>
                <h2>Backup</h2><pre>{file.existed ? file.backupPreview : 'Did not exist before the change'}</pre>
                <h2>Current</h2><pre>{file.current === 'absent' ? 'Does not exist' : file.currentPreview}</pre>
              </details>
              {canReview ? (
                <div className="recovery__choices">
                  <label><input type="radio" name={file.id} checked={choice?.action !== 'restore'} onChange={() => patch(file.id, { action: 'keep', approveDeletion: false })} />Keep current</label>
                  <label><input type="radio" name={file.id} checked={choice?.action === 'restore'} onChange={() => patch(file.id, { action: 'restore' })} />Restore backup</label>
                  {!file.existed && choice?.action === 'restore' ? <label><input type="checkbox" checked={choice.approveDeletion} onChange={event => patch(file.id, { approveDeletion: event.target.checked })} />Approve deletion of {file.path}</label> : null}
                </div>
              ) : null}
            </fieldset>
          );
        })}
      </details>
      <section className="recovery__actions" aria-labelledby="recovery-actions-title">
        <h2 id="recovery-actions-title">Next steps</h2>
        {recovery.state === 'discovery-error' ? (
          <div className="recovery__action">
            <h3>Check for backups</h3>
            <p>Try again to find the saved dependency files.</p>
            <button type="button" className="button button--primary" disabled={busy || changesBlocked} onClick={() => request({ type: 'inspect-recovery' }, 'Checking for backups...')}>Retry discovery</button>
          </div>
        ) : null}
        {canStart ? (
          <div className="recovery__action">
            <h3>Review file choices</h3>
            <p>Confirm that other commands have stopped before opening the backup.</p>
            <label><input type="checkbox" checked={stopped} disabled={busy || changesBlocked} onChange={event => setStopped(event.target.checked)} />{RECOVERY_MESSAGES.stop}</label>
            <button type="button" className="button button--primary" disabled={!stopped || busy || changesBlocked} onClick={() => request({ type: 'start-recovery', stopped: true, claim: recovery.claim }, 'Opening the backup...')}>{recovery.state === 'undo-available' ? 'Review backup' : 'Start recovery'}</button>
          </div>
        ) : null}
        {canReview ? <>
          {isUndo ? <div className="recovery__action">
            <h3>Restore all files</h3>
            <p>Restore every backed up file. Files created by the change need deletion approval in View backup.</p>
            <button type="button" className="button button--primary" disabled={busy || confirmDiscard || needsApproval(allRestores)} onClick={() => request({ type: 'apply-recovery', choices: allRestores }, 'Restoring backed up files. Waiting for the reinstall choice and result...')}>Restore all files</button>
          </div> : null}
          <div className="recovery__action">
            <h3>Apply your choices</h3>
            <p>{isUndo ? 'Every file defaults to Restore backup. You can change individual choices in View backup.' : 'Keep or restore each file using the choices above.'}</p>
            <button type="button" className={`button button--${isUndo ? 'secondary' : 'primary'}`} disabled={busy || confirmDiscard || needsApproval(choices)} onClick={() => request({ type: 'apply-recovery', choices }, 'Applying file choices. Waiting for any reinstall choice and result...')}>Apply file choices</button>
          </div>
        </> : null}
        {canFinish ? <div className="recovery__action">
          <h3>Finish undo</h3>
          <p>The files match the backup. Delete the backup to allow dependency changes again.</p>
          <button type="button" className="button button--primary" disabled={busy || changesBlocked} onClick={() => request({ type: 'dismiss-recovery', stopped: true, discardIncomplete: false }, 'Deleting the backup...')}>Finish undo</button>
        </div> : null}
        {!canFinish && (recovery.canDismiss || canReview) ? <div className="recovery__action">
          <h3>Delete backup without restoring</h3>
          <p>The {change} will stay for files you did not restore. Deleting the backup cannot be undone.</p>
          {confirmDiscard ? <>
            <h3 ref={discardHeading} tabIndex={-1}>Delete this backup?</h3>
            <p>You will lose the saved files and any files moved aside during restore.</p>
            <label><input type="checkbox" checked={discard} disabled={busy} onChange={event => setDiscard(event.target.checked)} />I understand that I will lose this backup.</label>
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => { setConfirmDiscard(false); setDiscard(false); }}>Cancel deletion</button>
            <button type="button" className="button button--secondary" disabled={!discard || busy || changesBlocked} onClick={() => request({ type: 'dismiss-recovery', stopped: true, discardIncomplete: true }, 'Deleting the backup without restoring...')}>Confirm delete backup</button>
          </> : null}
          <button type="button" ref={discardButton} className="button button--secondary" disabled={busy || confirmDiscard || changesBlocked} onClick={() => setConfirmDiscard(true)}>Delete backup without restoring</button>
        </div> : null}
        <div className="recovery__action">
          <h3>Decide later</h3>
          <p>{recovery.state === 'undo-available'
            ? 'You can close this review and keep making dependency changes. The next change replaces this backup.'
            : 'Dependency changes stay paused until this backup is resolved. Recovery never resumes by itself.'}</p>
          <button type="button" className="button button--secondary" disabled={busy} onClick={close}>Keep the backup for later</button>
        </div>
      </section>
    </section>
  );
}
