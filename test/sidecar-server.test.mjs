/** The sidecar session in process: initialize, the trust gate, and reopening the view. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { encodeMessage, ErrorCodes, MessageDecoder } from '../out/host/platform/rpc/jsonRpc.js';

// esbuild defines this for the bundles. The tsc output needs it as a global.
globalThis.__BUILD_TIME__ = '2026-01-01T00:00:00.000Z';
const { startSidecar } = await import('../out/sidecar/server.js');

function session() {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new MessageDecoder();
  const received = [];
  const waiters = [];
  output.on('data', (chunk) => {
    for (const body of decoder.push(chunk)) received.push(JSON.parse(body));
    for (const waiter of waiters.splice(0)) waiter();
  });
  const connection = startSidecar({ input, output, serverVersion: '1.2.3' });
  let nextId = 1;
  const waitFor = async (predicate) => {
    for (;;) {
      const found = received.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  return {
    connection,
    received,
    waitFor,
    async request(method, params) {
      const id = nextId++;
      input.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
      return waitFor((message) => message.id === id && message.method === undefined);
    },
    notify(method, params) {
      input.write(encodeMessage({ jsonrpc: '2.0', method, params }));
    },
    close() {
      input.end();
    },
  };
}

const posted = (status) => (message) => message.method === 'webview/postMessage' && message.params.message.status === status;

test('initialize answers with server info and rejects a second initialize', async (t) => {
  const s = session();
  t.after(() => s.close());
  const first = await s.request('initialize', { workspaceFolders: [], isWorkspaceTrusted: false });
  assert.deepEqual(first.result, { serverInfo: { name: 'packageawy-sidecar', version: '1.2.3' } });
  const second = await s.request('initialize', { workspaceFolders: [], isWorkspaceTrusted: false });
  assert.equal(second.error.code, ErrorCodes.InvalidRequest);
});

test('initialize with bad params is an InvalidParams error', async (t) => {
  const s = session();
  t.after(() => s.close());
  const response = await s.request('initialize', { isWorkspaceTrusted: 'yes' });
  assert.equal(response.error.code, ErrorCodes.InvalidParams);
});

test('an untrusted workspace gets a fatal error instead of a dashboard', async (t) => {
  const s = session();
  t.after(() => s.close());
  await s.request('initialize', { workspaceFolders: [], isWorkspaceTrusted: false });
  s.notify('webview/didReceiveMessage', { message: { type: 'ready' } });
  const message = await s.waitFor(posted('fatal-error'));
  assert.equal(message.params.message.error.code, 'UNTRUSTED_WORKSPACE');
  assert.equal(s.received.some(posted('loading')), false);
});

test('a webview message after didDispose starts a fresh dashboard session', async (t) => {
  const s = session();
  t.after(() => s.close());
  await s.request('initialize', { workspaceFolders: [], isWorkspaceTrusted: true });
  s.notify('webview/didReceiveMessage', { message: { type: 'ready' } });
  await s.waitFor(posted('fatal-error'));
  const before = s.received.filter(posted('fatal-error')).length;

  s.notify('webview/didDispose', {});
  s.notify('webview/didReceiveMessage', { message: { type: 'ready' } });
  await s.waitFor((message) => posted('fatal-error')(message) && s.received.filter(posted('fatal-error')).length > before);
  // No folders: both sessions report that no project was found.
  const errors = s.received.filter(posted('fatal-error')).map((m) => m.params.message.error.code);
  assert.equal(errors.length, 2);
  assert.equal(errors[0], errors[1]);
});

test('a webview message sent before initialize is delivered after it', async (t) => {
  const s = session();
  t.after(() => s.close());
  s.notify('webview/didReceiveMessage', { message: { type: 'ready' } });
  const init = await s.request('initialize', { workspaceFolders: [], isWorkspaceTrusted: true });
  // No folders, so the dashboard reports that no project was found.
  const answer = await s.waitFor(posted('fatal-error'));
  assert.notEqual(answer.params.message.error.code, 'UNTRUSTED_WORKSPACE');
  assert.ok(s.received.indexOf(init) < s.received.indexOf(answer));
});

test('invalid webview messages are dropped', async (t) => {
  const s = session();
  t.after(() => s.close());
  await s.request('initialize', { workspaceFolders: [], isWorkspaceTrusted: true });
  s.notify('webview/didReceiveMessage', { message: { type: 'not-a-real-message' } });
  s.notify('webview/didReceiveMessage', {});
  const ping = await s.request('unknown/method', {});
  assert.equal(ping.error.code, ErrorCodes.MethodNotFound);
  assert.equal(s.received.some((message) => message.method === 'webview/postMessage'), false);
});

test('closing stdin closes the connection', async () => {
  const s = session();
  const closed = new Promise((resolve) => s.connection.onClose(resolve));
  s.close();
  await closed;
  assert.equal(s.connection.isClosed, true);
});
