import { useContext } from 'react';
import { DependencyChangeContext } from './DependencyChangeStatus.js';
import type { ReactElement } from 'react';

import type { PackageRow } from '../../../src/core/types.js';
import type { RemoveProgressPhase, RemoveResultPresentation } from '../../../src/host/webviewProtocol.js';
import { IconRefresh } from '../icons.js';

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

const STATUS_LABEL: Record<StepStatus, string> = { complete: 'Done', running: 'In progress', waiting: 'Waiting' };

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
  return (
    <div className="upgrade-tab removal-running">
      <section className="analysis-card analysis-card--full" aria-labelledby="removal-running-heading">
        <h3 className="analysis-card__title" id="removal-running-heading" tabIndex={-1}>Removing {row.name}</h3>
        {change.task !== 'still-running' && !change.blocked ? <p className="analysis-card__pending-label" role="status" aria-live="polite">
          <IconRefresh className="banner__icon--spin" aria-hidden="true" /> {current?.running ?? 'Working'}…
        </p> : null}
        <ul className="verification-steps">
          {steps.map((step) => (
            <li className="verification-steps__item" key={step.label}>
              <span>{step.label}</span>
              <span className="status-badge status-badge--neutral">{STATUS_LABEL[step.status]}</span>
            </li>
          ))}
        </ul>
        <p className="analysis-card__hint">
          This dialog stays open until the removal finishes. A restore point protects your dependency files.
        </p>
      </section>
    </div>
  );
}

export function removalResultTitle(result: RemoveResultPresentation): string {
  if (result.outcome === 'rolled-back') return 'Removal rolled back';
  return result.verification === 'passed' ? 'Removal verified' : 'Package removed';
}

export function removalInstallLabel(result: RemoveResultPresentation): string {
  if (result.outcome !== 'rolled-back') return 'Succeeded';
  // Verification only runs after a successful install.
  return result.verification === 'failed' ? 'Succeeded' : 'Did not finish';
}

export function removalVerificationLabel(result: RemoveResultPresentation): string {
  if (result.verification === 'passed') return 'Passed';
  if (result.verification === 'not-configured') return 'Not configured';
  if (result.verification === 'failed') return 'Failed';
  return 'Not run';
}

/** The removal counterpart of the upgrade result: same card, read from the host's result fields. */
export function RemovalResultPanel({
  row,
  result,
}: {
  row: PackageRow;
  result: RemoveResultPresentation;
}): ReactElement {
  const kept = result.outcome !== 'rolled-back';
  const version = row.current ?? row.range;
  return (
    <div className="upgrade-tab" role="status" aria-live="polite">
      <section className="analysis-card analysis-card--full" aria-labelledby="removal-result-heading">
        <h3 className="analysis-card__title" id="removal-result-heading" tabIndex={-1}>{removalResultTitle(result)}</h3>
        {result.packages.map((name) => (
          <p key={name} className="analysis-card__hint">
            <code>{name}</code>
            {name === row.name ? <> <code>{version}</code></> : null}
            {kept ? ' was removed from package.json and the lockfile.' : ' is still in package.json.'}
          </p>
        ))}
        <dl className="manage-glance">
          <div className="manage-glance__row"><dt>Install</dt><dd>{removalInstallLabel(result)}</dd></div>
          <div className="manage-glance__row"><dt>Dependency files</dt><dd>{kept ? 'Updated' : 'Restored'}</dd></div>
          <div className="manage-glance__row"><dt>Verification</dt><dd>{removalVerificationLabel(result)}</dd></div>
          <div className="manage-glance__row">
            <dt>Rollback</dt>
            <dd>{result.rollback === 'succeeded' ? 'Restore point applied' : 'Not needed'}</dd>
          </div>
        </dl>
        {kept ? null : (
          <p className="analysis-card__hint">
            {result.message}
          </p>
        )}
        {kept && result.verification !== 'passed' ? (
          <p className="analysis-card__hint">
            Build and test checks did not confirm this change. Run your project checks before you commit.
          </p>
        ) : null}
      </section>
    </div>
  );
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
}: {
  row: PackageRow;
  error: { code: string; message: string };
}): ReactElement {
  return (
    <div className="upgrade-tab" role="alert">
      <section className="analysis-card analysis-card--full" aria-labelledby="removal-error-heading">
        <h3 className="analysis-card__title" id="removal-error-heading" tabIndex={-1}>Removal did not finish</h3>
        <p className="analysis-card__hint">{error.message}</p>
        <dl className="manage-glance">
          <div className="manage-glance__row"><dt>Package</dt><dd><code>{row.name}</code> <code>{row.current ?? row.range}</code></dd></div>
          <div className="manage-glance__row"><dt>Rollback</dt><dd>{removalRollbackLabel(error.code)}</dd></div>
        </dl>
        <p className="analysis-card__hint">
          Check package.json and the lockfile before you install again. This package no longer appears in the project.
        </p>
      </section>
    </div>
  );
}
