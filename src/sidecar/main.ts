/**
 * Entry point of dist/sidecar.js: the Packageawy engine for editors other
 * than VS Code. Speaks JSON-RPC 2.0 on stdin and stdout. Logs go to stderr.
 */

import { DashboardPanel } from '../host/dashboardPanel.js';
import { Methods } from '../host/platform/rpc/protocol.js';
import { startSidecar } from './server.js';
import { createUnhandledRejectionHandler } from './unhandledRejection.js';

// stdout carries the protocol only, so console output must not reach it.
const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const connection = startSidecar({
  input: process.stdin,
  output: process.stdout,
  serverVersion: typeof __SIDECAR_VERSION__ === 'string' ? __SIDECAR_VERSION__ : 'dev',
  log: (message) => console.error(`[packageawy] ${message}`),
});

// A rejection nothing handled pauses changes instead of ending the process,
// so a change that is still installing can finish. See unhandledRejection.ts.
process.on('unhandledRejection', createUnhandledRejectionHandler({
  log: (line) => console.error(`[packageawy] ${line}`),
  reportToPanel: (reason) => DashboardPanel.reportRuntimeFailure('unhandled-rejection', reason),
  notify: (message) => connection.sendNotification(Methods.showMessage, { severity: 'error', message }),
}));

// The client owns this process. When it closes stdin, the session is over.
connection.onClose(() => {
  process.exit(0);
});
