/** WebviewChannel for one dashboard session. The sidecar routes the client's webview notifications here. */

import type { Disposable, WebviewChannel } from '../hostPlatform.js';
import type { RpcConnection } from './rpcPlatform.js';
import { Methods } from './protocol.js';

export class RpcWebviewChannel implements WebviewChannel {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly connection: Pick<RpcConnection, 'sendNotification'>) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  postMessage(message: unknown): void {
    if (this.disposed) return;
    this.connection.sendNotification(Methods.webviewPostMessage, { message });
  }

  onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
    this.messageListeners.add(listener);
    return { dispose: () => this.messageListeners.delete(listener) };
  }

  onDidDispose(listener: () => void): Disposable {
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  reveal(): void {
    if (this.disposed) return;
    this.connection.sendNotification(Methods.webviewReveal, {});
  }

  /** Delivers a message the client forwarded from the webview. */
  receive(message: unknown): void {
    if (this.disposed) return;
    for (const listener of [...this.messageListeners]) listener(message);
  }

  /** The view closed. Fires the dispose listeners once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const listeners = [...this.disposeListeners];
    this.messageListeners.clear();
    this.disposeListeners.clear();
    for (const listener of listeners) listener();
  }
}
