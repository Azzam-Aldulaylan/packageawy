import { ChangeResult } from './ChangeResult.js';
import { useContext } from 'react';
import { DependencyChangeContext } from './DependencyChangeStatus.js';
import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { RemoveProgressPhase, RemoveResultPresentation } from '../../../src/host/webviewProtocol.js';
import { AnalysisLoading } from './AnalysisLoading.js';

/**
 * Which removal view the Manage dialog shows. `review` is the normal Removal
 * review and `review-error` is that review showing a failure, for example
 * when the project changed before the removal could start.
 */
export type RemovalView = 'review' | 'review-error' | 'running' | 'result' | 'error';

const VIEW_HEADING: Record<Exclude<RemovalView, 'review'>, string> = {
  'review-error': 'removal-review-error-heading',
  running: 'removal-running-heading',
  result: 'removal-result-heading',
  error: 'removal-error-heading',
};

/**
 * The heading id to focus after the removal view changes, or null when the
 * view stayed the same or went back to the review, which keeps its own focus.
 */
export function removalViewFocusTarget(previous: RemovalView, next: RemovalView): string | null {
  if (previous === next || next === 'review') return null;
  return VIEW_HEADING[next];
}

type StepStatus = 'complete' | 'running' | 'waiting';

const STEPS: ReadonlyArray<{ phase: RemoveProgressPhase | null; label: string; running: string }> = [
  { phase: null, label: 'Update package.json', running: 'Updating package.json' },
  { phase: 'installing', label: 'Install dependencies', running: 'Installing' },
  { phase: 'verifying', label: 'Verify the project', running: 'Verifying' },
  { phase: 'refreshing', label: 'Refresh dependency data', running: 'Refreshing' },
];

/**
 * Step states for a running removal. Only phases the host reported are
 * marked done or in progress. `null` means the transaction started but no
 * later phase has been reported yet.
 */
export function removalProgressSteps(
  progress: RemoveProgressPhase | null
): Array<{ label: string; running: string; status: StepStatus }> {
  const current = STEPS.findIndex((step) => step.phase === progress);
  return STEPS.map((step, index) => ({
    label: step.label,
    running: step.running,
    status: index < current ? 'complete' : index === current ? 'running' : 'waiting',
  }));
}

/** Shown in Removal review from the moment Remove is clicked until the host reports a result. */
export function RemovalRunningPanel({
  row,
  progress,
}: {
  row: PackageRow;
  progress: RemoveProgressPhase | null;
}): ReactElement {
  const change = useContext(DependencyChangeContext);
  const steps = removalProgressSteps(progress);
  const current = steps.find((step) => step.status === 'running');
  return <AnalysisLoading label={`Removing ${row.name}...`} headingId="removal-running-heading"
    paused={change.task === 'still-running' || change.blocked}
    announcement={`${current?.running ?? 'Working'}…`} />;
}

export function removalResultTitle(result: RemoveResultPresentation): string {
  if (result.outcome === 'rolled-back') return 'Removal rolled back';
  return result.verification === 'failed' ? 'Removal done with a warning' : 'Removal done';
}

export function removalInstallLabel(result: RemoveResultPresentation): string {
  if (result.outcome !== 'rolled-back') return 'Succeeded';
  // Verification only runs after a successful install.
  return result.verification === 'failed' ? 'Succeeded' : 'Did not finish';
}

export function removalVerificationLabel(result: RemoveResultPresentation): string {
  if (result.verification === 'passed') return 'Passed';
  if (result.verification === 'not-configured') return result.projectScriptsPresent === false ? 'No test scripts to run' : 'No checks selected';
  if (result.verification === 'failed') return 'Failed';
  return 'Not run';
}

/** The removal counterpart of the upgrade result: same card, read from the host's result fields. */
export function RemovalResultPanel({
  row,
  result,
}: {
  row?: Pick<PackageRow, 'name' | 'current' | 'range'>;
  result: RemoveResultPresentation;
}): ReactElement {
  const kept = result.outcome !== 'rolled-back';
  const version = row?.current ?? row?.range;
  return <ChangeResult flow="Removal" title={removalResultTitle(result)} headingId="removal-result-heading"
    summary={`${result.packages.length} direct ${result.packages.length === 1 ? 'package' : 'packages'} ${kept ? 'removed' : 'restored'}. ${result.verification === 'passed' ? 'Selected project checks exited successfully.' : result.verification === 'failed' && kept ? 'A project check failed. Changes were kept.' : 'Project checks did not confirm this change.'}`}
    warning={result.verification === 'failed'}
    packages={result.packages.map(name => ({ name, ...(name === row?.name && version !== undefined ? { from: version } : {}), status: kept ? 'Direct entry removed' : 'Restored' }))}
    {...(result.checks === undefined ? {} : { checks: result.checks })} {...(result.undoId === undefined ? {} : { undoId: result.undoId })}
    message={result.message}
    facts={[
      { label: 'Install', value: removalInstallLabel(result) },
      { label: 'Dependency files', value: kept ? 'package.json and the lockfile updated' : 'package.json and the lockfile restored' },
      { label: 'Verification', value: removalVerificationLabel(result) },
      { label: 'Rollback', value: result.rollback === 'succeeded' ? 'Restore point applied' : 'Not needed' },
    ]} />;
}

export function removalRollbackLabel(code: string): string {
  if (code === 'ROLLBACK_CONFLICT') return 'Incomplete, newer edits were kept';
  if (code === 'ROLLBACK_FAILED') return 'Failed';
  return 'Not confirmed';
}

/**
 * A removal that failed after its package already left the project. Stays
 * until the dialog is closed, so the failure is never lost with the row.
 */
export function RemovalErrorPanel({
  row,
  error,
  details,
}: {
  row?: Pick<PackageRow, 'name' | 'current' | 'range'>;
  details?: import('../../../src/host/webviewProtocol.js').RemovalFailureDetails;
  error: { code: string; message: string };
}): ReactElement {
  const notStarted = details?.completion === 'not-started';
  const restored = details?.completion === 'rolled-back';
  const recovery = !notStarted && !restored;
  return <ChangeResult flow="Removal" title={notStarted ? 'Removal did not start' : restored ? 'Removal rolled back' : 'Removal partly failed'} headingId="removal-error-heading" warning error={recovery} blocked={recovery}
    summary={notStarted ? 'No dependency files were changed by this removal.' : restored ? 'Your dependency files were restored.' : 'The removal did not finish. Current dependency files are not confirmed.'}
    packages={(details?.packages ?? (row === undefined ? [] : [row.name])).map(name => ({ name, ...(name === row?.name && row !== undefined ? { from: row.current ?? row.range } : {}), status: notStarted ? 'Not removed' : restored ? 'Restored' : 'Not confirmed' }))}
    {...(details === undefined ? {} : { checks: details.checks })}
    message={error.message}
    facts={[
      { label: 'Error', value: error.code },
      { label: 'Install', value: details?.install ?? 'Not confirmed' },
      { label: 'Verification', value: details?.verification ?? 'Not confirmed' },
      { label: 'Rollback', value: notStarted ? 'Not needed' : restored ? 'Dependency files restored' : removalRollbackLabel(error.code) },
      { label: 'Dependency files', value: notStarted ? 'No files changed by this removal. Analyze project before trying again.' : restored ? 'package.json and the lockfile restored' : details === undefined ? 'Check package.json and the lockfile before you install again. This package no longer appears in the project.' : 'Check package.json and the lockfile before you install again.' },
    ]} />;
}
