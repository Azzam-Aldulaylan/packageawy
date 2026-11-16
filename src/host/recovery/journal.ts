import { isExpectedFsError } from '../expectedFsError.js';
import path from 'node:path';
import { constants } from 'node:fs';
import { createNodeUpgradeTransactionFileAdapter, fileStatesEqual } from '../nodeUpgradeTransactionFiles.js';
import { canonicalPath, isMissingPathError, relatePaths } from '../pathIdentity.js';
import { RestoreFileError, type FileState, type UpgradeTransactionFileAdapter } from '../upgradeTransaction.js';
import { Storage, type StorageHooks } from './storage.js';
import {
  expectation, hash, isClaim, isOwner, matches, newId, RECOVERY_MESSAGES, RecoveryError,
  type Backup, type Journal, type JournalFile, type Owner, type RecoveryTarget,
} from './model.js';
import { removeSavedFiles } from './removal.js';

export class RecoveryJournal {
  claimToken: string | null = null;

  /** An old flow may observe its task end, but must never write or finish after failure. */
  fence(): void { this.storage.fence(); }
  /** No await may separate this local fence from dispatching a mutation. */
  assertWritable(): void {
    this.storage.assertWritable();
  }
  constructor(readonly storage: Storage, readonly owner: Owner, readonly data: Journal, readonly files: UpgradeTransactionFileAdapter) {
    this.claimToken = data.claimToken;
  }
  async assertOwner(ownsTakeover = false, allowFenced = false): Promise<void> {
    // Once publication fails, later success cannot erase the last durable intent.
    this.storage.assertWritable(allowFenced);
    const owner = await this.storage.json('owner.json');
    const claim = await this.storage.json('claim.json');
    if (!isOwner(owner) || owner.transactionId !== this.owner.transactionId || owner.ownerToken !== this.owner.ownerToken ||
        (this.claimToken === null ? claim !== undefined || await this.storage.exists('claim.json') : !isClaim(claim) || claim.token !== this.claimToken) ||
        (!ownsTakeover && await this.storage.exists('takeover'))) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
    this.storage.assertWritable(allowFenced);
  }
  /** Only the new claimant may save while holding its own takeover directory. */
  async save(ownsTakeover = false, allowFenced = false): Promise<void> {
    this.data.sequence += 1;
    this.data.claimToken = this.claimToken;
    await this.storage.writeJson('journal.json', this.data, false, () => this.assertOwner(ownsTakeover, allowFenced), allowFenced);
  }
  async record(step: string, phase: 'intent' | 'finished'): Promise<void> {
    await this.assertOwner();
    this.data.step = step;
    this.data.phase = phase;
    if (phase === 'finished') {
      for (const file of this.data.files) {
        try { file.expected = expectation(await this.files.read(await this.filePath(file.backup))); }
        catch (error) {
          // Partial recovery omits unsafe backup paths from its choices. Their
          // expectations stay unknown, while unexpected read errors still fail.
          if (step !== 'recovery-completion' || !(error instanceof RecoveryError) || error.message !== RECOVERY_MESSAGES.unsafe) throw error;
          file.expected = { kind: 'unknown' };
        }
      }
    }
    await this.save();
    await this.storage.boundary(`journal:${step}:${phase}`);
  }
  async filePath(backup: Backup): Promise<string> {
    const relative = backup.path;
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    const candidate = path.join(this.storage.target.root, relative);
    if (relatePaths(this.storage.target.root, candidate) !== 'inside') throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    // The adapter's allowlist is independent of the untrusted metadata.
    await this.files.read(candidate);
    return candidate;
  }
  async backupState(backup: Backup): Promise<FileState> {
    await this.filePath(backup);
    if (backup.transactionId !== this.owner.transactionId || backup.ownerToken !== this.owner.ownerToken) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    if (!backup.existed) return { exists: false };
    const bytes = await this.storage.read(`backups/${backup.id}.bin`);
    if (hash(bytes) !== backup.sha256) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    return { exists: true, contents: bytes };
  }
  async unknown(reason: string): Promise<void> {
    this.fence();
    this.data.outcome = 'unknown';
    this.data.step = reason;
    await this.save(false, true);
  }

  private async syncDisplaced(file: JournalFile, candidate: string): Promise<void> {
    const move = file.move;
    if (move === undefined) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
    // Windows requires a writable handle for fsync (r+). Keep POSIX read-only
    // handles so preserving an inode does not require write permission there.
    const access = (this.storage.hooks.platform ?? process.platform) === 'win32' ? constants.O_RDWR : constants.O_RDONLY;
    const displaced = await this.storage.fs.open(await this.storage.at(`displaced/${move.id}.bin`), access | constants.O_NOFOLLOW);
    try {
      if (!(await displaced.stat()).isFile()) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
      if (!matches(move.before, { exists: true, contents: await displaced.readFile() })) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
      await displaced.sync();
    } finally { await displaced.close(); }
    await this.storage.syncDirectory(path.dirname(candidate));
    await this.storage.syncDirectory(await this.storage.at('displaced'));
  }

  /** Rename the actual displaced inode. A failed move never installs a replacement. */
  async replace(file: JournalFile, expected: FileState, replacement: FileState): Promise<'restored' | 'conflict'> {
    await this.assertOwner();
    const candidate = await this.filePath(file.backup);
    if (!fileStatesEqual(await this.files.read(candidate), expected)) return 'conflict';
    // A failed sync leaves the source absent. Retry must make the recorded
    // displacement durable before even an absent backup can count as restored.
    if (file.move !== undefined && ['displace', 'displaced'].includes(file.progress)) {
      if (await this.storage.exists(`displaced/${file.move.id}.bin`)) await this.syncDisplaced(file, candidate);
      else if (!matches(file.move.before, expected)) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
    }
    if (fileStatesEqual(expected, replacement)) {
      file.progress = 'restored';
      await this.save();
      return 'restored';
    }
    if (expected.exists) {
      const id = newId();
      file.displacedIds.push(id);
      file.move = { id, before: expectation(expected) };
      file.progress = 'displace';
      await this.save();
      await this.assertOwner();
      if (!fileStatesEqual(await this.files.read(candidate), expected)) return 'conflict';
      if (await this.storage.exists(`displaced/${id}.bin`)) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
      const source = await this.storage.safeAbsolute(candidate);
      const destination = await this.storage.at(`displaced/${id}.bin`);
      this.assertWritable();
      try { await this.storage.fs.rename(source, destination); }
      catch (cause) {
        if (!isExpectedFsError(cause, 'restoreRename')) throw cause;
        throw new RestoreFileError(cause);
      }
      // A directory sync preserves the name, but only syncing the moved inode
      // makes the user's bytes durable before we publish success or replace it.
      await this.syncDisplaced(file, candidate);
      await this.storage.boundary('displacement:moved');
      file.progress = 'displaced';
      await this.save();
    }
    // An existing file already published its displaced state above.
    if (!expected.exists) await this.save();
    await this.storage.boundary('restore:intent');
    await this.assertOwner();
    if ((await this.files.read(candidate)).exists) return 'conflict';
    if (replacement.exists) {
      // The backup is retained. A fresh temporary inode is renamed only
      // after the displaced inode and its identity have been recorded.
      const temporary = `displaced/restore.tmp-${newId()}`;
      await this.storage.publish(temporary, replacement.contents, false, () => this.assertOwner(), file.backup.mode);
      await this.assertOwner();
      await this.filePath(file.backup);
      if ((await this.files.read(candidate)).exists) return 'conflict';
      const source = await this.storage.at(temporary);
      const destination = await this.storage.safeAbsolute(candidate);
      this.assertWritable();
      try { await this.storage.fs.rename(source, destination); }
      catch (cause) {
        if (!isExpectedFsError(cause, 'restoreRename')) throw cause;
        throw new RestoreFileError(cause);
      }
      await this.storage.syncDirectory(path.dirname(candidate));
    }
    await this.storage.boundary('replacement:installed');
    file.progress = 'restored';
    file.expected = expectation(replacement);
    await this.save();
    return 'restored';
  }

  /** Staging uses the existing adapter; automatic rollback preserves every displacement. */
  adapter(): UpgradeTransactionFileAdapter {
    return {
      read: (candidate) => this.files.read(candidate),
      compareAndSwap: async (candidate, expected, replacement) => {
        await this.assertOwner();
        const entry = this.data.files.find((file) => path.join(this.storage.target.root, file.backup.path) === candidate);
        if (entry === undefined) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
        if (this.data.step === 'rollback') return this.replace(entry, expected, replacement);
        await this.record(`write:${entry.backup.id}`, 'intent');
        this.assertWritable();
        const result = await this.files.compareAndSwap(candidate, expected, replacement, () => this.assertWritable());
        await this.record(`write:${entry.backup.id}`, 'finished');
        return result;
      },
    };
  }
  async finish(completion: string, retain = false): Promise<boolean> {
    await this.assertOwner();
    this.data.outcome = completion === 'kept' ? 'completed' : completion === 'incomplete' ? 'rollback-incomplete' : 'rolled-back';
    await this.record('completion', 'finished');
    if (retain || completion === 'incomplete' || this.data.files.some((file) => file.displacedIds.length > 0)) return false;
    await removeSavedFiles(this.storage, this.owner, this.data, null, () => this.assertOwner());
    return true;
  }
}

export async function prepareJournal(target: RecoveryTarget, hooks: StorageHooks = {}): Promise<RecoveryJournal> {
  const storage = new Storage(target, hooks);
  await storage.initialize();
  const files = await createNodeUpgradeTransactionFileAdapter({ workspaceRoot: target.workspaceRoot, allowlistedPaths: target.allowlistedPaths });
  for (const candidate of target.allowlistedPaths) {
    if (relatePaths(await canonicalPath(target.root), await canonicalPath(candidate)) !== 'inside') throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
  }
  const folder = await storage.safeAbsolute(storage.folder);
  storage.assertWritable();
  try { await storage.fs.mkdir(folder); }
  catch (error) { if (isExpectedFsError(error, 'exclusiveCreate')) throw new RecoveryError(RECOVERY_MESSAGES.blocked); throw error; }
  await storage.boundary('folder:created');
  await storage.syncDirectory(target.root);
  const owner: Owner = { version: 1, transactionId: newId(), ownerToken: newId(), hostKind: target.hostKind, createdAt: new Date().toISOString(), targetIdentity: target.identity };
  await storage.writeJson('owner.json', owner, true);
  const data: Journal = { version: 1, transactionId: owner.transactionId, ownerToken: owner.ownerToken, claimToken: null, sequence: 0, operation: target.operation, phase: 'prepared', step: 'prepared', outcome: 'running', files: [] };
  const journal = new RecoveryJournal(storage, owner, data, files);
  await storage.publish('.gitignore', '*', false, () => journal.assertOwner());
  await storage.mkdir('backups');
  await storage.mkdir('displaced');
  for (const candidate of target.allowlistedPaths) {
    const state = await files.read(candidate);
    const id = newId();
    const backup: Backup = {
      id, path: path.relative(target.root, candidate).split(path.sep).join('/'), existed: state.exists,
      mode: state.exists ? (await storage.fs.lstat(candidate)).mode & 0o777 : 0o600,
      sha256: state.exists ? hash(state.contents) : null, transactionId: owner.transactionId, ownerToken: owner.ownerToken,
    };
    if (state.exists) await storage.publish(`backups/${id}.bin`, state.contents, false, () => journal.assertOwner());
    await storage.writeJson(`backups/${id}.json`, backup, false, () => journal.assertOwner());
    data.files.push({ backup, expected: backup.sha256 === null ? { kind: 'absent' } : { kind: 'present', sha256: backup.sha256 }, progress: 'pending', displacedIds: [] });
  }
  await journal.save();
  await storage.boundary('prepared');
  // A source changed while backing up is a refusal before staging, not
  // permission to mutate using a snapshot different from the durable one.
  for (const file of data.files) {
    if (!fileStatesEqual(await files.read(await journal.filePath(file.backup)), await journal.backupState(file.backup))) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
  }
  return journal;
}

export async function folderExists(storage: Storage): Promise<boolean> {
  try { await storage.fs.lstat(await storage.safeAbsolute(storage.folder)); return true; }
  catch (error) { if (isMissingPathError(error)) return false; throw error; }
}
