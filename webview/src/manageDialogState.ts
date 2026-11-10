/**
 * Pure open/close rules for the two dashboard-level dialogs: Manage
 * dependency and Smart Cleanup. Kept free of React so the transitions are
 * covered by plain node tests.
 */

/**
 * Which package's Manage dialog stays remembered after a new dashboard
 * snapshot. The dialog stays open across a rescan of the same project while
 * its package is still listed. It is forgotten when the project changed or
 * the package is gone (removed here or outside VS Code), so a later snapshot
 * that lists the package again never reopens a dialog the user did not open.
 */
export function manageRowAfterSnapshot(
  manageRow: string | null,
  previousProjectKey: string | null,
  nextProjectKey: string,
  nextRowNames: readonly string[]
): string | null {
  if (manageRow === null) return null;
  if (previousProjectKey !== null && previousProjectKey !== nextProjectKey) return null;
  return nextRowNames.includes(manageRow) ? manageRow : null;
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
