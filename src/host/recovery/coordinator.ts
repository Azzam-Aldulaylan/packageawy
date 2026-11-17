import { RestoreFileError } from '../upgradeTransaction.js';
import path from 'node:path';
import { hash } from './model.js';
import { RecoveryLock } from '../recoveryLock.js';
import type { HostPlatform } from '../platform/hostPlatform.js';
import type { OwnerHandle } from '../operationReservation.js';
import type { ProjectMutationLocks } from '../projectMutationLock.js';
import { lockKey } from '../pathIdentity.js';
import type { DependencyTaskState, HostToWebviewMessage, RecoveryChoice, RecoveryPresentation } from '../webviewProtocol.js';
import { RECOVERY_MESSAGES, RecoveryError, RecoveryOutcomeUnknownError, RecoveryUndoUnavailableError, type Operation, type RecoveryTarget } from './model.js';
import type { RecoveryJournal } from './journal.js';
import type { RecoverySession } from './session.js';

export class RecoveryCoordinator {
  private session: RecoverySession | undefined;
  private lock: { handle: RecoveryLock; token: string } | undefined;
  private pending = Promise.resolve();
  private shown = false;
  private readonly targets = new Map<string, RecoveryTarget>();
  private selected: string | undefined;
  private undo: { target: RecoveryTarget; transactionId: string; operation: Operation } | undefined;
  private entriesShown = false;
  private discoveryFailed = false;
  constructor(private readonly options: {
    platform: HostPlatform;
    locks: ProjectMutationLocks;
    target(): Promise<RecoveryTarget | undefined>;
    post(message: HostToWebviewMessage): void;
    removed(): Promise<void>;
    restored?(journal: RecoveryJournal): Promise<'skipped' | 'succeeded' | 'failed' | 'unknown'>;
    backupChanged?(target: RecoveryTarget, transactionId: string, outcome: 'changed' | 'restored' | 'resolved' | 'unavailable', cleanupAnalysisId?: string): void;
    backupsDiscovered?(backups: Array<{ target: RecoveryTarget; transactionId: string; analysisId: string; operation: Operation }>): void;
  }) {}

  reportTaskState(state: DependencyTaskState): void {
    if (this.lock !== undefined && this.session !== undefined) {
      this.options.locks.reportTaskState(lockKey(this.session.inspection.storage.target.root, true), this.lock.handle, state);
    }
    this.options.post({ status: 'dependency-task', state });
  }
  async inspect(id?: string): Promise<void> {
    await this.enqueue(async () => {
      // Loading filesystem recovery code waits with discovery until after startup.
      const { findRecoveryTargets } = await import('./targetDiscovery.js');
      const { inspectRecovery } = await import('./inspection.js');
      const discovered = await findRecoveryTargets(this.options.platform);
      if (this.discoveryFailed) {
        this.discoveryFailed = false;
        this.post({ state: 'none', message: '', files: [], claim: null, canDismiss: false, canApply: false });
      }
      this.targets.clear();
      const backups = new Map<string, { target: RecoveryTarget; transactionId: string; analysisId: string; operation: Operation }>();
      const rememberBackup = (target: RecoveryTarget, inspection: Awaited<ReturnType<typeof inspectRecovery>>): void => {
        const journal = inspection.journal;
        if (inspection.view.state === 'undo-available' && journal !== undefined) {
          backups.set(target.root, { target, transactionId: journal.owner.transactionId,
            operation: journal.data.operation, analysisId: journal.data.cleanupAnalysisId ?? journal.owner.transactionId });
        }
      };
      for (const target of discovered) {
        const inspection = await inspectRecovery(target);
        rememberBackup(target, inspection);
        // Successful backups are undo points, never automatic recovery targets.
        if (inspection.view.state !== 'undo-available') this.targets.set(hash(Buffer.from(target.root)), target);
      }
      if (this.targets.size === 0) {
        // The selected project can still need recovery when directory discovery
        // is unavailable. Keep that fallback, without exposing a kept success.
        const target = await this.options.target();
        if (target !== undefined) {
          const inspection = await inspectRecovery(target);
          rememberBackup(target, inspection);
          const key = lockKey(target.root, true);
          const holder = this.options.locks.holderOf(key) as OwnerHandle | RecoveryLock | undefined;
          if ((inspection.view.state !== 'none' && inspection.view.state !== 'undo-available') ||
              holder?.state === 'mutating' || this.options.locks.taskState(key) !== 'idle') this.targets.set(hash(Buffer.from(target.root)), target);
        }
      }
      this.options.backupsDiscovered?.([...backups.values()]);
      this.postEntries();
      if (id !== undefined && !this.targets.has(id)) return;
      // A claimed Undo becomes an ordinary recovery entry. Keep its intent
      // only while that entry still belongs to the same transaction.
      if (this.undo !== undefined) {
        const undoId = hash(Buffer.from(this.undo.target.root));
        const inspection = await inspectRecovery(this.undo.target, {}, this.undo.transactionId);
        if (this.targets.has(undoId) && (id === undefined || id === undoId) &&
            inspection.owner?.transactionId === this.undo.transactionId) this.selected = undoId;
        else this.undo = undefined;
      }
      if (id !== undefined) this.selected = id;
      if (this.selected !== undefined && !this.targets.has(this.selected)) this.selected = undefined;
      if (this.selected === undefined) this.selected = this.targets.keys().next().value;
      const selectedTarget = this.selected === undefined ? undefined : this.targets.get(this.selected);
      if (this.session?.inspection.storage.target.identity !== selectedTarget?.identity) this.session = undefined;
      // An idle-task notification can transition a claimed undo into ordinary
      // recovery. Preserve its actual lock, including an unknown session whose
      // journal must remain fenced, rather than keying ownership to UI selection.
      if (selectedTarget === undefined || (this.lock !== undefined &&
          this.options.locks.holderOf(lockKey(selectedTarget.root, true)) !== this.lock.handle)) this.lock = undefined;
      if (this.selected === undefined) {
        this.post({ state: 'none', message: '', files: [], claim: null, canDismiss: false, canApply: false });
        return;
      }
      await this.execute(async (target) => {
        const holder = this.options.locks.holderOf(lockKey(target.root, true)) as OwnerHandle | RecoveryLock | undefined;
        if (holder?.state === 'mutating' || this.options.locks.taskState(lockKey(target.root, true)) !== 'idle') {
          this.options.post({ status: 'dependency-task', state: this.options.locks.taskState(lockKey(target.root, true)) });
          this.post({ state: 'running', message: RECOVERY_MESSAGES.running, files: [], claim: null, canDismiss: false, canApply: false });
          return;
        }
        const view = this.session?.inspection.storage.target.identity === target.identity
          ? await this.session.presentation() : (await inspectRecovery(target)).view;
        this.post(view);
      });
    });
  }
  /** Bind a user-requested undo review to the completed change, never the first target. */
  async inspectBackup(target: RecoveryTarget, transactionId: string): Promise<boolean> {
    let available = false;
    await this.enqueue(async () => {
      const { inspectRecovery } = await import('./inspection.js');
      const inspection = await inspectRecovery(target, {}, transactionId);
      if (inspection.owner?.transactionId !== transactionId || inspection.view.state !== 'undo-available' || inspection.journal === undefined) {
        this.options.platform.showWarningMessage(RECOVERY_MESSAGES.undoUnavailable);
        return;
      }
      this.undo = { target, transactionId, operation: inspection.journal.data.operation };
      this.session = undefined;
      this.lock = undefined;
      this.post({ ...inspection.view, undoReview: true });
      available = true;
    });
    return available;
  }
  reportDiscoveryFailure(): void {
    this.discoveryFailed = true;
    this.post({ state: 'discovery-error', message: RECOVERY_MESSAGES.discoveryFailed, files: [], claim: null, canDismiss: false, canApply: false });
  }
  private postEntries(): void {
    if (this.targets.size === 0 && !this.entriesShown) return;
    this.entriesShown = this.targets.size > 0;
    this.options.post({ status: 'recovery-entries', entries: [...this.targets].map(([id, target]) => ({
      id, label: path.relative(target.workspaceRoot, target.root) || path.basename(target.root),
    })) });
  }
  async start(stopped: boolean, claim: string | null): Promise<void> {
    await this.perform(async (target) => {
      const holder = this.options.locks.holderOf(lockKey(target.root, true)) as OwnerHandle | RecoveryLock | undefined;
      if (holder?.state === 'mutating' || this.options.locks.taskState(lockKey(target.root, true)) !== 'idle') throw new RecoveryError(RECOVERY_MESSAGES.running);
      if (holder?.state === 'reserved') throw new RecoveryError(RECOVERY_MESSAGES.blocked);
      const { RecoverySession } = await import('./session.js');
      if (this.options.locks.admissionClosed) throw new RecoveryError(
        this.options.locks.restartRequired ? RECOVERY_MESSAGES.restartRequired : RECOVERY_MESSAGES.restart);
      const session = await RecoverySession.open(target, stopped, claim, {
        isInvalidated: () => this.options.locks.restartRequired,
      }, this.undo?.transactionId);
      if (this.options.locks.admissionClosed) throw new RecoveryError(
        this.options.locks.restartRequired ? RECOVERY_MESSAGES.restartRequired : RECOVERY_MESSAGES.restart);
      const token = session.token ?? `removal:${session.inspection.owner?.ownerToken ?? 'uninitialized'}`;
      if (holder !== undefined && holder.state !== 'released') {
        const lock = holder.transferToRecovery(token);
        if (lock === undefined) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
        this.lock = { handle: lock, token };
      }
      if (holder === undefined || holder.state === 'released') {
        const fence = new RecoveryLock(this.options.locks, lockKey(target.root, true), token);
        if (this.options.locks.tryAcquire(target.root, fence, true) === null) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
        this.lock = { handle: fence, token };
      }
      this.session = session;
      this.post(await session.presentation());
    });
  }
  async apply(choices: readonly RecoveryChoice[]): Promise<void> {
    await this.perform(async () => {
      if (this.session === undefined) throw new RecoveryError(RECOVERY_MESSAGES.stop);
      const session = this.session;
      const restoring = choices.some(choice => choice.action === 'restore');
      // Invalidate cleanup metrics before any restore write. Partial writes and
      // uncertain outcomes must never leave the original success on screen.
      if (restoring && session.inspection.journal !== undefined) this.options.backupChanged?.(session.inspection.storage.target, session.inspection.journal.owner.transactionId, 'changed', session.inspection.journal.data.cleanupAnalysisId);
      await session.apply(choices);
      const journal = session.inspection.journal;
      if (journal?.data.outcome === 'completed' && choices.some(choice => choice.action === 'restore')) {
        try {
          journal.data.recoveryReinstall = 'unknown';
          await journal.save();
          const result = await this.options.restored?.(journal) ?? 'skipped';
          journal.data.recoveryReinstall = result;
          if (result === 'unknown') throw new RecoveryOutcomeUnknownError(RECOVERY_MESSAGES.blocked);
          await journal.record('recovery-completion', 'finished');
        } catch (cause) {
          this.session = undefined;
          await session.invalidate(cause);
        }
      }
      if (journal?.data.outcome === 'completed' && choices.length === journal.data.files.length && choices.every(choice => choice.action === 'restore')) {
        this.options.backupChanged?.(journal.storage.target, journal.owner.transactionId, 'restored', journal.data.cleanupAnalysisId);
      }
      this.post(await session.presentation());
    });
  }
  async dismiss(stopped: boolean, discardIncomplete: boolean): Promise<void> {
    await this.perform(async (target) => {
      if (this.session === undefined) throw new RecoveryError(RECOVERY_MESSAGES.stop);
      const journal = this.session.inspection.journal;
      await this.session.dismiss(stopped, discardIncomplete);
      if (journal !== undefined) this.options.backupChanged?.(journal.storage.target, journal.owner.transactionId, 'resolved', journal.data.cleanupAnalysisId);
      if (this.lock !== undefined) await this.lock.handle.releaseRecovery(this.lock.token);
      this.lock = undefined; this.session = undefined;
      this.post({ state: 'none', message: RECOVERY_MESSAGES.backupDeleted, files: [], claim: null, canDismiss: false, canApply: false });
      this.targets.delete(hash(Buffer.from(target.root)));
      this.undo = undefined;
      this.selected = undefined;
      this.postEntries();
      await this.options.removed();
    });
  }
  private post(recovery: RecoveryPresentation): void {
    if (recovery.state === 'none' && !this.shown) return;
    this.shown = recovery.state !== 'none';
    this.options.post({ status: 'recovery', recovery: this.undo === undefined || recovery.state === 'none' ? recovery
      : { ...recovery, undoOperation: this.undo.operation } });
  }
  private perform(run: (target: RecoveryTarget) => Promise<void>): Promise<void> {
    const done = this.options.locks.trackPending();
    if (done === undefined) {
      this.reportAdmissionClosed();
      return Promise.resolve();
    }
    return this.enqueue(() => {
      if (this.options.locks.admissionClosed) {
        this.reportAdmissionClosed();
        return Promise.resolve();
      }
      return this.execute(async target => {
        if (this.options.locks.admissionClosed) {
          this.reportAdmissionClosed();
          return;
        }
        await run(target);
      });
    }).finally(done);
  }
  private reportAdmissionClosed(): void {
    const message = this.options.locks.restartRequired ? RECOVERY_MESSAGES.restartRequired : RECOVERY_MESSAGES.restart;
    this.options.platform.showWarningMessage(message);
    // Refusal must settle the webview's pending action without touching the
    // session or its lock. Do not read recovery files after host admission closes.
    this.post({ state: 'blocked', message, files: [], claim: null, canDismiss: false, canApply: false });
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.pending.then(run);
    this.pending = next.catch(() => {});
    return next;
  }
  private async target(): Promise<RecoveryTarget | undefined> {
    return this.undo?.target ?? (this.selected === undefined ? undefined : this.targets.get(this.selected)) ?? this.options.target();
  }
  private async invalidateActive(cause: unknown): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    try { await session.invalidate(cause); }
    catch (error) { if (!(error instanceof RecoveryOutcomeUnknownError)) throw error; }
  }
  private async execute(run: (target: RecoveryTarget) => Promise<void>): Promise<void> {
    try {
      const target = await this.target();
      if (target !== undefined) await run(target);
    } catch (error) {
      if (error instanceof RecoveryUndoUnavailableError && this.undo !== undefined) {
        const undo = this.undo;
        this.undo = undefined;
        this.session = undefined;
        this.options.backupChanged?.(undo.target, undo.transactionId, 'unavailable');
        this.options.platform.showWarningMessage(error.message);
        // No claim was acquired. Close the stale review without inspecting
        // the replacement through this undo point's identity or allowlist.
        this.post({ state: 'none', message: '', files: [], claim: null, canDismiss: false, canApply: false });
        return;
      }
      if (!(error instanceof RecoveryError) && !(error instanceof RestoreFileError) && this.session !== undefined) {
        await this.invalidateActive(error);
      }
      if (error instanceof RecoveryOutcomeUnknownError) this.session = undefined;
      const { inspectRecovery } = await import('./inspection.js');
      const message = error instanceof Error ? error.message : String(error);
      this.options.platform.showWarningMessage(message);
      const target = await this.target().catch(async (cause: unknown) => { await this.invalidateActive(cause); return undefined; });
      if (target !== undefined) {
        const latest = await (this.session !== undefined
          ? this.session.presentation().then(view => ({ view })) : inspectRecovery(target)).catch(async (cause: unknown) => { await this.invalidateActive(cause); return undefined; });
        this.post(latest?.view.state === 'incomplete' ? { ...latest.view, message: message.includes('Dependency file changed:') ? message : latest.view.message } : { ...(latest?.view ?? { state: 'invalid', files: [], claim: null, canDismiss: false, canApply: false }), message });
      }
    }
  }
}
