import { lockKey } from './pathIdentity.js';

/**
 * One spelling per directory, so a symlinked or differently cased path still
 * finds the same lock. Case is always folded, which can only make two
 * windows wait on each other.
 */
export function canonicalProjectRoot(root: string): string {
  return lockKey(root);
}

/**
 * One dependency change per project root for the whole extension host, not
 * per panel. A transaction keeps running after its panel closes, and the
 * panel opened next gets a new coordinator, so a per-panel lock alone would
 * let a second install start in the same folder. The holder stored under a
 * key is the reservation's owner handle, so only that handle can free it.
 */
export class ProjectMutationLocks {
  private readonly holders = new Map<string, object>();
  private readonly releaseListeners = new Set<(key: string, owner: object) => void>();

  /** The canonical key on success, or null while a different owner holds this root. */
  tryAcquire(root: string, owner: object): string | null {
    const key = canonicalProjectRoot(root);
    const holder = this.holders.get(key);
    if (holder !== undefined && holder !== owner) return null;
    this.holders.set(key, owner);
    return key;
  }

  /** Only the owner can release, so a stale release never frees someone else's change. */
  release(key: string, owner: object): void {
    if (this.holders.get(key) !== owner) return;
    this.holders.delete(key);
    for (const listener of [...this.releaseListeners]) {
      try {
        listener(key, owner);
      } catch {
        // One listener must not keep the others from hearing about the release.
      }
    }
  }

  /** Transfer is synchronous, so admission never opens between owners. */
  transfer(key: string, previous: object, next: object): boolean {
    if (this.holders.get(key) !== previous) return false;
    this.holders.set(key, next);
    return true;
  }

  holderOf(key: string): object | undefined {
    return this.holders.get(key);
  }

  isHeldByOther(key: string, owner: object): boolean {
    const holder = this.holders.get(key);
    return holder !== undefined && holder !== owner;
  }

  onDidRelease(listener: (key: string, owner: object) => void): () => void {
    this.releaseListeners.add(listener);
    return () => {
      this.releaseListeners.delete(listener);
    };
  }
}

/** Shared by every dashboard panel and coordinator in this extension host or sidecar process. */
export const projectMutationLocks = new ProjectMutationLocks();
