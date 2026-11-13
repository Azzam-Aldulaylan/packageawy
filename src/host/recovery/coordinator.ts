import path from 'node:path';
import { hash } from './model.js';
import { RecoveryLock } from '../recoveryLock.js';
import type { HostPlatform } from '../platform/hostPlatform.js';
import type { OwnerHandle } from '../operationReservation.js';
import type { ProjectMutationLocks } from '../projectMutationLock.js';
import { lockKey } from '../pathIdentity.js';
import type { HostToWebviewMessage, RecoveryChoice, RecoveryPresentation } from '../webviewProtocol.js';
import { RECOVERY_MESSAGES, RecoveryError, type RecoveryTarget } from './model.js';
import type { RecoverySession } from './session.js';

export class RecoveryCoordinator {
  private session: RecoverySession | undefined;
  private lock: { handle: RecoveryLock; token: string } | undefined;
  private pending = Promise.resolve();
  private shown = false;
  private readonly targets = new Map<string, RecoveryTarget>();
  private selected: string | undefined;
  private entriesShown = false;
  private discoveryFailed = false;
  constructor(private readonly options: {
    platform: HostPlatform;
    locks: ProjectMutationLocks;
    target(): Promise<RecoveryTarget | undefined>;
    post(message: HostToWebviewMessage): void;
    removed(): Promise<void>;
  }) {}

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
      for (const target of discovered) this.targets.set(hash(Buffer.from(target.root)), target);
      this.postEntries();
      if (id !== undefined && !this.targets.has(id)) return;
      const previous = this.selected;
      if (id !== undefined) this.selected = id;
      if (this.selected !== undefined && !this.targets.has(this.selected)) this.selected = undefined;
      if (this.selected === undefined) this.selected = this.targets.keys().next().value;
      if (previous !== this.selected) { this.session = undefined; this.lock = undefined; }
      await this.execute(async (target) => {
        const holder = this.options.locks.holderOf(lockKey(target.root)) as OwnerHandle | RecoveryLock | undefined;
        if (holder?.state === 'mutating') {
          this.options.post({ status: 'dependency-task', state: this.options.locks.taskState(lockKey(target.root)) });
          this.post({ state: 'running', message: RECOVERY_MESSAGES.running, files: [], claim: null, canDismiss: false, canApply: false });
          return;
        }
        const view = this.session?.inspection.storage.target.identity === target.identity
          ? await this.session.presentation() : (await inspectRecovery(target)).view;
        this.post(view);
      });
    });
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
      const holder = this.options.locks.holderOf(lockKey(target.root)) as OwnerHandle | RecoveryLock | undefined;
      if (holder?.state === 'mutating') throw new RecoveryError(RECOVERY_MESSAGES.running);
      if (holder?.state === 'reserved') await holder.releaseReadOnly();
      const { RecoverySession } = await import('./session.js');
      if (this.options.locks.admissionClosed) throw new RecoveryError(RECOVERY_MESSAGES.restart);
      const session = await RecoverySession.open(target, stopped, claim);
      const token = session.token ?? `removal:${session.inspection.owner?.ownerToken ?? 'uninitialized'}`;
      if (holder !== undefined && holder.state !== 'released') {
        const lock = holder.transferToRecovery(token);
        if (lock === undefined) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
        this.lock = { handle: lock, token };
      }
      if (holder === undefined || holder.state === 'released') {
        const fence = new RecoveryLock(this.options.locks, lockKey(target.root), token);
        if (this.options.locks.tryAcquire(target.root, fence) === null) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
        this.lock = { handle: fence, token };
      }
      this.session = session;
      this.post(await session.presentation());
    });
  }
  async apply(choices: readonly RecoveryChoice[]): Promise<void> {
    await this.perform(async () => {
      if (this.session === undefined) throw new RecoveryError(RECOVERY_MESSAGES.stop);
      await this.session.apply(choices);
      this.post(await this.session.presentation());
    });
  }
  async dismiss(stopped: boolean, discardIncomplete: boolean): Promise<void> {
    await this.perform(async () => {
      if (this.session === undefined) throw new RecoveryError(RECOVERY_MESSAGES.stop);
      await this.session.dismiss(stopped, discardIncomplete);
      if (this.lock !== undefined) await this.lock.handle.releaseRecovery(this.lock.token);
      this.lock = undefined; this.session = undefined;
      this.post({ state: 'none', message: '', files: [], claim: null, canDismiss: false, canApply: false });
      if (this.selected !== undefined) this.targets.delete(this.selected);
      this.selected = undefined;
      this.postEntries();
      await this.options.removed();
    });
  }
  private post(recovery: RecoveryPresentation): void {
    if (recovery.state === 'none' && !this.shown) return;
    this.shown = recovery.state !== 'none';
    this.options.post({ status: 'recovery', recovery });
  }
  private perform(run: (target: RecoveryTarget) => Promise<void>): Promise<void> {
    const done = this.options.locks.trackPending();
    if (done === undefined) {
      this.options.platform.showWarningMessage(RECOVERY_MESSAGES.restart);
      return Promise.resolve();
    }
    return this.enqueue(() => this.execute(run)).finally(done);
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.pending.then(run);
    this.pending = next.catch(() => {});
    return next;
  }
  private async target(): Promise<RecoveryTarget | undefined> {
    return (this.selected === undefined ? undefined : this.targets.get(this.selected)) ?? this.options.target();
  }
  private async execute(run: (target: RecoveryTarget) => Promise<void>): Promise<void> {
    try {
      const target = await this.target();
      if (target !== undefined) await run(target);
    } catch (error) {
      const { inspectRecovery } = await import('./inspection.js');
      const message = error instanceof Error ? error.message : String(error);
      this.options.platform.showWarningMessage(message);
      const target = await this.target().catch(() => undefined);
      if (target !== undefined) {
        const latest = await inspectRecovery(target).catch(() => undefined);
        this.post(latest?.view.state === 'incomplete' ? latest.view : { ...(latest?.view ?? { state: 'invalid', files: [], claim: null, canDismiss: false, canApply: false }), message });
      }
    }
  }
}
