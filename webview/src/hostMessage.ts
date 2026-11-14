import { HOST_MESSAGE_STATUSES, isHostToWebviewMessage } from '../../src/host/webviewProtocol.js';
import type { HostToWebviewMessage } from '../../src/host/webviewProtocol.js';
import { isRecord } from '../../src/core/validation.js';

export const UNHANDLED_HOST_MESSAGE_TEXT = 'Packageawy received something it did not understand';

/**
 * VS Code's outer webview forwards to its content iframe with postMessage,
 * so source is the outer frame, not this window. JCEF's injected receiver
 * dispatches a MessageEvent with default origin/source instead. These fields
 * are not a portable host identity check. Validate the payload at this boundary.
 */
export function readHostMessage(event: MessageEvent): HostToWebviewMessage | 'unhandled' | null {
  if (isHostToWebviewMessage(event.data)) return event.data;
  // A malformed known message is not evidence of a different protocol build.
  const value: unknown = event.data;
  if (!isRecord(value) || !Object.hasOwn(value, 'status') || typeof value['status'] !== 'string' ||
      value['status'].length > 128 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value['status']) ||
      Object.hasOwn(HOST_MESSAGE_STATUSES, value['status'])) return null;
  return 'unhandled';
}

/** The default arm must fail compilation when a protocol variant is added. */
export function unhandledHostMessage(_message: never, report: () => void): void {
  report();
}
