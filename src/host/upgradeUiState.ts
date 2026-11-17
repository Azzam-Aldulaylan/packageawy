/**
 * Pure decision for how the webview's optimistic "which package is
 * upgrading" state reacts to an `upgrade-error` message. Lives here rather
 * than under webview/src so it can be unit-tested. See upgradeAction.ts for
 * why (webview/tsconfig.json's `noEmit: true` means nothing there has a
 * compiled `out/` counterpart to import from a test).
 */

import type { DashboardData, UpgradeResultPresentation } from './webviewProtocol.js';

/** Overlay only freshly-confirmed local facts. All registry/security fields remain untouched until the UI's refreshing guard is replaced by a new scan. */
export function applyUpgradeResultLocalFacts(
  data: DashboardData,
  result: UpgradeResultPresentation
): DashboardData {
  const changes = new Map(result.changes.map((change) => [change.packageName, change]));
  return {
    ...data,
    rows: data.rows.map((row) => {
      const change = changes.get(row.name);
      if (change === undefined) return row;
      return {
        ...row,
        current: change.currentVersion ?? row.current,
        range: change.declaredRange ?? row.range,
        dev: change.classification === null ? row.dev : change.classification === 'dev',
        optional: change.classification === null ? row.optional : change.classification === 'optional',
      };
    }),
  };
}

/**
 * An analysis request may only start while no upgrade flow is active. Once an
 * analysis has been issued, the webview keeps that review as its current
 * decision result until it is confirmed, cancelled, or refreshed. Replacing
 * the tracked analysis with a duplicate request would orphan that result.
 */
export function upgradeAnalysisRequestIsAllowed(activePackage: string | null): boolean {
  return activePackage === null;
}

/** Late progressive messages are accepted only for the still-active attempt. */
export function upgradeAnalysisMessageMatchesRequest(
  activeRequestId: string | null,
  incomingRequestId: string
): boolean {
  return activeRequestId !== null && activeRequestId === incomingRequestId;
}

/**
 * Changing a selected target invalidates an analysis for that same Manage
 * dependency, but never touches a dashboard/bulk flow or another package.
 */
export function targetChangeInvalidatesManageAnalysis(
  packageName: string,
  previousTarget: string | null,
  nextTarget: string,
  activeUpgrade: string | null,
  upgradeOrigin: 'dashboard' | 'manage-dependency' | null
): boolean {
  return (
    previousTarget !== nextTarget &&
    upgradeOrigin === 'manage-dependency' &&
    activeUpgrade === packageName
  );
}

/** A completed read-only review for the same Manage dependency may stay cached
 * while the other review starts. In-progress analysis and real mutation never
 * yield this way. */
export function completedManageReviewCanCoexist(
  packageName: string,
  activePackage: string | null,
  origin: 'dashboard' | 'manage-dependency' | null,
  analysisReady: boolean,
  mutationBusy: boolean
): boolean {
  return origin === 'manage-dependency' && activePackage === packageName && analysisReady && !mutationBusy;
}

/**
 * A duplicate request's contention must not clear the tracked review.
 * Contention rejecting the tracked request is terminal: another window or
 * the previous attempt's cleanup may still own the project lock.
 * Clearing UI state never releases that host reservation.
 */
export function upgradeErrorClearsActiveState(code: string, activeRequestRejected = false): boolean {
  return code !== 'UPGRADE_IN_PROGRESS' || activeRequestRejected;
}

/**
 * Cancellation and duplicate-request contention stay quiet. Rejection of
 * the tracked request or analysis is visible so the user can retry after the
 * lock clears. Visibility does not discard the completed review.
 */
export function upgradeErrorIsUserVisible(code: string, activeAttemptRejected = false): boolean {
  return code !== 'CANCELLED' && (code !== 'UPGRADE_IN_PROGRESS' || activeAttemptRejected) && code !== 'OUTCOME_UNKNOWN';
}
