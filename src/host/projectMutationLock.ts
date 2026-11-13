import type { DependencyTaskState } from './webviewProtocol.js';
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
  private restartSession: string | undefined;
  private retiredRestartSessions: Set<string> | undefined;
  private pending = 0;

  get admissionClosed(): boolean { return this.restartSession !== undefined; }

  prepareRestart(sessionId: string): boolean {
    if (this.retiredRestartSessions?.has(sessionId)) return false;
    if (this.restartSession !== undefined && this.restartSession !== sessionId) return false;
    this.restartSession = sessionId;
    return true;
  }

  matchesRestart(sessionId: string): boolean { return this.restartSession === sessionId; }

  cancelRestart(sessionId: string): void {
    if (!this.matchesRestart(sessionId)) return;
    this.retireRestart(sessionId);
    this.restartSession = undefined;
  }

  commitRestart(sessionId: string): void {
    if (this.matchesRestart(sessionId)) this.retireRestart(sessionId);
  }

  private retireRestart(sessionId: string): void {
    // Keep recent completed handshakes from reopening admission on replay.
    // Allocate only on restart and cap history for a long-lived sidecar.
    const retired = this.retiredRestartSessions ??= new Set<string>();
    retired.add(sessionId);
    if (retired.size > 256) retired.delete(retired.values().next().value!);
  }

  restartState(): 'idle' | 'busy' | 'unknown' {
    for (const holder of this.holders.values()) {
      const state = (holder as { state?: string }).state;
      if (state === 'unknown' || state === 'retained' || state === 'transferred' || state === 'recovery') return 'unknown';
    }
    return this.holders.size > 0 || this.pending > 0 ? 'busy' : 'idle';
  }

  /** Count work before its first await, so restart cannot miss an acquisition in flight. */
  trackPending(): (() => void) | undefined {
    if (this.admissionClosed) return undefined;
    this.pending++;
    let ended = false;
    return () => { if (!ended) { ended = true; this.pending--; } };
  }

  private tasks: Map<string, DependencyTaskState> | undefined;
  private taskListeners: Set<(key: string, owner: object, state: DependencyTaskState) => void> | undefined;

  taskState(key: string): DependencyTaskState { return this.tasks?.get(key) ?? 'idle'; }

  reportTaskState(key: string, owner: object, state: DependencyTaskState): void {
    if (this.holders.get(key) !== owner) return;
    if (state === 'idle') this.tasks?.delete(key);
    else (this.tasks ??= new Map()).set(key, state);
    for (const listener of this.taskListeners === undefined ? [] : [...this.taskListeners]) {
      try { listener(key, owner, state); } catch { /* Presentation must not interrupt settlement. */ }
    }
  }

  onDidChangeTask(listener: (key: string, owner: object, state: DependencyTaskState) => void): () => void {
    (this.taskListeners ??= new Set()).add(listener);
    return () => { this.taskListeners?.delete(listener); };
  }

  private readonly holders = new Map<string, object>();
  private readonly releaseListeners = new Set<(key: string, owner: object) => void>();

  /** The canonical key on success, or null while a different owner holds this root. */
  tryAcquire(root: string, owner: object): string | null {
    if (this.admissionClosed) return null;
    const key = canonicalProjectRoot(root);
    const holder = this.holders.get(key);
    if (holder !== undefined && holder !== owner) return null;
    this.holders.set(key, owner);
    return key;
  }

  /** Only the owner can release, so a stale release never frees someone else's change. */
  release(key: string, owner: object): void {
    if (this.holders.get(key) !== owner) return;
    this.reportTaskState(key, owner, 'idle');
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
