/**
 * Spawns dist/sidecar.js and plays the editor client: initialize with the
 * sidecar fixture project, answer files/find from the real folder, send the
 * webview's ready message, and wait for dashboard data.
 *
 * Offline: a preload sends every HTTPS request to a closed local port, and
 * HOME and npm's config do the same for the registry, so network calls fail
 * fast and the dashboard reports partial data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodeMessage, MessageDecoder } from '../out/host/platform/rpc/jsonRpc.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(repositoryRoot, 'dist', 'sidecar.js');
const FIXTURE = path.join(repositoryRoot, 'test', 'fixtures', 'sidecar-project');
const OFFLINE_REGISTRY = 'https://127.0.0.1:9/';
// Advisories always use the public registry, whatever .npmrc says.
const REFUSE_HTTPS = `data:text/javascript,${encodeURIComponent(
  "import https from 'node:https';" +
    'const request = https.request;' +
    "https.request = (options, callback) => request({ ...options, host: '127.0.0.1', port: 9 }, callback);"
)}`;
const DATA_STATUSES = new Set(['ready', 'partial-error', 'stale', 'empty']);

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** files/find with the same meaning as VS Code's findFiles. */
async function findFiles({ folder, dir, include, exclude, maxResults }) {
  const base = path.join(folder.path, dir);
  const toPosix = (p) => p.split(path.sep).join('/');
  const matches = (await walk(base)).filter((file) => {
    const underBase = toPosix(path.relative(base, file));
    const underFolder = toPosix(path.relative(folder.path, file));
    return path.posix.matchesGlob(underBase, include) && !(exclude && path.posix.matchesGlob(underFolder, exclude));
  });
  return maxResults === undefined ? matches : matches.slice(0, maxResults);
}

function startClient(home) {
  const child = spawn(process.execPath, ['--import', REFUSE_HTTPS, SIDECAR], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      npm_config_userconfig: path.join(home, '.npmrc'),
      npm_config_registry: OFFLINE_REGISTRY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = new MessageDecoder();
  const pending = new Map();
  const waiters = [];
  const notifications = [];
  const requests = [];
  let stderr = '';
  let nextId = 1;
  let closed = false;

  // Once the client closes, late answers to sidecar requests are dropped.
  const send = (message) => {
    if (closed || child.stdin.writableEnded || child.stdin.destroyed) return;
    child.stdin.write(encodeMessage(message));
  };
  const respond = async (message) => {
    requests.push(message);
    let result = null;
    if (message.method === 'files/find') result = await findFiles(message.params);
    if (message.method === 'git/watchHead') result = false;
    send({ jsonrpc: '2.0', id: message.id, result });
  };

  // The child may exit while a write is in flight. That is EPIPE, not a failure.
  child.stdin.on('error', () => {
    closed = true;
  });
  child.on('exit', () => {
    closed = true;
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    for (const body of decoder.push(chunk)) {
      const message = JSON.parse(body);
      if (message.method !== undefined && message.id !== undefined) {
        void respond(message);
      } else if (message.method !== undefined) {
        notifications.push(message);
        for (const waiter of [...waiters]) waiter();
      } else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });

  return {
    child,
    notifications,
    requests,
    get stderr() {
      return stderr;
    },
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    close() {
      closed = true;
      child.stdin.end();
    },
    waitFor(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = notifications.find(predicate);
          if (found === undefined) return;
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`Timed out. Notifications: ${notifications.map((n) => n.method).join(', ')}\n${stderr}`));
        }, timeoutMs);
        waiters.push(check);
        check();
      });
    },
  };
}

test('dist/sidecar.js serves the dashboard to a JSON-RPC client', async (t) => {
  assert.ok(existsSync(SIDECAR), 'dist/sidecar.js is missing. npm test builds it in pretest.');
  const home = await mkdtemp(path.join(tmpdir(), 'packageawy-sidecar-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, '.npmrc'), `registry=${OFFLINE_REGISTRY}\n`);
  const client = startClient(home);
  const exited = new Promise((resolve) => client.child.on('exit', resolve));
  t.after(() => client.child.kill());

  const folder = { id: pathToFileURL(FIXTURE).href, name: 'sidecar-project', path: FIXTURE };
  const init = await client.request('initialize', {
    workspaceFolders: [folder],
    isWorkspaceTrusted: true,
    settings: {},
    workspaceState: {},
    globalState: {},
    clientVersion: 'test',
  });
  assert.equal(init.result.serverInfo.name, 'packageawy-sidecar');

  client.notify('webview/didReceiveMessage', { message: { type: 'ready' } });
  const posted = await client.waitFor(
    (n) => n.method === 'webview/postMessage' && DATA_STATUSES.has(n.params.message.status),
    30_000
  );

  const data = posted.params.message.data;
  assert.equal(data.project.manifestPath, 'package.json');
  assert.equal(data.extensionVersion, 'test');
  assert.deepEqual(data.rows.map((row) => row.name).sort(), ['is-number', 'left-pad']);
  // Proves the run stayed offline.
  assert.equal(data.advisoriesError?.code, 'NETWORK');
  const finds = client.requests.filter((r) => r.method === 'files/find');
  assert.ok(finds.some((r) => r.params.include === '**/package.json'));
  assert.ok(finds.every((r) => r.params.folder.path === FIXTURE));

  client.notify('webview/didDispose', {});
  client.close();
  assert.equal(await exited, 0);
});

test('likely-unused findings come back after a package.json change event', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'packageawy-sidecar-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, '.npmrc'), `registry=${OFFLINE_REGISTRY}\n`);
  const project = path.join(home, 'project');
  await cp(FIXTURE, project, { recursive: true });
  const client = startClient(home);
  t.after(() => client.child.kill());

  const folder = { id: pathToFileURL(project).href, name: 'project', path: project };
  await client.request('initialize', {
    workspaceFolders: [folder],
    isWorkspaceTrusted: true,
    settings: {},
    workspaceState: {},
    globalState: {},
  });
  client.notify('webview/didReceiveMessage', { message: { type: 'ready' } });

  const cleanupResults = () =>
    client.notifications.filter((n) => n.method === 'webview/postMessage' && n.params.message.status === 'cleanup-result');
  const hasFindings = (n) =>
    n.method === 'webview/postMessage' && n.params.message.status === 'cleanup-result' && n.params.message.findings.length > 0;
  await client.waitFor(hasFindings, 30_000);
  const before = cleanupResults().length;

  // The change an editor reports after a package manager rewrote the manifest.
  const manifestPath = path.join(project, 'package.json');
  await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replace('"1.0.0"', '"1.0.1"'));
  const watch = client.requests.find((r) => r.method === 'files/watch' && r.params.glob === 'package.json');
  assert.ok(watch, 'package.json is watched');
  client.notify('files/didChange', { watchId: watch.params.watchId, path: manifestPath });

  await client.waitFor((n) => cleanupResults().indexOf(n) >= before && hasFindings(n), 30_000);
  client.close();
});
