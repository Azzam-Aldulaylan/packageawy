import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DashboardPanel } from '../../out/host/dashboardPanel.js';
import { computeSourceFingerprint } from '../../out/core/cache/sourceFingerprint.js';

globalThis.__BUILD_TIME__ = 'test';
export const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
export async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
export const json = body => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: 0 });
export const row = { name: 'clean-pkg', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1',
  dev: false, range: '^1.0.0', advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null };
export const availability = { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] };
export const manifest = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } });
export const lockfile = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: {
  '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } },
  'node_modules/clean-pkg': { version: '1.0.0' },
} });
export const store = () => {
  const data = new Map();
  return { get: key => data.get(key), update: async (key, value) => { data.set(key, value); } };
};
export function network(gate = { promise: Promise.resolve() }) {
  const requests = [];
  return {
    requests,
    async get(url, options = {}) {
      requests.push({ kind: 'registry', signal: options.signal });
      await gate.promise;
      return json({ name: 'clean-pkg', version: '1.0.1' });
    },
    async post(url, body, options = {}) {
      requests.push({ kind: 'advisory', signal: options.signal, body });
      await gate.promise;
      return json({});
    },
    async run(options) {
      requests.push({ kind: 'audit', signal: options.signal });
      await gate.promise;
      return { stdout: JSON.stringify({ vulnerabilities: {} }), exitCode: 0 };
    },
  };
}
export function seed(controller, { age = 0, incomplete = false } = {}) {
  const source = controller.upgradeSource;
  controller.options.projectCacheStore.set(controller.options.cacheKey, {
    rows: [row], generatedAt: new Date(Date.now() - age).toISOString(), lockfilePath: source.lockfilePath,
    sourceFingerprint: computeSourceFingerprint(source),
    availability: incomplete ? { updates: 'partial', advisories: 'complete', unavailableUpdatePackages: ['clean-pkg'] } : availability,
  });
}

/** Real discovery, project load, controller and pipeline, with held async boundaries. */
export async function panel(t, { projects = ['a'], target = 'a', early = true, ttl = 30,
  gate = deferred(), discover = async () => {}, load = async () => {}, saved, invalid, workspace } = {}) {
  const root = workspace ?? await mkdtemp(path.join(tmpdir(), 'packageawy-startup-'));
  for (const name of projects) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'package.json'), invalid === name ? '{' : manifest);
    await writeFile(path.join(root, name, 'package-lock.json'), lockfile);
    await writeFile(path.join(root, name, '.npmrc'), 'registry=https://registry.npmjs.org/');
  }
  const folder = { id: `file://${root}`, name: 'workspace', path: root };
  const watchers = [];
  const picks = [], notices = [], searches = [];
  let dispose;
  const posted = [];
  const platform = {
    workspaceFolders: () => [folder], isWorkspaceTrusted: () => true,
    getSetting: (key, fallback) => key === 'cacheTtlMinutes' ? ttl : fallback,
    workspaceState: store(), globalState: store(),
    onDidChangeSetting: () => ({ dispose() {} }),
    async findFiles(search) {
      searches.push(search);
      if (search.include === '**/package.json') {
        await discover(search);
        return projects.map(name => path.join(root, name, 'package.json'));
      }
      if (search.include.includes('package-lock.json')) {
        await load(search);
        return projects.map(name => path.join(root, name, 'package-lock.json'));
      }
      return [];
    },
    watchFiles(base, glob, listener) {
      const watcher = { base, glob, listener, disposed: false, dispose() { this.disposed = true; } };
      watchers.push(watcher);
      return watcher;
    },
    watchGitHead: async () => undefined,
    showInformationMessage: text => notices.push(text),
    showQuickPick: async items => { picks.push(items); return items[0].value; },
    statFile: stat, readFile,
    withProgress: async (_title, run) => run({ report() {} }, { isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }) }),
  };
  DashboardPanel.create(platform, {
    postMessage: message => posted.push(message),
    onDidReceiveMessage() {}, onDidDispose: listener => { dispose = listener; }, reveal() {},
  }, { extensionVersion: 'test', integrationTestMode: true, speculativeStartup: early,
    ...(target == null ? {} : { initialManifestPath: path.join(root, target, 'package.json') }) });
  const current = DashboardPanel.current;
  const client = network(gate);
  current.httpClient.get = client.get;
  current.httpClient.post = client.post;
  current.auditRunner.run = client.run;
  const controllers = [];
  const build = current.buildController.bind(current);
  current.buildController = (...args) => {
    const controller = build(...args);
    controllers.push(controller);
    if (saved) seed(controller, saved);
    return controller;
  };
  let closed = false;
  const close = () => { if (!closed) { closed = true; dispose(); } };
  t.after(async () => { close(); gate.resolve(); await rm(root, { recursive: true, force: true }); });
  return { current, controllers, posted, client, gate, platform, root, watchers, picks, notices, searches, close,
    refresh: () => DashboardPanel.refresh(),
    ready: () => DashboardPanel.dispatchIntegrationTestMessage({ type: 'ready' }),
    open: name => DashboardPanel.openManifest(path.join(root, name, 'package.json')),
    snapshots: () => posted.filter(message => 'data' in message),
    async prepared() { await current.startup?.preparation; },
    async finished() { await current.startup?.preparation; await current.controller?.startupTask?.promise; },
  };
}
