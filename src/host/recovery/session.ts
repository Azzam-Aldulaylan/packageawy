import type { RecoveryChoice, RecoveryPresentation } from '../webviewProtocol.js';
import {
  hash, isClaim, isOwner, newId, RECOVERY_MESSAGES, RecoveryError, type Claim, type RecoveryTarget,
} from './model.js';
import { inspectRecovery, type Inspection } from './inspection.js';
import { code, type StorageHooks } from './storage.js';
import { removeSavedFiles, removeUninitialized, validateRemovalInventory } from './removal.js';

/** A screen close never settles this session or resumes its saved choices. */
export class RecoverySession {
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
      catch (error) { if (code(error) === 'EEXIST') throw new RecoveryError(RECOVERY_MESSAGES.takingOver); throw error; }
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
    if (this.inspection.storage.publicationFailed) return latest.view;
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

  async apply(choices: readonly RecoveryChoice[]): Promise<void> {
    const { journal, storage } = this.inspection;
    if (journal === undefined || this.token === null) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    await journal.assertOwner();
    const selected = choices.map((choice) => {
      const file = journal.data.files.find((entry) => entry.backup.id === choice.id);
      const shown = this.inspection.view.files.find((entry) => entry.id === choice.id);
      if (file === undefined || shown === undefined || shown.current !== choice.current || (choice.action === 'restore' && !file.backup.existed && !choice.approveDeletion)) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
      return { choice, file };
    });
    if (new Set(choices.map((choice) => choice.id)).size !== this.inspection.view.files.length || choices.length !== this.inspection.view.files.length) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    const check = async (entry: typeof selected[number]): Promise<void> => {
      await journal.assertOwner();
      const current = await journal.files.read(await journal.filePath(entry.file.backup));
      if ((current.exists ? hash(current.contents) : 'absent') !== entry.choice.current) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
      await journal.backupState(entry.file.backup);
    };
    try {
      for (const entry of selected) await check(entry);
      for (const entry of selected) {
        await check(entry);
        if (entry.choice.action === 'keep') { entry.file.progress = 'keep'; await journal.save(); }
        else {
          const candidate = await journal.filePath(entry.file.backup);
          const current = await journal.files.read(candidate);
          if (await journal.replace(entry.file, current, await journal.backupState(entry.file.backup)) !== 'restored') throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
        }
      }
      journal.data.outcome = selected.length === journal.data.files.length ? 'completed' : 'recovery-incomplete';
      await journal.record('recovery-completion', 'finished');
    } catch (error) {
      journal.data.outcome = 'recovery-incomplete';
      await journal.save();
      throw error;
    }
    await storage.boundary('recovery:completed');
  }

  async dismiss(stopped: boolean, discardIncomplete: boolean): Promise<void> {
    if (!stopped) throw new RecoveryError(RECOVERY_MESSAGES.stop);
    const { storage, owner, journal, view } = this.inspection;
    if (view.state === 'uninitialized') { await removeUninitialized(storage, stopped); return; }
    if (owner === undefined) throw new RecoveryError(RECOVERY_MESSAGES.invalid);
    if (view.state !== 'removing' && journal?.data.outcome !== 'completed' && journal?.data.outcome !== 'rolled-back' && !discardIncomplete) throw new RecoveryError(RECOVERY_MESSAGES.incomplete);
    await validateRemovalInventory(storage, journal?.data);
    await removeSavedFiles(storage, owner, journal?.data, this.token);
  }
}
