/**
 * The sidecar session: one JSON-RPC connection, one RpcPlatform, and the
 * dashboard behind the client's webview. Composes DashboardPanel the way
 * platform/vscode/dashboardWebview.ts does for VS Code.
 */

import type { Readable, Writable } from 'node:stream';

import { DashboardPanel } from '../host/dashboardPanel.js';
import type { HostToWebviewMessage } from '../host/webviewProtocol.js';
import { JsonRpcConnection, ErrorCodes, ResponseError } from '../host/platform/rpc/jsonRpc.js';
import type { InitializeResult } from '../host/platform/rpc/protocol.js';
import { Methods } from '../host/platform/rpc/protocol.js';
import { RpcPlatform } from '../host/platform/rpc/rpcPlatform.js';
import { RpcWebviewChannel } from '../host/platform/rpc/rpcWebviewChannel.js';
import { parseInitialize, parseWebviewMessage } from '../host/platform/rpc/validation.js';

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

  const openDashboard = (current: RpcPlatform): RpcWebviewChannel => {
    const next = new RpcWebviewChannel(connection);
    DashboardPanel.create(current, next, {
      extensionVersion: clientVersion,
      integrationTestMode: false,
    });
    return next;
  };

  connection.onRequest(Methods.initialize, (params): InitializeResult => {
    if (platform !== undefined) throw new ResponseError(ErrorCodes.InvalidRequest, 'Already initialized');
    const init = parseInitialize(params);
    platform = new RpcPlatform(connection, init, log);
    clientVersion = init.clientVersion ?? options.serverVersion;
    if (platform.isWorkspaceTrusted()) channel = openDashboard(platform);
    return { serverInfo: { name: SERVER_NAME, version: options.serverVersion } };
  });

  connection.onNotification(Methods.webviewDidReceiveMessage, (params) => {
    if (platform === undefined) return;
    const { message } = parseWebviewMessage(params);
    if (!platform.isWorkspaceTrusted()) {
      // Same rule as VS Code, which never activates in an untrusted workspace.
      connection.sendNotification(Methods.webviewPostMessage, { message: UNTRUSTED_MESSAGE });
      return;
    }
    // A message after the view closed means the client opened a new one.
    if (channel === undefined || channel.isDisposed) channel = openDashboard(platform);
    channel.receive(message);
  });

  connection.onNotification(Methods.webviewDidDispose, () => {
    channel?.dispose();
    channel = undefined;
  });

  connection.onClose(() => {
    channel?.dispose();
    channel = undefined;
  });

  connection.listen();
  return connection;
}
