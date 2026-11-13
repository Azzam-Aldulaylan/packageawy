import { lockKey } from './pathIdentity.js';
import { RECOVERY_MESSAGES } from './recoveryCopy.js';
import { RecoveryLock } from './recoveryLock.js';
import type { RecoveryJournal } from './recovery/journal.js';
import { RecoveryError, type RecoveryTarget } from './recovery/model.js';
import type { ProjectMutationLocks } from './projectMutationLock.js';
import type { TransactionCompletion } from './upgradeTransaction.js';

/** Settlement reported by the transaction. Unknown outcomes retain ownership. */
export type CompletionResult = TransactionCompletion;

export type OwnerHandleState = 'reserved' | 'mutating' | 'released' | 'completed' | 'unknown' | 'retained' | 'transferred';

export interface ReservationRefusal {
  readonly ok: false;
  /**
   * `held`: this panel already has a review or change in progress.
   * `project-locked`: another panel in this process holds the project.
   */
  readonly reason: 'held' | 'project-locked';
}

/**
 * The only way to end a reservation. Each handle is single-use: once it is
 * settled, every further call is a logged no-op, so a late or duplicated
 * call from a finished flow can never end another owner's reservation.
 */
export interface OwnerHandle {
  readonly ok: true;
  readonly label: string;
  readonly state: OwnerHandleState;
  /** Released, completed or unknown. Nothing on this handle can change the reservation any more. */
  readonly settled: boolean;
  /** The known end passed to `complete`, once it was called. */
  readonly result: CompletionResult | undefined;
  /** A durable prepared journal is the authority to change project files. */
  readonly journal: RecoveryJournal | undefined;
  readonly refusal: string | undefined;
  /** Files may change only after this returns true. */
  beginMutation(target: RecoveryTarget): Promise<boolean>;
  transferToRecovery(claimToken: string): RecoveryLock | undefined;
  /** Ends a reservation that never began a mutation. Refused once a mutation began. */
  releaseReadOnly(): Promise<boolean>;
  /** A known end, whether or not a mutation began. Releases the reservation. */
  complete(result: CompletionResult): Promise<boolean>;
  /**
   * The outcome is not known. The handle settles, but the reservation and the
   * project lock stay held, and nothing else in this process can release them.
   */
  markUnknown(reason: string): boolean;
}

export interface OperationReservationOptions {
  /** The process-wide project locks. A handle is stored there under its target's lock key. */
  locks: ProjectMutationLocks;
  /** The panel's own single slot, taken and freed together with the handle. */
  reserve(label: string): boolean;
  release(label: string): void;
  flushDeferredChanges(): Promise<void>;
  resumePendingBackground(): void;
  isDisposed(): boolean;
  dispose(): void;
  log?(line: string): void;
}

class Handle implements OwnerHandle {
  readonly ok = true;
  state: OwnerHandleState = 'reserved';
  result: CompletionResult | undefined;
  journal: RecoveryJournal | undefined;
  refusal: string | undefined;
  /** The key the project lock registry stored this handle under, or undefined for a project without a resolved target. */
  lockKey: string | undefined;

  constructor(
    readonly owner: OperationReservation,
    readonly label: string,
    private readonly settle: (handle: Handle, state: 'released' | 'completed') => Promise<boolean>,
    private readonly log: (line: string) => void
  ) {}

  get settled(): boolean {
    return ['released', 'completed', 'unknown', 'retained', 'transferred'].includes(this.state);
  }

  async beginMutation(target: RecoveryTarget): Promise<boolean> {
    if (this.state !== 'reserved') return this.ignored('beginMutation');
    const key = lockKey(target.root);
    if (this.lockKey === undefined) {
      const acquired = this.owner.locks.tryAcquire(target.root, this);
      if (acquired === null) { this.refusal = RECOVERY_MESSAGES.blocked; return false; }
      this.lockKey = acquired;
    }
    if (this.lockKey !== key) { this.refusal = RECOVERY_MESSAGES.unsafe; return false; }
    // Hold admission across the asynchronous bootstrap, including a panel close.
    this.state = 'mutating';
    try {
      // Ordinary activation and scans never need journal filesystem machinery.
      const { prepareJournal } = await import('./recovery/journal.js');
      this.journal = await prepareJournal(target);
      return true;
    } catch (error) {
      this.refusal = error instanceof RecoveryError ? error.message : RECOVERY_MESSAGES.blocked;
      this.state = 'reserved';
      return false;
    }
  }

  transferToRecovery(claimToken: string): RecoveryLock | undefined {
    if ((this.state !== 'unknown' && this.state !== 'retained') || this.lockKey === undefined) {
      this.ignored('transferToRecovery');
      return undefined;
    }
    const lock = new RecoveryLock(this.owner.locks, this.lockKey, claimToken, async () => { await this.settle(this, 'completed'); });
    if (!this.owner.locks.transfer(this.lockKey, this, lock)) return undefined;
    this.state = 'transferred';
    return lock;
  }

  async releaseReadOnly(): Promise<boolean> {
    if (this.state !== 'reserved') return this.ignored('releaseReadOnly');
    return this.settle(this, 'released');
  }

  async complete(result: CompletionResult): Promise<boolean> {
    if (this.settled) return this.ignored('complete');
    if (result === 'unknown') { this.markUnknown('The task result was not observed.'); return false; }
    this.result = result;
    if (this.journal !== undefined) {
      try {
        if (!await this.journal.finish(result, this.journal.data.operation === 'cleanup' && result === 'kept')) {
          this.state = 'retained';
          return false;
        }
      } catch (error) {
        this.markUnknown(error instanceof Error ? error.message : String(error));
        return false;
      }
    }
    return this.settle(this, 'completed');
  }

  markUnknown(reason: string): boolean {
    if (this.settled) return this.ignored('markUnknown');
    this.state = 'unknown';
    this.log(`Dependency change for ${this.label} has an unknown outcome and stays locked: ${reason}`);
    return true;
  }

  private ignored(method: string): false {
    this.log(`Ignored ${method} on the ${this.state} reservation for ${this.label}.`);
    return false;
  }
}

/**
 * The panel's one dependency-operation reservation. `reserve` hands out an
 * owner handle, and only that handle can end it. A read-only review and the
 * short mutation boundary that actually owns dependency files are separate
 * states of the same handle.
 */
export class OperationReservation {
  private current: Handle | undefined;

  constructor(private readonly options: OperationReservationOptions) {}

  get locks(): ProjectMutationLocks { return this.options.locks; }

  /**
   * Takes the panel slot and, when the project has a resolved target, the
   * process-wide lock under that target's key. Both or neither.
   */
  reserve(label: string, targetKey: string | undefined): OwnerHandle | ReservationRefusal {
    if (this.current !== undefined) return { ok: false, reason: 'held' };
    const handle = new Handle(this, label, (owned, state) => this.end(owned, state), (line) => this.log(line));
    if (targetKey !== undefined) {
      // The registry canonicalizes what it is given. The handle keeps the key
      // the registry actually stored, so its release always finds the entry.
      const stored = this.options.locks.tryAcquire(targetKey, handle);
      if (stored === null) return { ok: false, reason: 'project-locked' };
      handle.lockKey = stored;
    }
    if (!this.options.reserve(label)) {
      if (handle.lockKey !== undefined) this.options.locks.release(handle.lockKey, handle);
      return { ok: false, reason: 'held' };
    }
    this.current = handle;
    return handle;
  }

  /**
   * The live handle, for the panel's own abandonment paths (webview reload,
   * panel close). They can only call `releaseReadOnly` on it, which refuses
   * once a mutation began or the outcome is unknown.
   */
  get held(): OwnerHandle | undefined {
    return this.current;
  }

  /** Mutating, or settled as unknown: dependency files may be changing or in doubt. */
  get isMutationBusy(): boolean {
    return this.current !== undefined && ['mutating', 'unknown', 'retained', 'transferred'].includes(this.current.state);
  }

  /** Whether a lock holder found in the shared registry is one of this panel's handles. */
  issued(holder: object): boolean {
    return holder instanceof Handle && holder.owner === this;
  }

  disposeIfIdle(): void {
    if (this.current === undefined) this.options.dispose();
  }

  /** Release synchronously, then drain once, then resume background work. */
  private async end(handle: Handle, state: 'released' | 'completed'): Promise<boolean> {
    handle.state = state;
    if (this.current === handle) this.current = undefined;
    this.options.release(handle.label);
    if (handle.lockKey !== undefined) this.options.locks.release(handle.lockKey, handle);
    try {
      await this.options.flushDeferredChanges();
    } catch {
      // A failed reload must not poison later reservation releases.
    }
    try {
      this.options.resumePendingBackground();
    } catch {
      // Background refresh is best-effort lifecycle follow-up.
    }
    if (this.options.isDisposed()) this.options.dispose();
    return true;
  }

  private log(line: string): void {
    try {
      this.options.log?.(line);
    } catch {
      // Logging is diagnostic only and must never change the reservation.
    }
  }
}

/** Monotonic execution gate advanced at the synchronous watcher boundary. */
export class SourceGenerationGuard {
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  advance(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(captured: number): boolean {
    return captured === this.generation;
  }

  /** Commits an analysis result only while its captured source is current. */
  commitIfCurrent(captured: number, commit: () => void): boolean {
    if (!this.isCurrent(captured)) return false;
    commit();
    return true;
  }
}
