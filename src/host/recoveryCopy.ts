export const RECOVERY_MESSAGES = {
  undoAvailable: 'The change is done. Its backup is available to undo the dependency file changes.',
  undoUnavailable: 'This backup is no longer available. A later dependency change may have replaced it.',
  discoveryFailed: 'Could not check for backups. Try Retry discovery or Refresh. If it still fails, check folder access and open the Packageawy log.',
  restart: 'Cannot restart while a dependency change is running or its outcome is unknown.',
  restartRequired: 'Dependency changes are paused after an internal error. Restart the Packageawy engine to try again. The Packageawy log has the details.',
  stillRunning: 'Still running. The package manager is still working. Packageawy will not roll back or start another change on this project until it finishes.',
  running: 'A dependency change is running.',
  blocked: 'An earlier change may still be running. Dependency changes are paused until it is resolved.',
  invalid: 'The backup information is incomplete. Nothing was restored.',
  open: 'Review each file. Packageawy stops restoring if it sees that a file changed.',
  incomplete: 'Restoring files is not complete. The backup and files moved aside during restore are kept.',
  completed: 'File choices are complete. Review the result before deleting the backup.',
  confirmDiscard: 'Some files do not match the backup. Keeping the current files and deleting the backup cannot be undone. Confirm this separately to continue.',
  backupDeleted: 'Backup deleted. Dependency changes are available again.',
  unsupported: "This folder's file system does not support Packageawy's recovery safeguards, so changes are unavailable.",
  takingOver: 'Another window is opening this backup for recovery.',
  interruptedTakeover: 'Opening the backup in another window was interrupted. Close other Packageawy windows, then delete the `takeover` folder inside `.packageawy-recovery` by hand to continue.',
  unrecognized: 'The backup folder contains unrecognized files. Check the folder by hand. Nothing was removed.',
  unsafe: 'A backup file path could not be verified as safe. It was not read, written or restored.',
  stop: 'Confirm that installs, verification commands, other Packageawy windows and other recovery sessions have stopped.',
  warning: 'Check the task terminals in every editor and stop any install or verification command. Close other Packageawy windows and recovery sessions for this project. A running command could change files while they are being restored. Confirm only when no other recovery session is paused during a file change. Packageawy checks ownership and stops if it sees a file changed, but another process could still change a file between a check and a restore. The backup and files moved aside during restore stay until you delete them.',
} as const;


export type UndoOperation = 'cleanup' | 'removal' | 'upgrade' | 'remediation';
export const isUndoOperation = (value: unknown): value is UndoOperation =>
  value === 'cleanup' || value === 'removal' || value === 'upgrade' || value === 'remediation';

export const undoLabel = (operation: UndoOperation = 'cleanup'): string => ({
  cleanup: 'Undo cleanup', removal: 'Undo removal', upgrade: 'Undo upgrade', remediation: 'Undo transitive fix',
})[operation];
export const keptChangeLabel = (operation: UndoOperation = 'cleanup'): string => ({
  cleanup: 'Cleanup done', removal: 'Removal done', upgrade: 'Upgrade done', remediation: 'Transitive fix done',
})[operation];

export type RecoveryReinstall = 'not-run' | 'skipped' | 'succeeded' | 'failed' | 'unknown';
export const isRecoveryReinstall = (value: unknown): value is RecoveryReinstall =>
  typeof value === 'string' && ['not-run', 'skipped', 'succeeded', 'failed', 'unknown'].includes(value);
