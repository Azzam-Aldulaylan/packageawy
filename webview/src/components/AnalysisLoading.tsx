import { useCallback, useContext, useEffect, useRef } from 'react';
import { DependencyChangeContext } from './DependencyChangeStatus.js';
import type { ReactElement, ReactNode, RefCallback } from 'react';
import { IconRefresh } from '../icons.js';

/** Shared loading surface for read-only reviews and protected changes. */
export function AnalysisLoading({ label, detail, headingId, announcement, paused = false, loadingRef }: {
  label: string;
  detail?: ReactNode;
  headingId?: string;
  announcement?: string;
  paused?: boolean;
  loadingRef?: RefCallback<HTMLDivElement> | undefined;
}): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (headingId !== undefined) heading.current?.focus();
  }, [headingId]);
  return <>
    <div ref={loadingRef} className="analysis-loading" aria-busy={!paused}>
      {!paused ? <IconRefresh className="analysis-loading__icon banner__icon--spin" aria-hidden="true" /> : null}
      <h3 ref={heading} className="analysis-loading__title" id={headingId} tabIndex={headingId === undefined ? undefined : -1}>{label}</h3>
      {detail === undefined ? null : <p className="analysis-loading__detail">{detail}</p>}
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{paused ? '' : announcement ?? <>{label}{detail === undefined ? null : <> {detail}</>}</>}</span>
  </>;
}

export function upgradeApplyingLabel(changes: readonly { packageName: string; targetVersion: string }[]): string {
  const first = changes[0];
  return changes.length === 1 && first !== undefined
    ? `Upgrading ${first.packageName} to ${first.targetVersion}...`
    : `Upgrading ${changes.length} dependencies...`;
}

/** Return to Retry only when the removed applying surface still owned focus. */
export function useApplyingFailureFocus(busy: boolean, error: string | null) {
  const reviewRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const loadingRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    if (node === null) return;
    // Ref cleanup runs before removal, while activeElement still identifies
    // the loader. After removal the browser reports BODY instead.
    return () => { restoreFocus.current = node.contains(node.ownerDocument.activeElement); };
  }, []);
  useEffect(() => {
    if (busy) return;
    if (error !== null && restoreFocus.current) {
      reviewRef.current?.querySelector<HTMLButtonElement>('.upgrade-review__error button:not(:disabled)')?.focus();
    }
    restoreFocus.current = false;
  }, [busy, error]);
  return { reviewRef, loadingRef };
}

/** Recovery and long-running task notices own the visible status when needed. */
export function ChangeApplyingLoading({ label, loadingRef }: { label: string; loadingRef?: RefCallback<HTMLDivElement> | undefined }): ReactElement {
  const change = useContext(DependencyChangeContext);
  return <AnalysisLoading label={label} headingId="change-running-heading" loadingRef={loadingRef}
    paused={change.task === 'still-running' || change.blocked} />;
}
