/** The internal error banner, its safe log line, Show Log, and the sidecar's last-resort rejection handler. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RUNTIME_ERROR_CODE,
  RUNTIME_ERROR_TEXT,
  RUNTIME_ERROR_WITHOUT_PANEL_TEXT,
  SIDECAR_SHOW_LOG_TEXT,
  editorActionFailureText,
  runtimeFailureLine,
} from '../out/core/diagnostics.js';
import { RpcPlatform } from '../out/host/platform/rpc/rpcPlatform.js';
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../out/host/webviewProtocol.js';
import { RECOVERY_MESSAGES } from '../out/host/recoveryCopy.js';
import { createUnhandledRejectionHandler } from '../out/sidecar/unhandledRejection.js';

test('the log line names the place and the built-in error kind, never the message', () => {
  const line = runtimeFailureLine('webview-message', new TypeError('cannot read /Users/me/.npmrc token=abc'));
  assert.equal(line, 'runtime: webview-message failed (TypeError)');
  const custom = new Error('https://user:pass@registry.example/pkg');
  custom.name = 'https://registry.example';
  assert.equal(runtimeFailureLine('background-refresh', custom), 'runtime: background-refresh failed (other error)');
  assert.equal(runtimeFailureLine('notification', 'a string with /a/path'), 'runtime: notification failed (non-error value)');
  assert.equal(runtimeFailureLine('not-a-context', undefined), 'runtime: unknown failed (no error value)');
});

test('the banner text is the agreed sentence and contains no dashes', () => {
  assert.equal(
    RUNTIME_ERROR_TEXT,
    'Packageawy hit an internal error. Changes are paused until you close and reopen the Packageawy panel. The Packageawy log has the details.'
  );
  for (const text of [RUNTIME_ERROR_TEXT, RUNTIME_ERROR_WITHOUT_PANEL_TEXT, SIDECAR_SHOW_LOG_TEXT,
    editorActionFailureText('open-file'), editorActionFailureText('open-link'), editorActionFailureText('open-settings')]) {
    assert.doesNotMatch(text, /[–—]/);
  }
});

test('runtime-error is accepted only with its fixed code and text', () => {
  const valid = { status: 'runtime-error', code: RUNTIME_ERROR_CODE, message: RUNTIME_ERROR_TEXT };
  assert.equal(isHostToWebviewMessage(valid), true);
  assert.equal(isHostToWebviewMessage({ ...valid, message: 'Error: /Users/me/secret' }), false);
  assert.equal(isHostToWebviewMessage({ ...valid, code: 'TypeError' }), false);
  assert.equal(isHostToWebviewMessage({ ...valid, stack: 'at x' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'runtime-error' }), false);
});

test('show-log is a payload-free webview message', () => {
  assert.equal(isWebviewToHostMessage({ type: 'show-log' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'show-log', path: '/tmp/log' }), false);
});

test('the sidecar Show Log tells the IDE where its log is through window/showMessage', () => {
  const notifications = [];
  const client = {
    sendRequest: () => Promise.resolve(null),
    sendNotification: (method, params) => notifications.push({ method, params }),
    onNotification() {},
  };
  const platform = new RpcPlatform(client, {
    workspaceFolders: [], isWorkspaceTrusted: true, settings: {}, workspaceState: {}, globalState: {},
  });
  platform.showLog();
  assert.deepEqual(notifications, [{ method: 'window/showMessage', params: { severity: 'info', message: SIDECAR_SHOW_LOG_TEXT } }]);
});

function handlerFixture({ panelOpen = true, failures = {} } = {}) {
  const calls = { log: [], panel: [], notify: [] };
  const handler = createUnhandledRejectionHandler({
    log: (line) => {
      if (failures.log) throw new Error('log failed');
      calls.log.push(line);
    },
    reportToPanel: (reason) => {
      if (failures.panel) throw new Error('panel failed');
      calls.panel.push(reason);
      return panelOpen;
    },
    notify: (message) => {
      if (failures.notify) throw new Error('client gone');
      calls.notify.push(message);
    },
  });
  return { handler, calls };
}

test('the rejection handler pauses the panel every time and notifies once', async () => {
  const { handler, calls } = handlerFixture();
  const exit = process.exit;
  let exited = false;
  process.exit = () => {
    exited = true;
  };
  try {
    handler(new Error('first /secret'));
    handler(new Error('second'));
  } finally {
    process.exit = exit;
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exited, false, 'the handler never exits');
  assert.equal(calls.panel.length, 2, 'each rejection reaches the panel, which keeps one failed state');
  assert.deepEqual(calls.notify, [RECOVERY_MESSAGES.restartRequired]);
  assert.deepEqual(calls.log, [], 'the panel writes the log line itself');
});

test('with no panel open the handler logs a safe line and requires restart', async () => {
  const { handler, calls } = handlerFixture({ panelOpen: false });
  handler(new RangeError('/Users/me/project'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.log, ['runtime: unhandled-rejection failed (RangeError)']);
  assert.deepEqual(calls.notify, [RECOVERY_MESSAGES.restartRequired]);
});

test('a failing step does not skip the others or throw', async () => {
  const { handler, calls } = handlerFixture({ failures: { panel: true } });
  assert.doesNotThrow(() => handler(new Error('x')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.log.length, 1, 'logged because the panel could not take it');
  assert.equal(calls.notify.length, 1);
  const quiet = handlerFixture({ panelOpen: false, failures: { log: true, notify: true } });
  assert.doesNotThrow(() => quiet.handler(new Error('y')));
});
