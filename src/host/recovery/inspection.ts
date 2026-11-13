import { createNodeUpgradeTransactionFileAdapter } from '../nodeUpgradeTransactionFiles.js';
import type { RecoveryPresentation } from '../webviewProtocol.js';
import {
  isBackup, isClaim, isJournal, isOwner, hash, matches, RECOVERY_MESSAGES, RecoveryError,
  type Journal, type Owner, type RecoveryTarget,
} from './model.js';
import { RecoveryJournal, folderExists } from './journal.js';
import { Storage, code, type StorageHooks } from './storage.js';
import { uninitializedEntries, validateRemovalInventory } from './removal.js';

function preview(bytes: Uint8Array): string {
  return Buffer.from(bytes).subarray(0, 4096).toString('utf8') + (bytes.length > 4096 ? '\n[Preview truncated]' : '');
}

export interface Inspection {
  storage: Storage;
  owner?: Owner;
  journal?: RecoveryJournal;
  view: RecoveryPresentation;
}
export async function inspectRecovery(target: RecoveryTarget, hooks: StorageHooks = {}): Promise<Inspection> {
  const storage = new Storage(target, hooks);
  const view: RecoveryPresentation = { state: 'none', message: '', claim: null, files: [], canDismiss: false, canApply: false };
  const result: Inspection = { storage, view };
  // With no journal, avoid component checks and adapter setup entirely.
  try { await storage.fs.lstat(storage.folder); }
  catch (error) { if (code(error) === 'ENOENT') return result; throw error; }
  await storage.initialize();
  if (!await folderExists(storage)) return result;
  view.state = 'blocked'; view.message = RECOVERY_MESSAGES.blocked;
  if (await storage.exists('takeover')) { view.state = 'takeover'; view.message = RECOVERY_MESSAGES.interruptedTakeover; return result; }
  const owner = await storage.json('owner.json');
  const raw = await storage.json('journal.json');
  const claim = await storage.read('claim.json').catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  view.claim = claim === undefined ? null : hash(claim);
  if (!isOwner(owner)) {
    try { await uninitializedEntries(storage); view.state = 'uninitialized'; }
    catch { view.state = 'invalid'; view.message = RECOVERY_MESSAGES.invalid; }
    return result;
  }
  if (owner.targetIdentity !== target.identity) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
  result.owner = owner;
  const contents = await storage.list();
  const metadataTail = contents.every((name) => name === 'owner.json' || name === '.gitignore');
  const tombstone = typeof raw === 'object' && raw !== null && 'outcome' in raw && raw.outcome === 'removing' && 'phase' in raw && raw.phase === 'metadata';
  if (metadataTail || tombstone) {
    await validateRemovalInventory(storage, undefined);
    view.state = 'removing'; view.message = RECOVERY_MESSAGES.completed; view.canDismiss = false;
    return result;
  }
  let data: Journal;
  if (isJournal(raw) && raw.transactionId === owner.transactionId && raw.ownerToken === owner.ownerToken) {
    data = raw;
  } else {
    view.state = 'invalid'; view.message = RECOVERY_MESSAGES.invalid;
    data = { version: 1, transactionId: owner.transactionId, ownerToken: owner.ownerToken, claimToken: null, sequence: 0, operation: target.operation, phase: 'recovery', step: 'incomplete', outcome: 'recovery-incomplete', files: [] };
    if (await storage.exists('backups')) {
      for (const name of await storage.list('backups')) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const backup = await storage.json(`backups/${name}`);
        if (isBackup(backup) && `${backup.id}.json` === name && backup.ownerToken === owner.ownerToken && backup.transactionId === owner.transactionId) {
          data.files.push({ backup, expected: { kind: 'unknown' }, progress: 'unknown', displacedIds: [] });
        }
      }
    }
  }
  const files = await createNodeUpgradeTransactionFileAdapter({ workspaceRoot: target.workspaceRoot, allowlistedPaths: target.allowlistedPaths });
  const journal = new RecoveryJournal(storage, owner, data, files);
  result.journal = journal;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const file of data.files) {
    try {
      if (ids.has(file.backup.id) || paths.has(file.backup.path)) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
      ids.add(file.backup.id); paths.add(file.backup.path);
      const candidate = await journal.filePath(file.backup);
      if (data.outcome !== 'removing') {
        const metadata = await storage.json(`backups/${file.backup.id}.json`);
        if (!isBackup(metadata) || JSON.stringify(metadata) !== JSON.stringify(file.backup)) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
        await journal.backupState(file.backup);
      }
      const current = await files.read(candidate);
      let progress: string = file.progress;
      if (file.move !== undefined && ['displace', 'displaced'].includes(file.progress)) {
        const displaced = await storage.exists(`displaced/${file.move.id}.bin`);
        progress = displaced && !current.exists ? 'moved but not restored'
          : displaced && file.backup.existed && current.exists && hash(current.contents) === file.backup.sha256 ? 'restored'
          : !displaced && matches(file.move.before, current) ? 'not started' : 'unknown';
      }
      const backup = data.outcome === 'removing' ? undefined : await journal.backupState(file.backup);
      view.files.push({ id: file.backup.id, path: file.backup.path, existed: file.backup.existed,
        backup: file.backup.sha256 ?? 'absent', current: current.exists ? hash(current.contents) : 'absent',
        backupPreview: backup?.exists ? preview(backup.contents) : '', currentPreview: current.exists ? preview(current.contents) : '', progress });
    } catch {
      view.state = 'invalid'; view.message = RECOVERY_MESSAGES.unsafe;
    }
  }
  if (view.state !== 'invalid') {
  if (data.outcome === 'removing') { view.state = 'removing'; view.message = RECOVERY_MESSAGES.completed; view.canDismiss = false; }
  else if (data.outcome === 'recovery-incomplete' || data.outcome === 'rollback-incomplete') { view.state = 'incomplete'; view.message = RECOVERY_MESSAGES.incomplete; view.canDismiss = false; }
  else if (data.outcome === 'completed' || data.outcome === 'rolled-back') { view.state = 'completed'; view.message = RECOVERY_MESSAGES.completed; view.canDismiss = false; }
  }
  if (isClaim(await storage.json('claim.json')) && view.state === 'blocked') view.message = RECOVERY_MESSAGES.blocked;
  return result;
}
