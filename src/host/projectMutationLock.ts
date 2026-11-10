import { realpathSync } from 'node:fs';
import path from 'node:path';

/** One spelling per directory, so a symlinked or differently cased path still finds the same lock. */
export function canonicalProjectRoot(root: string): string {
  const resolved = path.resolve(root);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // A missing directory keeps its resolved spelling.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * One dependency change per project root for the whole extension host, not
 * per panel. A transaction keeps running after its panel closes, and the
 * panel opened next gets a new coordinator, so a per-panel lock alone would
 * let a second install start in the same folder.
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
