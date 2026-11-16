/**
 * The sidecar session: one JSON-RPC connection, one RpcPlatform, and the
 * dashboard behind the client's webview. Composes DashboardPanel the way
 * platform/vscode/dashboardWebview.ts does for VS Code.
 */

import type { Readable, Writable } from 'node:stream';

import { projectMutationLocks } from '../host/projectMutationLock.js';
import { DashboardPanel } from '../host/dashboardPanel.js';
import type { HostToWebviewMessage } from '../host/webviewProtocol.js';
import { JsonRpcConnection, ErrorCodes, ResponseError } from '../host/platform/rpc/jsonRpc.js';
import type { InitializeResult } from '../host/platform/rpc/protocol.js';
import { Methods } from '../host/platform/rpc/protocol.js';
import { RpcPlatform } from '../host/platform/rpc/rpcPlatform.js';
import { RpcWebviewChannel } from '../host/platform/rpc/rpcWebviewChannel.js';
import { parseInitialize, parseOpenManifest, parseWebviewMessage, parseRestart } from '../host/platform/rpc/validation.js';

export const SERVER_NAME = 'packageawy-sidecar';

export interface SidecarOptions {
  input: Readable;
  output: Writable;
  serverVersion: string;
  log?: (message: string) => void;
}

const UNTRUSTED_MESSAGE: HostToWebviewMessage = {
  status: 'fatal-error',
  error: {
    code: 'UNTRUSTED_WORKSPACE',
    message: 'Packageawy reads .npmrc and can run package managers, so it only runs in a trusted project.',
  },
};

export function startSidecar(options: SidecarOptions): JsonRpcConnection {
  const log = options.log ?? (() => undefined);
  const connection = new JsonRpcConnection(options.input, options.output, log);
  let platform: RpcPlatform | undefined;
  let clientVersion = 'unknown';
  let channel: RpcWebviewChannel | undefined;
  /** Webview messages that arrived before initialize, delivered once it completes. */
  let early: unknown[] = [];

  const openDashboard = (current: RpcPlatform): RpcWebviewChannel => {
    const next = new RpcWebviewChannel(connection);
    DashboardPanel.create(current, next, {
      extensionVersion: clientVersion,
      integrationTestMode: false,
    });
    return next;
  };

  const deliver = (current: RpcPlatform, message: unknown): void => {
    if (!current.isWorkspaceTrusted()) {
      // Same rule as VS Code, which never activates in an untrusted workspace.
      connection.sendNotification(Methods.webviewPostMessage, { message: UNTRUSTED_MESSAGE });
      return;
    }
    // A message after the view closed means the client opened a new one.
    if (channel === undefined || channel.isDisposed) channel = openDashboard(current);
    channel.receive(message);
  };

  // Admission closes synchronously before discovery can yield to a new change.
  const restartStatus = async (sessionId: string): Promise<import('../host/platform/rpc/protocol.js').RestartResult | null> => {
    if (!projectMutationLocks.matchesRestart(sessionId)) return null;
    let state = projectMutationLocks.restartState();
    if (state === 'idle') {
      try {
        if (platform === undefined) state = 'unknown';
        else {
          const { findRecoveryTargets } = await import('../host/recovery/targetDiscovery.js');
          if ((await findRecoveryTargets(platform)).length > 0) state = 'unknown';
        }
      } catch { state = 'unknown'; }
    }
    if (!projectMutationLocks.matchesRestart(sessionId)) return null;
    const current = projectMutationLocks.restartState();
    return { sessionId, state: current === 'idle' ? state : current };
  };
  connection.onRequest(Methods.restartPrepare, (params) => {
    const { sessionId } = parseRestart(params);
    if (!projectMutationLocks.prepareRestart(sessionId)) return null;
    return restartStatus(sessionId);
  });
  connection.onRequest(Methods.restartCommit, async (params) => {
    const { sessionId } = parseRestart(params);
    const result = await restartStatus(sessionId);
    if (result?.state === 'idle') projectMutationLocks.commitRestart(sessionId);
    return result;
  });
  connection.onNotification(Methods.restartCancel, (params) => projectMutationLocks.cancelRestart(parseRestart(params).sessionId));

  connection.onRequest(Methods.initialize, (params): InitializeResult => {
    if (platform !== undefined) throw new ResponseError(ErrorCodes.InvalidRequest, 'Already initialized');
    const init = parseInitialize(params);
    const current = new RpcPlatform(connection, init, log);
    platform = current;
    clientVersion = init.clientVersion ?? options.serverVersion;
    if (current.isWorkspaceTrusted()) channel = openDashboard(current);
    const pending = early;
    early = [];
    // After the response is written, so the client sees initialize complete first.
    setImmediate(() => {
      for (const message of pending) deliver(current, message);
    });
    return { serverInfo: { name: SERVER_NAME, version: options.serverVersion } };
  });

  connection.onNotification(Methods.webviewDidReceiveMessage, (params) => {
    const { message } = parseWebviewMessage(params);
    if (platform === undefined) early.push(message);
    else deliver(platform, message);
  });

  connection.onNotification(Methods.openManifest, (params) => {
    const { path } = parseOpenManifest(params);
    // Before initialize there is no workspace to look in. The client sends
    // this after initialize completes.
    if (platform === undefined || !platform.isWorkspaceTrusted()) return;
    if (channel === undefined || channel.isDisposed) channel = openDashboard(platform);
    DashboardPanel.openManifest(path);
  });

  connection.onNotification(Methods.webviewDidDispose, () => {
    channel?.dispose();
    channel = undefined;
  });

  connection.onClose(() => {
    platform?.dispose();
    channel?.dispose();
    channel = undefined;
  });

  connection.listen();
  return connection;
}
