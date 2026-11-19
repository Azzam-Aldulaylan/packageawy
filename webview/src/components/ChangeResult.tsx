import { DialogFooterActions } from './DialogFooter.js';
import { createContext, useContext, useId, useLayoutEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectCheckResult, UpgradeResultPresentation } from '../../../src/host/webviewProtocol.js';
import type { UpgradeEnrichmentUiState } from '../../../src/host/upgradeReviewUiState.js';
import { IconAlertTriangle, IconBrand, IconCheck, IconChevronRight, IconInfo, IconListChecks, IconRefresh, IconShield, IconXCircle } from '../icons.js';
import { DependencyChangeContext } from './DependencyChangeStatus.js';
import { StatusBanner } from './StatusBanner.js';
import { UndoBackupContext, UndoChangeButton, UndoChangeFeedback } from './UndoChangeButton.js';

export const ChangeResultContext = createContext<{
  analyze(): void;
  analyzeDisabled?: boolean;
  reveal(id: string): void;
  terminals: ReadonlyMap<string, boolean>;
}>({ analyze() {}, reveal() {}, terminals: new Map() });

const STATUS = { passed: 'Passed', failed: 'Failed', 'not-run': 'Not run', 'no-script': 'No script', unknown: 'Outcome unknown' } as const;
function CheckIcon({ status }: { status: ProjectCheckResult['status'] }): ReactElement {
  return status === 'passed' ? <IconCheck /> : status === 'failed' ? <IconXCircle /> : <IconInfo />;
}

export interface ChangedPackage { name: string; from?: string; to?: string; status?: string; detail?: ReactNode }

/** Shared result surface. Evidence comes from the host, never inferred from command output. */
export function ChangeResult({ flow, title, summary, warning = false, error = false, headingId, packages, checks = [], undoId, facts, message, children, refreshing = false, dataWarning, blocked = false }: {
  flow: 'Upgrade' | 'Removal' | 'Transitive fix'; title: string; summary: string; warning?: boolean; error?: boolean;
  headingId: string; packages: readonly ChangedPackage[]; checks?: readonly ProjectCheckResult[]; undoId?: string;
  facts: readonly { label: string; value: ReactNode }[]; message?: string; children?: ReactNode;
  refreshing?: boolean; dataWarning?: string; blocked?: boolean;
}): ReactElement {
  const actions = useContext(ChangeResultContext);
  const change = useContext(DependencyChangeContext);
  const undo = useContext(UndoBackupContext);
  const backup = undo.entries.find(entry => entry.analysisId === undoId);
  const resultRef = useRef<HTMLElement>(null);
  const openingUndo = backup !== undefined && undo.openingId === backup.analysisId;
  const undoError = backup !== undefined && undo.error?.id === backup.analysisId ? undo.error.message : undefined;
  useLayoutEffect(() => {
    if (!openingUndo && undoError === undefined) return;
    const feedback = resultRef.current?.querySelector<HTMLElement>('.undo-change-feedback');
    const reducedMotion = feedback?.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Reveal new feedback in the body while leaving keyboard focus on the current control.
    feedback?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth' });
  }, [openingUndo, undoError]);
  const helpId = useId();
  const failed = checks.some(check => check.status === 'failed');
  const scripts = checks.filter(check => check.kind === 'script');
  const allPassed = scripts.some(check => check.status === 'passed') && scripts.every(check => check.status === 'passed' || check.status === 'no-script' || (check.status === 'not-run' && check.reason === 'Not selected.'));
  const factList = <dl className="change-result__facts">{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>;
  return (
    <section className="change-result" aria-labelledby={headingId} ref={resultRef}>
      <StatusBanner tone={error ? 'error' : warning ? 'warning' : 'info'} icon={warning || error ? <IconAlertTriangle /> : <IconCheck />} className="change-result__banner">
        <strong id={headingId} role="heading" aria-level={3} tabIndex={-1}>{title}</strong><span>{summary}</span>
      </StatusBanner>
      <section aria-label="Package changes">
        <div className="change-result__section-title"><h4>What changed</h4><span>{flow === 'Removal' ? 'Direct dependencies' : 'From version / To version'}</span></div>
        <div className="change-result__rows">{packages.map((pkg, index) => <div className="change-result__package" key={`${pkg.name}:${index}`}>
          <div className="change-result__package-name"><IconBrand aria-hidden="true" /><code>{pkg.name}</code></div>
          <div className="change-result__versions" aria-label={pkg.to === undefined ? undefined : `From ${pkg.from ?? 'not installed'} to ${pkg.to}`}>
            {pkg.from === undefined ? null : <code>{pkg.from}</code>}{pkg.to === undefined ? null : <><IconChevronRight aria-hidden="true" /><code>{pkg.to}</code></>}
            {pkg.status === undefined ? null : <span className="status-badge status-badge--neutral">{pkg.status}</span>}
          </div>
          {pkg.detail === undefined ? null : <div className="change-result__package-detail">{pkg.detail}</div>}
        </div>)}</div>
      </section>
      {message ? <p className="change-result__notice"><IconInfo aria-hidden="true" />{message}</p> : null}
      <section aria-label="Project checks">
        <div className="change-result__section-title"><h4>Project checks</h4></div>
        <div className="change-result__rows">{checks.length === 0 ? <p className="change-result__notice"><IconInfo />Command observations are unavailable.</p> : checks.map(check => <div className="change-result__check" key={check.id}>
          <IconListChecks aria-hidden="true" />
          <div className="change-result__check-label"><strong>{check.kind === 'install' ? 'Install' : check.scriptName}</strong><code>{check.command}</code>
            {check.reason ? <span>{check.reason}</span> : null}{check.message ? <span>{check.message}</span> : null}
          </div>
          <div className="change-result__check-status">
            <span className={`status-badge status-badge--${check.status === 'failed' ? 'warning' : 'neutral'}`}><CheckIcon status={check.status} />{STATUS[check.status]}</span>
            {check.status === 'failed' && check.terminalAvailable ? actions.terminals.get(check.id) === false ? <span role="status">Terminal was closed.</span> : <button type="button" className="button button--subtle" onClick={() => actions.reveal(check.id)} aria-label={`Show terminal for ${check.kind === 'install' ? 'Install' : check.scriptName}`}>Show terminal</button> : null}
          </div>
        </div>)}</div>
        <p className="change-result__verification"><IconShield aria-hidden="true" />{failed ? 'A command failed. Review the check before you commit.' : allPassed ? 'All selected scripts exited successfully.' : 'Project checks did not confirm this change. Run your checks before you commit.'}</p>
      </section>
      <div className="change-result__details">
        <details open={error}><summary>Files and result<span>{error ? 'Recovery needed' : 'Details'}</span></summary>{factList}{children}</details>
        <details><summary>Command details<span>{checks.filter(check => check.exitCode !== undefined).length} commands observed</span></summary>
          <p>Command output stays in the editor terminal or run console.</p>
          <dl className="change-result__facts">{checks.map(check => <div key={check.id}><dt><code>{check.command}</code></dt><dd>{STATUS[check.status]}{check.exitCode === undefined ? '' : `. Exit code ${check.exitCode}.`}{check.reason ? ` ${check.reason}` : ''}</dd></div>)}</dl>
        </details>
        <details><summary>Backup details<span>{backup === undefined ? blocked || change.blocked ? 'Recovery needed' : 'Unavailable' : 'Available'}</span></summary>
          {backup === undefined ? <p>{blocked || change.blocked ? 'Finish dependency recovery to review saved files.' : 'No Undo backup is available for this result.'}</p> : <><p>Restore point: <code>{backup.analysisId}</code></p><p>Saved files: package.json and the lockfile.</p><p>Undo opens a file review. Newer edits must be reviewed before restore. A dependency install may be needed after restore.</p></>}
        </details>
      </div>
      {refreshing ? <p className="change-result__notice" role="status"><IconRefresh className="banner__icon--spin" />Refreshing dependency security and update data…</p> : null}
      {dataWarning ? <StatusBanner tone="warning"><strong>Dependency data refresh failed</strong><span>{dataWarning} Analyze project to retry.</span></StatusBanner> : null}
      <div className="change-result__backup" id={helpId}><strong><IconShield aria-hidden="true" />{blocked || change.blocked ? 'Backup kept. Recovery needed.' : backup === undefined ? 'No Undo backup is available.' : 'Backup saved. You can undo this change.'}</strong>
        <p>{blocked || change.blocked ? 'Undo and analysis are paused until file recovery is complete.' : 'Undo restores dependency files. It does not restore script side effects.'}</p>
      </div>
      {backup === undefined ? null : <UndoChangeFeedback undoId={backup.analysisId} />}
      <DialogFooterActions>
        <UndoChangeButton undoId={undoId} disabled={blocked || change.blocked} describedBy={helpId} />
        <button type="button" className="button button--secondary" aria-describedby={helpId} disabled={blocked || change.blocked || change.task !== 'idle' || actions.analyzeDisabled} onClick={actions.analyze}><IconRefresh aria-hidden="true" />Analyze project</button>
      </DialogFooterActions>
    </section>
  );
}

export function UpgradeChangeResult({ result, enrichment }: { result: UpgradeResultPresentation; enrichment: UpgradeEnrichmentUiState | null }): ReactElement {
  const applied = result.application === 'applied';
  const rollbackIncomplete = result.rollback === 'conflict' || result.rollback === 'failed';
  const warning = result.verification === 'failed' || enrichment?.phase === 'failed';
  return <ChangeResult flow="Upgrade" headingId="upgrade-result-heading"
    title={applied ? warning ? 'Upgrade done with a warning' : 'Upgrade done' : result.application === 'rolled-back' ? 'Upgrade rolled back' : 'Upgrade not confirmed'}
    summary={`${result.changes.length} ${result.changes.length === 1 ? 'package' : 'packages'} ${applied ? 'upgraded' : result.application === 'rolled-back' ? 'restored' : 'not confirmed'}. ${result.verification === 'failed' && applied ? 'A project check failed. Changes were kept.' : result.verification === 'passed' ? 'Selected project checks exited successfully.' : 'Project checks did not confirm this change.'}`}
    warning={warning} error={result.application === 'unconfirmed'} blocked={rollbackIncomplete}
    packages={result.changes.map(pkg => ({ name: pkg.packageName, from: pkg.previousVersion, to: pkg.currentVersion ?? 'not resolved' }))}
    {...(result.checks === undefined ? {} : { checks: result.checks })} {...(result.undoId === undefined ? {} : { undoId: result.undoId })}
    facts={[
      { label: 'Applied state', value: applied ? 'Requested dependency state confirmed' : result.application === 'rolled-back' ? 'Dependency files restored' : 'Resulting dependency state could not be confirmed' },
      { label: 'Dependency files', value: applied ? 'package.json and the lockfile updated' : result.application === 'rolled-back' ? 'package.json and the lockfile restored' : 'Current state not confirmed' },
      { label: 'Install', value: result.install === 'succeeded' ? 'Succeeded' : 'Failed' },
      { label: 'Verification', value: result.verification === 'not-configured' ? result.projectScriptsPresent === false ? 'No test scripts to run' : 'No checks selected' : result.verification.replaceAll('-', ' ') },
      { label: 'Rollback', value: result.rollback === 'conflict' ? 'Incomplete: files changed' : result.rollback === 'failed' ? 'Incomplete: restore failed' : result.rollbackMessage ?? (result.application === 'rolled-back' ? 'Dependency files restored' : 'Not run') },
      { label: 'Dependency data', value: enrichment?.phase === 'refreshing' ? 'Refreshing' : enrichment?.message ?? 'Refresh finished' },
    ]} {...(result.rollbackMessage === undefined ? {} : { message: result.rollbackMessage })}
    refreshing={enrichment?.phase === 'refreshing'} {...(enrichment !== null && enrichment.phase !== 'refreshing' ? { dataWarning: `${enrichment.message} ${applied ? 'Confirmed local dependency facts are still shown.' : 'Current dependency state is not confirmed.'}` } : {})} />;
}
