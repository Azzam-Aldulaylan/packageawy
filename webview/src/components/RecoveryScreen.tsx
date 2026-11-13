import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { RecoveryChoice, RecoveryPresentation, WebviewToHostMessage } from '../../../src/host/webviewProtocol.js';
import { RECOVERY_MESSAGES } from '../../../src/host/recoveryCopy.js';

/** Choices belong to this visible review only. Reopening never replays an action. */
export function RecoveryScreen({ recovery, send, close }: {
  recovery: RecoveryPresentation;
  send(message: WebviewToHostMessage): void;
  close(): void;
}): ReactElement {
  const [stopped, setStopped] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<RecoveryChoice[]>(() => recovery.files.map(file => ({ id: file.id, current: file.current, action: 'keep', approveDeletion: false })));
  useEffect(() => {
    setBusy(false);
    setChoices(recovery.files.map(file => ({ id: file.id, current: file.current, action: 'keep', approveDeletion: false })));
  }, [recovery]);
  const request = (message: WebviewToHostMessage): void => { setBusy(true); send(message); };
  const needsDiscard = recovery.state === 'incomplete' || recovery.state === 'invalid';
  const canReview = recovery.canApply && recovery.files.length > 0;
  const canStart = recovery.state !== 'open' && !recovery.canApply && !recovery.canDismiss && !['running', 'takeover', 'discovery-error'].includes(recovery.state);
  const patch = (id: string, fields: Partial<RecoveryChoice>): void => setChoices(previous => previous.map(choice => choice.id === id ? { ...choice, ...fields } : choice));
  return (
    <section className="recovery" aria-labelledby="recovery-title" aria-busy={busy}>
      <header className="recovery__heading">
        <h1 id="recovery-title">Dependency recovery</h1>
        <button type="button" className="button button--secondary" onClick={close}>Close</button>
      </header>
      <p role="status">{recovery.message}</p>
      {recovery.state === 'discovery-error' ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => request({ type: 'inspect-recovery' })}>Retry discovery</button> : null}
      <p className="recovery__warning">{RECOVERY_MESSAGES.warning}</p>
      {canStart ? (
        <div className="recovery__confirmation">
          <label><input type="checkbox" checked={stopped} onChange={event => setStopped(event.target.checked)} />{RECOVERY_MESSAGES.stop}</label>
          <button type="button" className="button button--primary" disabled={!stopped || busy} onClick={() => request({ type: 'start-recovery', stopped: true, claim: recovery.claim })}>Start recovery</button>
        </div>
      ) : null}
      {recovery.files.map(file => {
        const choice = choices.find(entry => entry.id === file.id);
        return (
          <fieldset className="recovery__file" key={file.id} disabled={!canReview || busy}>
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
      {canReview ? <button type="button" className="button button--primary" disabled={busy || choices.some(choice => choice.action === 'restore' && recovery.files.some(file => file.id === choice.id && !file.existed) && !choice.approveDeletion)} onClick={() => request({ type: 'apply-recovery', choices })}>{recovery.state === 'incomplete' ? 'Retry' : 'Apply choices'}</button> : null}
      {recovery.canDismiss ? (
        <div className="recovery__confirmation">
          {needsDiscard ? <label><input type="checkbox" checked={discard} onChange={event => setDiscard(event.target.checked)} />The saved and displaced files are no longer needed.</label> : null}
          <button type="button" className="button button--secondary" disabled={busy || (needsDiscard && !discard)} onClick={() => request({ type: 'dismiss-recovery', stopped: true, discardIncomplete: discard })}>Remove saved files and unlock</button>
        </div>
      ) : null}
      <p>Closing this screen keeps saved files and the lock. Recovery never resumes by itself.</p>
    </section>
  );
}
