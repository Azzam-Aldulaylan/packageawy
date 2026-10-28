// Stub sidecar for tests and for running the plugin before dist/sidecar.js exists.
// It speaks the protocol in src/host/platform/hostPlatform.ts and does no real work.
'use strict';

const path = require('node:path');

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
let folders = [];
let onExit = () => {};

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method, params) {
  send({ method, params });
}

function postToWebview(message) {
  notify('webview/postMessage', { message });
}

function showDashboardPlaceholder() {
  postToWebview({
    status: 'fatal-error',
    error: { code: 'STUB_SIDECAR', message: 'This build bundles the stub sidecar. Build dist/sidecar.js to load real data.' },
  });
}

// Calls every client handler once and reports the results through window/showMessage.
async function selfTest(folder) {
  const results = [];
  const found = await request('files/find', { folder, dir: '', include: '**/package.json', exclude: '**/node_modules/**' });
  results.push(`find:${found.length}`);
  await request('storage/update', { scope: 'workspace', key: 'stub.workspace', value: { ok: true } });
  await request('storage/update', { scope: 'global', key: 'stub.global', value: 1 });
  results.push('storage');
  await request('files/watch', { watchId: 1, baseDir: folder.path, glob: '**/package.json' });
  notify('files/unwatch', { watchId: 1 });
  const head = await request('git/watchHead', { watchId: 2, projectPath: folder.path });
  notify('git/unwatchHead', { watchId: 2 });
  results.push(`head:${head}`);
  notify('progress/start', { progressId: 1, title: 'Stub progress', cancellable: true });
  notify('progress/report', { progressId: 1, message: 'halfway', increment: 50 });
  notify('progress/end', { progressId: 1 });
  const modal = await request('window/showModal', { message: 'Stub modal', detail: 'detail', actions: ['Yes', 'No'] });
  results.push(`modal:${modal}`);
  const pick = await request('window/showQuickPick', {
    items: [{ label: 'a' }, { label: 'b', description: 'second' }],
    options: { title: 'Pick', placeholder: '', matchOnDescription: true, matchOnDetail: false },
  });
  results.push(`pick:${pick}`);
  const exited = new Promise((resolve) => (onExit = resolve));
  await request('process/start', {
    processId: 1, executable: process.execPath, args: ['-e', 'process.exit(3)'],
    cwd: folder.path, title: 'Stub process', scope: 'stub',
  });
  results.push(`exit:${await exited}`);
  notify('window/openFile', { path: path.join(folder.path, 'package.json'), position: { line: 1, column: 1 } });
  notify('window/openExternal', { url: 'https://example.com' });
  notify('window/openSettings', { key: 'upgrade.ignoreScripts' });
  notify('webview/reveal', {});
  notify('window/showMessage', { severity: 'info', message: `self-test ${results.join(' ')}` });
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (!entry) return;
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  switch (message.method) {
    case 'initialize':
      folders = message.params.workspaceFolders;
      send({ id: message.id, result: {} });
      if (process.env.PACKAGEAWY_STUB_SELF_TEST === '1' && folders.length > 0) {
        selfTest(folders[0]).catch((error) => notify('window/showMessage', { severity: 'error', message: String(error) }));
      }
      return;
    case 'webview/didReceiveMessage':
      if (message.params.message && message.params.message.type === 'ready') showDashboardPlaceholder();
      if (message.params.message && message.params.message.type === 'refresh') showDashboardPlaceholder();
      return;
    case 'process/didExit':
      onExit(message.params.exitCode);
      return;
    case 'webview/didDispose':
      process.exit(0);
      return;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `Unhandled ${message.method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const match = /Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
