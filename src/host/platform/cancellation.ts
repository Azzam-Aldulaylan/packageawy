import type { CancellationToken, Disposable } from './hostPlatform.js';

/** Same contract as VS Code's CancellationTokenSource, without the dependency. */
export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  readonly token: CancellationToken;

  constructor() {
    const isCancelled = (): boolean => this.cancelled;
    this.token = {
      get isCancellationRequested() {
        return isCancelled();
      },
      onCancellationRequested: (listener: () => void): Disposable => {
        // Like VS Code, a token that is already cancelled calls back on the next tick.
        if (this.cancelled) {
          const handle = setTimeout(listener, 0);
          return { dispose: () => clearTimeout(handle) };
        }
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }

  dispose(): void {
    this.listeners.clear();
  }
}
