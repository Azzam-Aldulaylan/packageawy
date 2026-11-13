/**
 * Entry point of dist/sidecar.js: the Packageawy engine for editors other
 * than VS Code. Speaks JSON-RPC 2.0 on stdin and stdout. Logs go to stderr.
 */

import { DashboardPanel } from '../host/dashboardPanel.js';
import { Methods } from '../host/platform/rpc/protocol.js';
import { startSidecar } from './server.js';
import { createUnhandledRejectionHandler } from './unhandledRejection.js';
import { unsupportedNodeMessage } from './nodeVersion.js';

// stdout carries the protocol only, so console output must not reach it.
const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const unsupported = unsupportedNodeMessage(process.versions.node);
if (unsupported !== null) {
  // Before anything runs that the old runtime may not support. The client
  // sees the process end and the message on stderr.
  console.error(`[packageawy] ${unsupported}`);
  process.exit(1);
}

const connection = startSidecar({
  input: process.stdin,
  output: process.stdout,
  serverVersion: typeof __SIDECAR_VERSION__ === 'string' ? __SIDECAR_VERSION__ : 'dev',
  log: (message) => console.error(`[packageawy] ${message}`),
});

// Both last resort handlers settle prepared writers before notifying the client.
for (const [event, context] of [['unhandledRejection', 'unhandled-rejection'], ['uncaughtException', 'uncaught-exception']] as const) {
  process.on(event, createUnhandledRejectionHandler({
    log: (line) => console.error(`[packageawy] ${line}`),
    reportToPanel: (reason) => DashboardPanel.reportRuntimeFailure(context, reason),
    notify: (message) => connection.sendNotification(Methods.showMessage, { severity: 'error', message }),
  }, context));
}

// The client owns this process. When it closes stdin, the session is over.
connection.onClose(() => {
  process.exit(0);
});
