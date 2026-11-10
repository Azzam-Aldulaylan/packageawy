/**
 * Pure open/close rules for the two dashboard-level dialogs: Manage
 * dependency and Smart Cleanup. Kept free of React so the transitions are
 * covered by plain node tests.
 */

import type { RemoveProgressPhase, RemoveResultPresentation } from '../../src/host/webviewProtocol.js';

/**
 * Which package's Manage dialog stays remembered after a new dashboard
 * snapshot. The dialog stays open across a rescan of the same project while
 * its package is still listed. It is forgotten when the project changed or
 * the package is gone (removed here or outside VS Code), so a later snapshot
 * that lists the package again never reopens a dialog the user did not open.
 * The one exception is `heldPackage`: a removal started from this dialog
 * keeps it open while it runs and while its result is shown.
 */
export function manageRowAfterSnapshot(
  manageRow: string | null,
  previousProjectKey: string | null,
  nextProjectKey: string,
  nextRowNames: readonly string[],
  heldPackage: string | null = null
): string | null {
  if (manageRow === null) return null;
  if (previousProjectKey !== null && previousProjectKey !== nextProjectKey) return null;
  if (nextRowNames.includes(manageRow)) return manageRow;
  return heldPackage === manageRow ? manageRow : null;
}

/**
 * A removal confirmed from the Manage dialog. `row` is a copy of the package
 * as it looked before removal, so the dialog can keep showing it after the
 * package leaves the dashboard. Cleared when the dialog closes, the project
 * changes, or a new review starts.
 */
export interface ManageRemovalHold<Row extends { name: string }> {
  projectKey: string;
  analysisId: string;
  row: Row;
  phase: 'running' | 'result';
  progress: RemoveProgressPhase | null;
  result: RemoveResultPresentation | null;
}

export function beginManageRemoval<Row extends { name: string }>(
  row: Row,
  projectKey: string,
  analysisId: string
): ManageRemovalHold<Row> {
  return { projectKey, analysisId, row, phase: 'running', progress: null, result: null };
}

/** The package a hold keeps the Manage dialog open for, if any. */
export function manageRemovalHeldPackage<Row extends { name: string }>(hold: ManageRemovalHold<Row> | null): string | null {
  return hold === null ? null : hold.row.name;
}

export function manageRemovalAfterProgress<Row extends { name: string }>(
  hold: ManageRemovalHold<Row> | null,
  analysisId: string,
  phase: RemoveProgressPhase
): ManageRemovalHold<Row> | null {
  if (hold === null || hold.phase !== 'running' || hold.analysisId !== analysisId) return hold;
  return { ...hold, progress: phase };
}

export function manageRemovalAfterResult<Row extends { name: string }>(
  hold: ManageRemovalHold<Row> | null,
  result: RemoveResultPresentation
): ManageRemovalHold<Row> | null {
  if (hold === null || hold.phase !== 'running' || hold.analysisId !== result.analysisId) return hold;
  return { ...hold, phase: 'result', progress: null, result };
}

/** A snapshot from another project drops the hold. Same-project rescans keep it. */
export function manageRemovalAfterSnapshot<Row extends { name: string }>(
  hold: ManageRemovalHold<Row> | null,
  nextProjectKey: string
): ManageRemovalHold<Row> | null {
  if (hold === null) return null;
  return hold.projectKey === nextProjectKey ? hold : null;
}

/**
 * The row the Manage dialog renders: the dashboard's row while listed,
 * otherwise the held copy of a package this dialog just removed.
 */
export function manageDialogRow<Row extends { name: string }>(
  manageRow: string | null,
  rows: readonly Row[],
  hold: ManageRemovalHold<Row> | null
): Row | undefined {
  if (manageRow === null) return undefined;
  const listed = rows.find((row) => row.name === manageRow);
  if (listed !== undefined) return listed;
  return hold !== null && hold.row.name === manageRow ? hold.row : undefined;
}

/**
 * Which project a snapshot belongs to. Only the host-issued id is unique:
 * two workspace folders can share a label and a relative manifest path.
 */
export function dashboardProjectKey(project: { id: string; label: string; manifestPath: string }): string {
  return project.id;
}

export interface DashboardDialogs {
  manageOpen: boolean;
  smartCleanupOpen: boolean;
}

/**
 * Only one of Manage and Smart Cleanup is open at a time. Opening Smart
 * Cleanup closes Manage, unless Manage is busy with work its own Close
 * button would also refuse to interrupt. Opening Manage from the dashboard
 * while Smart Cleanup is open is refused: Smart Cleanup's own package links
 * close it first before opening Manage.
 */
export function dialogsAfterOpenRequest(
  current: DashboardDialogs,
  request: 'manage' | 'smart-cleanup',
  manageCloseBlocked: boolean
): DashboardDialogs {
  if (request === 'smart-cleanup') {
    if (current.manageOpen && manageCloseBlocked) return current;
    return { manageOpen: false, smartCleanupOpen: true };
  }
  if (current.smartCleanupOpen) return current;
  return { manageOpen: true, smartCleanupOpen: false };
}
