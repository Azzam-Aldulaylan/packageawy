import path from 'node:path';
import { matches } from './recovery/model.js';
import { precheckRestore } from './restorePrecheck.js';
import { manualReinstallNote, recoveryPackageManager } from './manualReinstallCopy.js';
import { resolveMutationTarget } from './mutationTarget.js';
import type { HostPlatform } from './platform/hostPlatform.js';
import type { RecoveryJournal } from './recovery/journal.js';
import type { UpgradeExecutionSession } from './upgradeRunner.js';

/** The caller keeps its mutation or recovery owner throughout the prompt and task. */
export async function offerFrozenReconciliation(
  journal: RecoveryJournal,
  platform: HostPlatform,
  session: UpgradeExecutionSession
): Promise<'skipped' | 'succeeded' | 'failed' | 'unknown'> {
  const target = journal.storage.target;
  const manifest = target.allowlistedPaths.find(candidate => path.basename(candidate) === 'package.json');
  const lockfile = target.allowlistedPaths.find(candidate => ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml'].includes(path.basename(candidate)));
  const packageManager = recoveryPackageManager(target.allowlistedPaths);
  const manualNote = manualReinstallNote(packageManager);
  const skip = (reason: string): 'skipped' => {
    platform.showWarningMessage(`${reason} ${manualNote}`);
    return 'skipped';
  };
  if (manifest === undefined || lockfile === undefined || !(await journal.files.read(lockfile)).exists) {
    return skip('The frozen reinstall offer is unavailable without a restored manifest and lockfile.');
  }
  const command = packageManager === 'npm' ? 'npm ci' : 'pnpm install --frozen-lockfile';
  const resolve = () => resolveMutationTarget({ projectDir: path.dirname(manifest), folderPath: target.workspaceRoot, packageManager, throwOnUnexpectedError: true });
  const initial = await resolve();
  if (!initial.ok || initial.identity !== target.identity) return skip('The dependency target changed. Reinstall was not started.');
  if (await platform.showModalWarning(
    'Dependency files restored. Reinstall node_modules?',
    `Run ${command} using the restored lockfile. Install scripts stay off. ${manualNote}`,
    ['Reinstall', 'Skip']
  ) !== 'Reinstall') return 'skipped';

  // The prompt can remain open while workspace topology or dependency files change.
  await journal.assertOwner();
  const current = await resolve();
  if (!current.ok || current.identity !== target.identity || !(await journal.files.read(lockfile)).exists) {
    return skip('The dependency target changed. Reinstall was not started.');
  }
  const conflicts = await precheckRestore(journal.data.files.map(file => ({
    path: file.backup.path,
    check: async () => matches(file.expected, await journal.files.read(await journal.filePath(file.backup))),
  })));
  if (conflicts.length > 0) {
    return skip(`${conflicts.map(file => file.message).join(' ')} Reinstall was not started.`);
  }
  const prepared = session.prepareLockfileReconciliation({
    cwd: path.dirname(manifest), packageManager, ignoreScripts: true,
    workspaceMember: current.target.workspaceMember,
    taskTitle: 'Packageawy: Reinstall restored dependencies',
    throwOnUnexpectedError: true,
  });
  if (!prepared.ok) { platform.showWarningMessage(`Reinstall could not start. ${prepared.message} ${manualNote}`); return 'failed'; }
  session.journal = journal;
  try {
    const result = await prepared.execute();
    if (!result.ok) {
      platform.showWarningMessage(result.status === 'unknown' ? result.message : `Dependency files restored. Reinstall failed. ${result.message} ${manualNote}`);
      return result.status === 'unknown' ? 'unknown' : 'failed';
    }
    return 'succeeded';
  } catch {
    // Once execution is dispatched an exception cannot establish that the writer stopped.
    return 'unknown';
  } finally { session.journal = undefined; }
}
