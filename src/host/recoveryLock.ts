import type { ProjectMutationLocks } from './projectMutationLock.js';

/** A claimed recovery owns admission until the saved folder is gone. */
export class RecoveryLock {
  readonly state = 'recovery';
  constructor(
    private readonly locks: ProjectMutationLocks,
    private readonly key: string,
    private token: string,
    private readonly removed: () => Promise<void> = async () => {}
  ) {}
  transferToRecovery(token: string): RecoveryLock | undefined {
    if (this.locks.admissionClosed) return undefined;
    this.token = token;
    return this;
  }
  async releaseRecovery(token: string): Promise<boolean> {
    if (token !== this.token || this.locks.holderOf(this.key) !== this) return false;
    this.locks.release(this.key, this);
    await this.removed();
    return true;
  }
}
