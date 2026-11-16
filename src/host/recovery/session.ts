import { isExpectedFsError } from '../expectedFsError.js';
import { RestoreFileError } from '../upgradeTransaction.js';
import { precheckRestore } from '../restorePrecheck.js';
import { manualReinstallNote, recoveryPackageManager } from '../manualReinstallCopy.js';
import type { RecoveryChoice, RecoveryPresentation } from '../webviewProtocol.js';
import {
  hash, isClaim, isOwner, newId, RECOVERY_MESSAGES, RecoveryError, RecoveryOutcomeUnknownError, type Claim, type RecoveryTarget,
} from './model.js';
import { inspectRecovery, type Inspection } from './inspection.js';
import { type StorageHooks } from './storage.js';
import { removeSavedFiles, removeUninitialized, validateRemovalInventory } from './removal.js';

/** Only an observed mismatch is a known conflict during restore. */
class RestoreConflictError extends RecoveryError {}

/** A screen close never settles this session or resumes its saved choices. */
export class RecoverySession {
  private outcomeUnknown = false;
  private constructor(readonly inspection: Inspection, readonly token: string | null) {}

  static async open(target: RecoveryTarget, stopped: boolean, confirmedClaim: string | null, hooks: StorageHooks = {}): Promise<RecoverySession> {
    if (!stopped) throw new RecoveryError(RECOVERY_MESSAGES.stop);
    const inspection = await inspectRecovery(target, hooks);
    const { storage, owner, journal, view } = inspection;
    if (view.state === 'none') throw new RecoveryError(RECOVERY_MESSAGES.blocked);
    if (view.state === 'takeover') throw new RecoveryError(RECOVERY_MESSAGES.interruptedTakeover);
    if (view.state === 'uninitialized') return new RecoverySession(inspection, null);
    if (owner === undefined) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    if (view.state === 'removing') return new RecoverySession(inspection, null);
    if (view.claim !== confirmedClaim) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
    if (journal === undefined) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    const token = newId();
    const claim: Claim = { token, createdAt: new Date().toISOString(), previousToken: null };
    const checkOwner = async (): Promise<void> => {
      const current = await storage.json('owner.json');
      if (!isOwner(current) || current.ownerToken !== owner.ownerToken || current.transactionId !== owner.transactionId) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
    };
    if (confirmedClaim !== null) {
      try { await storage.mkdir('takeover'); }
      catch (error) { if (isExpectedFsError(error, 'exclusiveCreate')) throw new RecoveryError(RECOVERY_MESSAGES.takingOver); throw error; }
      await storage.boundary('takeover:created');
      await checkOwner();
      const previousBytes = await storage.read('claim.json');
      if (hash(previousBytes) !== confirmedClaim) {
        // This contender has changed no claim bytes. Release only the
        // serialization directory it just created, so a stale confirmation
        // cannot strand the winner or require manual crash recovery.
        await storage.rmdir('takeover');
        await storage.syncDirectory();
        throw new RecoveryError(RECOVERY_MESSAGES.blocked);
      }
      const previous = await storage.json('claim.json');
      claim.previousToken = isClaim(previous) ? previous.token : null;
      const source = await storage.at('claim.json');
      const destination = await storage.at(`claim.${claim.previousToken ?? newId()}.abandoned`);
      storage.assertWritable();
      await storage.fs.rename(source, destination);
      await storage.syncDirectory();
      await storage.boundary('takeover:abandoned');
      await storage.writeJson('claim.json', claim, true, checkOwner);
    } else {
      await storage.writeJson('claim.json', claim, true, async () => {
        await checkOwner();
        if (await storage.exists('takeover')) throw new RecoveryError(RECOVERY_MESSAGES.takingOver);
      });
    }
    journal.claimToken = token;
    // Keep takeover serialized through both durable publications. Otherwise a
    // delayed contender can acquire the directory and fence this save.
    await journal.save(confirmedClaim !== null);
    if (confirmedClaim !== null) {
      // Publication errors retain the directory for manual crash recovery.
      await storage.rmdir('takeover');
      await storage.syncDirectory();
    }
    view.state = 'open'; view.message = RECOVERY_MESSAGES.open;
    view.claim = hash(await storage.read('claim.json'));
    return new RecoverySession(inspection, token);
  }

  async presentation(): Promise<RecoveryPresentation> {
    const latest = await inspectRecovery(this.inspection.storage.target, this.inspection.storage.hooks);
    if (this.inspection.storage.publicationFailed || this.outcomeUnknown) return latest.view;
    if (this.token === null && ['uninitialized', 'removing'].includes(latest.view.state)) {
      latest.view.state = 'open'; latest.view.canDismiss = true;
    } else if (this.token !== null && latest.view.claim === this.inspection.view.claim) {
      const outcome = this.inspection.journal?.data.outcome;
      latest.view.canApply = (this.inspection.journal?.data.step !== 'recovery-completion' || outcome === 'recovery-incomplete') && outcome !== 'removing';
      if (latest.view.state === 'blocked' || this.inspection.journal?.data.step === 'completion') {
        latest.view.state = 'open'; latest.view.message = RECOVERY_MESSAGES.open;
      }
      latest.view.canDismiss = outcome === 'completed' || outcome === 'rolled-back' || outcome === 'recovery-incomplete' || outcome === 'rollback-incomplete';
    }
    this.inspection.view.files = latest.view.files;
    return latest.view;
  }

  /** A stale session must stay fenced even when publishing unknown fails. */
  async invalidate(cause: unknown): Promise<never> {
    this.outcomeUnknown = true;
    const journal = this.inspection.journal;
    journal?.fence();
    if (journal !== undefined) journal.data.outcome = 'unknown';
    try { await journal?.unknown('The recovery result could not be established.'); }
    catch { /* The last durable intent and claim remain retained. */ }
    throw new RecoveryOutcomeUnknownError(RECOVERY_MESSAGES.blocked, { cause });
  }

  async apply(choices: readonly RecoveryChoice[]): Promise<void> {
    const { journal, storage } = this.inspection;
    if (journal === undefined || this.token === null) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    const manualNote = manualReinstallNote(recoveryPackageManager(storage.target.allowlistedPaths));
    const uncertain = (cause: unknown): Promise<never> => this.invalidate(cause);
    try { await journal.assertOwner(); }
    catch (cause) { return uncertain(cause); }
    const selected = choices.map((choice) => {
      const file = journal.data.files.find((entry) => entry.backup.id === choice.id);
      const shown = this.inspection.view.files.find((entry) => entry.id === choice.id);
      if (file === undefined || shown === undefined || shown.current !== choice.current || (choice.action === 'restore' && !file.backup.existed && !choice.approveDeletion)) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
      return { choice, file };
    });
    if (new Set(choices.map((choice) => choice.id)).size !== this.inspection.view.files.length || choices.length !== this.inspection.view.files.length) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    const check = async (entry: typeof selected[number]): Promise<boolean> => {
      await journal.assertOwner();
      const current = await journal.files.read(await journal.filePath(entry.file.backup));
      const unchanged = (current.exists ? hash(current.contents) : 'absent') === entry.choice.current;
      await journal.backupState(entry.file.backup);
      return unchanged;
    };
    let issues;
    try {
      issues = await precheckRestore(selected.map(entry => ({
        path: entry.file.backup.path,
        check: () => check(entry),
      })));
    } catch (cause) { return uncertain(cause); }
    try {
      if (issues.length > 0) throw new RestoreConflictError(`${RECOVERY_MESSAGES.incomplete} ${issues.map(issue => issue.message).join(' ')} ${manualNote}`);
      for (const entry of selected) {
        if (!await check(entry)) throw new RestoreConflictError(`${RECOVERY_MESSAGES.incomplete} Dependency file changed: ${entry.file.backup.path}. ${manualNote}`);
        if (entry.choice.action === 'keep') { entry.file.progress = 'keep'; await journal.save(); }
        else {
          const candidate = await journal.filePath(entry.file.backup);
          const current = await journal.files.read(candidate);
          if ((current.exists ? hash(current.contents) : 'absent') !== entry.choice.current ||
              await journal.replace(entry.file, current, await journal.backupState(entry.file.backup)) !== 'restored') throw new RestoreConflictError(`${RECOVERY_MESSAGES.incomplete} Dependency file changed: ${entry.file.backup.path}. ${manualNote}`);
        }
      }
      journal.data.outcome = selected.length === journal.data.files.length ? 'completed' : 'recovery-incomplete';
      await journal.record('recovery-completion', 'finished');
      await storage.boundary('recovery:completed');
    } catch (error) {
      if (!(error instanceof RestoreConflictError) && !(error instanceof RestoreFileError)) return uncertain(error);
      try {
        journal.data.outcome = 'recovery-incomplete';
        await journal.save();
      } catch (cause) { return uncertain(cause); }
      throw error;
    }
  }

  async dismiss(stopped: boolean, discardIncomplete: boolean): Promise<void> {
    if (this.outcomeUnknown || this.inspection.storage.publicationFailed) throw new RecoveryOutcomeUnknownError(RECOVERY_MESSAGES.blocked);
    if (!stopped) throw new RecoveryError(RECOVERY_MESSAGES.stop);
    const { storage, owner, journal, view } = this.inspection;
    if (view.state === 'uninitialized') { await removeUninitialized(storage, stopped); return; }
    if (owner === undefined) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    if (view.state !== 'removing' && journal?.data.outcome !== 'completed' && journal?.data.outcome !== 'rolled-back' && !discardIncomplete) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
    try { await validateRemovalInventory(storage, journal?.data); }
    catch (cause) {
      if (cause instanceof RecoveryError) throw cause;
      return this.invalidate(cause);
    }
    try { await removeSavedFiles(storage, owner, journal?.data, this.token); }
    catch (cause) { return this.invalidate(cause); }
  }
}
