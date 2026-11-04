/**
 * Restore point for a kept Smart Cleanup run.
 *
 * The cleanup transaction already captured the exact pre-cleanup bytes of
 * package.json and the active lockfile. After the run is kept, the host also
 * records the bytes the cleanup left behind. A later restore writes the
 * pre-cleanup bytes back only through the same compare-and-swap adapter the
 * transaction uses, so a file edited after the cleanup is never overwritten.
 */

import { fileStatesEqual } from './nodeUpgradeTransactionFiles.js';
import type {
  FileState,
  TransactionFileSnapshot,
  UpgradeTransactionFileAdapter,
} from './upgradeTransaction.js';

export interface SmartCleanupRestoreFile {
  path: string;
  /** Bytes before the cleanup started. */
  before: FileState;
  /** Bytes the kept cleanup left on disk. */
  after: FileState;
}

export type SmartCleanupRestoreFilesResult =
  | { status: 'restored' }
  /** A file no longer matches what the cleanup wrote. `wrote` is false when nothing was touched. */
  | { status: 'conflict'; wrote: boolean; recovered: boolean }
  | { status: 'failed'; wrote: boolean; recovered: boolean; message: string };

export const SMART_CLEANUP_RESTORE_TASK_TITLE = 'Packageawy: Restore dependency files';

export const SMART_CLEANUP_RESTORE_MESSAGES = {
  restored: 'package.json and the lockfile were put back as they were before the cleanup, and dependencies were reinstalled.',
  conflict: 'Restore was not started because package.json or the lockfile changed after the cleanup. Newer edits were preserved.',
  interrupted: 'Restore stopped because package.json or the lockfile changed while it ran. Newer edits were preserved.',
  unrecovered: 'Review package.json and the lockfile before continuing.',
  unavailable:
    'This restore point is no longer available because another dependency change or analysis started. Use source control if you need to reverse the cleanup.',
  installFailed:
    "package.json and the lockfile were restored, but reinstalling dependencies did not finish. Run your package manager's install command.",
} as const;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Pair the transaction's kept snapshot with the bytes now on disk. Returns
 * undefined when the files cannot be read or the cleanup changed nothing,
 * since there is then nothing safe or useful to restore.
 */
export async function captureSmartCleanupRestoreFiles(
  files: UpgradeTransactionFileAdapter,
  snapshot: readonly TransactionFileSnapshot[]
): Promise<SmartCleanupRestoreFile[] | undefined> {
  const captured: SmartCleanupRestoreFile[] = [];
  try {
    for (const entry of snapshot) {
      captured.push({ path: entry.path, before: entry.before, after: await files.read(entry.path) });
    }
  } catch {
    return undefined;
  }
  return captured.some((file) => !fileStatesEqual(file.before, file.after)) ? captured : undefined;
}

/**
 * Whether every file still holds exactly the bytes the cleanup left. A read
 * failure returns undefined: it does not prove that a file changed.
 */
export async function smartCleanupRestoreFilesMatchDisk(
  files: UpgradeTransactionFileAdapter,
  restoreFiles: readonly SmartCleanupRestoreFile[]
): Promise<boolean | undefined> {
  try {
    for (const file of restoreFiles) {
      if (!fileStatesEqual(await files.read(file.path), file.after)) return false;
    }
    return true;
  } catch {
    return undefined;
  }
}

/**
 * Write the pre-cleanup bytes back. Every file is checked before anything is
 * written. If a later swap still loses a race, files already restored are put
 * back to the cleanup bytes through the same guard.
 */
export async function restoreSmartCleanupFiles(
  files: UpgradeTransactionFileAdapter,
  restoreFiles: readonly SmartCleanupRestoreFile[]
): Promise<SmartCleanupRestoreFilesResult> {
  const changed = restoreFiles.filter((file) => !fileStatesEqual(file.before, file.after));
  const matches = await smartCleanupRestoreFilesMatchDisk(files, changed);
  if (matches === undefined) {
    return { status: 'failed', wrote: false, recovered: true, message: 'The dependency files could not be read.' };
  }
  if (!matches) return { status: 'conflict', wrote: false, recovered: true };

  const restored: SmartCleanupRestoreFile[] = [];
  const undo = async (): Promise<boolean> => {
    let recovered = true;
    for (const file of [...restored].reverse()) {
      try {
        if ((await files.compareAndSwap(file.path, file.before, file.after)) !== 'restored') recovered = false;
      } catch {
        recovered = false;
      }
    }
    return recovered;
  };

  for (const file of changed) {
    let result: 'restored' | 'conflict';
    try {
      result = await files.compareAndSwap(file.path, file.after, file.before);
    } catch (cause) {
      const recovered = await undo();
      return { status: 'failed', wrote: true, recovered, message: errorMessage(cause) };
    }
    if (result === 'conflict') {
      const recovered = await undo();
      return { status: 'conflict', wrote: restored.length > 0, recovered };
    }
    restored.push(file);
  }
  return { status: 'restored' };
}
