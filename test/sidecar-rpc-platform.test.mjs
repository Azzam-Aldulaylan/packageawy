/** RpcPlatform and RpcWebviewChannel against a fake in-memory client. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { CancellationTokenSource } from '../out/host/platform/cancellation.js';
import { ErrorCodes, ResponseError } from '../out/host/platform/rpc/jsonRpc.js';
import { RpcPlatform } from '../out/host/platform/rpc/rpcPlatform.js';
import { RpcWebviewChannel } from '../out/host/platform/rpc/rpcWebviewChannel.js';
import { parseInitialize } from '../out/host/platform/rpc/validation.js';

const FOLDER = { id: 'file:///work/app', name: 'app', path: '/work/app' };

/** Records what the platform sends and answers requests from `handlers`. */
function fakeClient(handlers = {}) {
  const requests = [];
  const notifications = [];
  const listeners = new Map();
  return {
    requests,
    notifications,
    sendRequest(method, params, token) {
      requests.push({ method, params, token });
      const handler = handlers[method];
      if (handler === undefined) return Promise.resolve(null);
      return Promise.resolve().then(() => handler(params, token));
    },
    sendNotification(method, params) {
      notifications.push({ method, params });
    },
    onNotification(method, handler) {
      listeners.set(method, handler);
    },
    /** A notification from the client. */
    emit(method, params) {
      listeners.get(method)?.(params);
    },
  };
}

function init(overrides = {}) {
  return {
    workspaceFolders: [FOLDER],
    isWorkspaceTrusted: true,
    settings: { 'upgrade.ignoreScripts': false, 'cacheTtlMinutes': 5, 'nulled': null },
    workspaceState: { cached: { a: 1 } },
    globalState: {},
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('synchronous state answers from the initialize snapshot and follows change notifications', () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  assert.deepEqual(platform.workspaceFolders(), [FOLDER]);
  assert.equal(platform.isWorkspaceTrusted(), true);
  assert.equal(platform.getSetting('upgrade.ignoreScripts', true), false);
  assert.equal(platform.getSetting('cacheTtlMinutes', 30), 5);
  assert.equal(platform.getSetting('missing', 'fallback'), 'fallback');
  assert.equal(platform.getSetting('nulled', 'fallback'), 'fallback');

  const other = { id: 'file:///work/lib', name: 'lib', path: '/work/lib' };
  client.emit('workspace/didChangeFolders', { workspaceFolders: [FOLDER, other] });
  client.emit('workspace/didChangeTrust', { isWorkspaceTrusted: false });
  client.emit('settings/didChange', { settings: { cacheTtlMinutes: 0 } });
  assert.deepEqual(platform.workspaceFolders(), [FOLDER, other]);
  assert.equal(platform.isWorkspaceTrusted(), false);
  assert.equal(platform.getSetting('cacheTtlMinutes', 30), 0);
  assert.equal(platform.getSetting('upgrade.ignoreScripts', true), true);
});

test('invalid change notifications throw and leave state unchanged', () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  assert.throws(() => client.emit('workspace/didChangeTrust', { isWorkspaceTrusted: 'yes' }), /isWorkspaceTrusted must be a boolean/);
  assert.throws(() => client.emit('workspace/didChangeFolders', { workspaceFolders: [{ id: 1 }] }), /folder id/);
  assert.equal(platform.isWorkspaceTrusted(), true);
  assert.deepEqual(platform.workspaceFolders(), [FOLDER]);
});

test('storage reads the snapshot and writes through with storage/update', async () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  assert.deepEqual(platform.workspaceState.get('cached'), { a: 1 });
  assert.equal(platform.globalState.get('cached'), undefined);

  await platform.globalState.update('etags', { x: 'y' });
  await platform.workspaceState.update('cached', undefined);
  assert.deepEqual(platform.globalState.get('etags'), { x: 'y' });
  assert.equal(platform.workspaceState.get('cached'), undefined);
  assert.deepEqual(
    client.requests.map((r) => [r.method, r.params]),
    [
      ['storage/update', { scope: 'global', key: 'etags', value: { x: 'y' } }],
      ['storage/update', { scope: 'workspace', key: 'cached' }],
    ]
  );
});

test('findFiles sends files/find, caps results and passes the token', async () => {
  const client = fakeClient({ 'files/find': () => ['/work/app/a.ts', '/work/app/b.ts', '/work/app/c.ts'] });
  const platform = new RpcPlatform(client, init());
  const source = new CancellationTokenSource();
  const files = await platform.findFiles(
    { folder: FOLDER, dir: 'src', include: '**/*.ts', exclude: '**/node_modules/**', maxResults: 2 },
    source.token
  );
  assert.deepEqual(files, ['/work/app/a.ts', '/work/app/b.ts']);
  const [request] = client.requests;
  assert.equal(request.method, 'files/find');
  assert.deepEqual(request.params, { folder: FOLDER, dir: 'src', include: '**/*.ts', exclude: '**/node_modules/**', maxResults: 2 });
  assert.equal(request.token, source.token);
});

test('findFiles resolves empty when cancelled and rejects a malformed result', async () => {
  const cancelled = fakeClient({
    'files/find': () => {
      throw new ResponseError(ErrorCodes.RequestCancelled, 'cancelled');
    },
  });
  const search = { folder: FOLDER, dir: '', include: '**/package.json', exclude: '' };
  assert.deepEqual(await new RpcPlatform(cancelled, init()).findFiles(search), []);

  const source = new CancellationTokenSource();
  source.cancel();
  const untouched = fakeClient();
  assert.deepEqual(await new RpcPlatform(untouched, init()).findFiles(search, source.token), []);
  assert.equal(untouched.requests.length, 0);

  const broken = fakeClient({ 'files/find': () => [1, 2] });
  await assert.rejects(new RpcPlatform(broken, init()).findFiles(search), /invalid result/);
});

test('watchFiles routes files/didChange by watch id and unwatches once', () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  const seenA = [];
  const seenB = [];
  const a = platform.watchFiles('/work/app', 'package.json', (p) => seenA.push(p));
  platform.watchFiles('/work/app', '.npmrc', (p) => seenB.push(p));
  const [watchA, watchB] = client.requests.map((r) => r.params);
  assert.deepEqual(client.requests.map((r) => r.method), ['files/watch', 'files/watch']);
  assert.equal(watchA.baseDir, '/work/app');
  assert.equal(watchA.glob, 'package.json');
  assert.notEqual(watchA.watchId, watchB.watchId);

  client.emit('files/didChange', { watchId: watchA.watchId, path: '/work/app/package.json' });
  client.emit('files/didChange', { watchId: watchB.watchId, path: '/work/app/.npmrc' });
  a.dispose();
  a.dispose();
  client.emit('files/didChange', { watchId: watchA.watchId, path: '/work/app/package.json' });
  assert.deepEqual(seenA, ['/work/app/package.json']);
  assert.deepEqual(seenB, ['/work/app/.npmrc']);
  assert.deepEqual(client.notifications, [{ method: 'files/unwatch', params: { watchId: watchA.watchId } }]);
});

test('watchGitHead returns a disposable only when the client can observe HEAD', async () => {
  const answers = [true, false];
  const client = fakeClient({ 'git/watchHead': () => answers.shift() });
  const platform = new RpcPlatform(client, init());
  let changes = 0;
  const watch = await platform.watchGitHead('/work/app', () => {
    changes += 1;
  });
  assert.notEqual(watch, undefined);
  const { watchId, projectPath } = client.requests[0].params;
  assert.equal(projectPath, '/work/app');
  client.emit('git/didChangeHead', { watchId });
  watch.dispose();
  client.emit('git/didChangeHead', { watchId });
  assert.equal(changes, 1);
  assert.deepEqual(client.notifications, [{ method: 'git/unwatchHead', params: { watchId } }]);

  assert.equal(await platform.watchGitHead('/elsewhere', () => undefined), undefined);
  const failing = fakeClient({
    'git/watchHead': () => {
      throw new Error('no git');
    },
  });
  assert.equal(await new RpcPlatform(failing, init()).watchGitHead('/work/app', () => undefined), undefined);
});

test('withProgress sends start, report and end, and progress/cancel cancels the token', async () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  const result = await platform.withProgress('Upgrading', async (progress, token) => {
    progress.report({ message: 'step 1', increment: 10 });
    progress.report({});
    const { progressId } = client.notifications[0].params;
    client.emit('progress/cancel', { progressId });
    return token.isCancellationRequested;
  });
  assert.equal(result, true);
  const id = client.notifications[0].params.progressId;
  assert.deepEqual(client.notifications, [
    { method: 'progress/start', params: { progressId: id, title: 'Upgrading', cancellable: true } },
    { method: 'progress/report', params: { progressId: id, message: 'step 1', increment: 10 } },
    { method: 'progress/report', params: { progressId: id } },
    { method: 'progress/end', params: { progressId: id } },
  ]);
});

test('withProgress sends progress/end when the task throws', async () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  await assert.rejects(platform.withProgress('Failing', async () => Promise.reject(new Error('nope'))), /nope/);
  assert.deepEqual(client.notifications.map((n) => n.method), ['progress/start', 'progress/end']);
});

test('messages are window/showMessage notifications with a severity', () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  platform.showInformationMessage('info');
  platform.showWarningMessage('warn');
  platform.showErrorMessage('err');
  assert.deepEqual(client.notifications, [
    { method: 'window/showMessage', params: { severity: 'info', message: 'info' } },
    { method: 'window/showMessage', params: { severity: 'warning', message: 'warn' } },
    { method: 'window/showMessage', params: { severity: 'error', message: 'err' } },
  ]);
});

test('showModalWarning returns only an offered action', async () => {
  const answers = ['Upgrade', null, 'Something else'];
  const client = fakeClient({ 'window/showModal': () => answers.shift() });
  const platform = new RpcPlatform(client, init());
  assert.equal(await platform.showModalWarning('Upgrade?', 'details', ['Upgrade', 'Skip']), 'Upgrade');
  assert.equal(await platform.showModalWarning('Upgrade?', 'details', ['Upgrade']), undefined);
  assert.equal(await platform.showModalWarning('Upgrade?', 'details', ['Upgrade']), undefined);
  assert.deepEqual(client.requests[0].params, { message: 'Upgrade?', detail: 'details', actions: ['Upgrade', 'Skip'] });
});

test('showQuickPick sends labels only and maps the index back to the value', async () => {
  const answers = [1, null, 7, 0.5];
  const client = fakeClient({ 'window/showQuickPick': () => answers.shift() });
  const platform = new RpcPlatform(client, init());
  const items = [
    { label: 'app', description: 'root', value: { secret: 'a' } },
    { label: 'lib', detail: 'packages/lib', value: { secret: 'b' } },
  ];
  const options = { title: 'Pick', placeholder: 'Project', matchOnDescription: true, matchOnDetail: false };
  assert.deepEqual(await platform.showQuickPick(items, options), { secret: 'b' });
  assert.deepEqual(client.requests[0].params, {
    items: [
      { label: 'app', description: 'root' },
      { label: 'lib', detail: 'packages/lib' },
    ],
    options: { title: 'Pick', placeholder: 'Project', matchOnDescription: true, matchOnDetail: false },
  });
  assert.equal(await platform.showQuickPick(items, options), undefined);
  assert.equal(await platform.showQuickPick(items, options), undefined);
  assert.equal(await platform.showQuickPick(items, options), undefined);
});

test('showQuickPick resolves undefined when cancelled', async () => {
  const client = fakeClient({
    'window/showQuickPick': () => {
      throw new ResponseError(ErrorCodes.RequestCancelled, 'cancelled');
    },
  });
  const platform = new RpcPlatform(client, init());
  const source = new CancellationTokenSource();
  const items = [{ label: 'a', value: 1 }];
  const options = { title: '', placeholder: '', matchOnDescription: false, matchOnDetail: false };
  assert.equal(await platform.showQuickPick(items, options, source.token), undefined);
  assert.equal(client.requests[0].token, source.token);
  source.cancel();
  assert.equal(await platform.showQuickPick(items, options, source.token), undefined);
  assert.equal(client.requests.length, 1);
});

test('runProcess starts the process and reports process/didExit once', async () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  const running = await platform.runProcess({
    executable: 'npm',
    args: ['install', 'left-pad@1.3.0'],
    cwd: '/work/app',
    title: 'Upgrade left-pad',
    scope: 'left-pad',
  });
  const { processId, ...rest } = client.requests[0].params;
  assert.equal(client.requests[0].method, 'process/start');
  assert.deepEqual(rest, { executable: 'npm', args: ['install', 'left-pad@1.3.0'], cwd: '/work/app', title: 'Upgrade left-pad', scope: 'left-pad' });

  const codes = [];
  running.onDidExit((code) => codes.push(code));
  client.emit('process/didExit', { processId, exitCode: 0 });
  client.emit('process/didExit', { processId, exitCode: 1 });
  assert.deepEqual(codes, [0]);

  // A late subscriber still hears the exit.
  const late = await new Promise((resolve) => running.onDidExit(resolve));
  assert.equal(late, 0);
});

test('runProcess keeps an exit that arrives before the start response, and maps null to undefined', async () => {
  let client;
  client = fakeClient({
    'process/start': (params) => {
      client.emit('process/didExit', { processId: params.processId, exitCode: null });
      return null;
    },
  });
  const platform = new RpcPlatform(client, init());
  const running = await platform.runProcess({ executable: 'pnpm', args: [], cwd: '/w', title: 't', scope: 's' });
  const code = await new Promise((resolve) => running.onDidExit(resolve));
  assert.equal(code, undefined);
});

test('runProcess rejects when the client cannot start the process', async () => {
  const client = fakeClient({
    'process/start': () => {
      throw new ResponseError(ErrorCodes.InternalError, 'npm not found');
    },
  });
  const platform = new RpcPlatform(client, init());
  await assert.rejects(platform.runProcess({ executable: 'npm', args: [], cwd: '/w', title: 't', scope: 's' }), /npm not found/);
});

test('openFile, openExternal and openSettings are notifications', () => {
  const client = fakeClient();
  const platform = new RpcPlatform(client, init());
  platform.openFile('/work/app/src/a.ts', { line: 3, column: 7 });
  platform.openFile('/work/app/package.json');
  platform.openExternal('https://github.com/advisories/GHSA-x');
  platform.openSettings('upgrade.ignoreScripts');
  assert.deepEqual(client.notifications, [
    { method: 'window/openFile', params: { path: '/work/app/src/a.ts', position: { line: 3, column: 7 } } },
    { method: 'window/openFile', params: { path: '/work/app/package.json' } },
    { method: 'window/openExternal', params: { url: 'https://github.com/advisories/GHSA-x' } },
    { method: 'window/openSettings', params: { key: 'upgrade.ignoreScripts' } },
  ]);
});

test('statFile and readFile use the local file system', async () => {
  const platform = new RpcPlatform(fakeClient(), init());
  const manifest = fileURLToPath(new URL('./fixtures/sidecar-project/package.json', import.meta.url));
  const bytes = await platform.readFile(manifest);
  assert.equal(JSON.parse(Buffer.from(bytes).toString('utf8')).name, 'sidecar-fixture');
  assert.equal((await platform.statFile(manifest)).size, bytes.length);
});

test('parseInitialize fills optional snapshots and rejects bad shapes', () => {
  assert.deepEqual(parseInitialize({ workspaceFolders: [], isWorkspaceTrusted: false }), {
    workspaceFolders: [],
    isWorkspaceTrusted: false,
    settings: {},
    workspaceState: {},
    globalState: {},
  });
  assert.throws(() => parseInitialize(null), (error) => error.code === ErrorCodes.InvalidParams);
  assert.throws(() => parseInitialize({ workspaceFolders: {}, isWorkspaceTrusted: true }), /workspaceFolders must be an array/);
  assert.throws(() => parseInitialize({ workspaceFolders: [], isWorkspaceTrusted: true, settings: [] }), /settings must be an object/);
});

test('RpcWebviewChannel posts, reveals, delivers messages and disposes once', async () => {
  const client = fakeClient();
  const channel = new RpcWebviewChannel(client);
  const received = [];
  let disposed = 0;
  const subscription = channel.onDidReceiveMessage((message) => received.push(message));
  channel.onDidDispose(() => {
    disposed += 1;
  });

  channel.postMessage({ status: 'loading' });
  channel.reveal();
  channel.receive({ type: 'ready' });
  subscription.dispose();
  channel.receive({ type: 'refresh' });
  channel.dispose();
  channel.dispose();
  channel.postMessage({ status: 'late' });
  channel.reveal();
  await tick();

  assert.deepEqual(received, [{ type: 'ready' }]);
  assert.equal(disposed, 1);
  assert.equal(channel.isDisposed, true);
  assert.deepEqual(client.notifications, [
    { method: 'webview/postMessage', params: { message: { status: 'loading' } } },
    { method: 'webview/reveal', params: {} },
  ]);
});
