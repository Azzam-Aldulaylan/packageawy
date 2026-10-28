/**
 * Entry point of dist/sidecar.js: the Packageawy engine for editors other
 * than VS Code. Speaks JSON-RPC 2.0 on stdin and stdout. Logs go to stderr.
 */

import { startSidecar } from './server.js';

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

// The client owns this process. When it closes stdin, the session is over.
connection.onClose(() => {
  process.exit(0);
});
