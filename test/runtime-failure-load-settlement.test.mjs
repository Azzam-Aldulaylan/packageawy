/** A failed ready or refresh ends its loading or refreshing state, and never drops rows already on screen. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { DashboardController } from '../out/host/dashboardController.js';
import { DashboardPanel } from '../out/host/dashboardPanel.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

const REGISTRY = 'https://registry.npmjs.org';

function panelFixture(t) {
  globalThis.__BUILD_TIME__ = 'test';
  const store = { get: () => undefined, update: async () => {} };
  const posted = [];
  let dispose;
  const panel = new DashboardPanel({
    getSetting: (_key, fallback) => fallback, globalState: store, workspaceState: store, log() {},
    onDidChangeSetting: () => ({ dispose() {} }),
  }, {
    postMessage: (message) => {
      assert.ok(isHostToWebviewMessage(message), JSON.stringify(message));
      posted.push(message);
    },
    onDidReceiveMessage() {},
    onDidDispose: (listener) => { dispose = listener; },
  }, { extensionVersion: 'test', integrationTestMode: false });
  t.after(() => dispose());
  return { panel, posted, statuses: () => posted.map((message) => message.status) };
}

function realController() {
  const data = new Map();
  const json = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: 2 });
  return new DashboardController({
    root: '/tmp/project',
    manifestText: JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0' } }),
    lockfileText: JSON.stringify({
      name: 'app', lockfileVersion: 3,
      packages: { '': { name: 'app', dependencies: { 'clean-pkg': '^1.0.0' } }, 'node_modules/clean-pkg': { version: '1.0.0' } },
    }),
    lockfilePath: '/tmp/project/package-lock.json',
    registry: REGISTRY,
    httpClient: {
      async get(url) {
        return url === `${REGISTRY}/clean-pkg/latest` ? json({ version: '1.0.0' }) : { status: 404, headers: {}, body: '', wireBytes: 0 };
      },
      async post() { return json({}); },
    },
    etagStore: new MemoryEtagStore(),
    projectInfo: { id: 'id:app', label: 'app', manifestPath: 'package.json' },
    canChangeProject: false,
    buildInfo: { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' },
    projectCacheStore: new PersistentProjectCacheStore({ get: (key) => data.get(key), async update(key, value) { data.set(key, value); } }),
    cacheKey: 'project-a',
    ttlMinutesProvider: () => 30,
  });
}

test('a failed first ready ends in the fatal error with Retry, delivered despite failed readiness', async (t) => {
  const { panel, posted, statuses } = panelFixture(t);
  panel.handleReadyMessage = async () => { throw new TypeError('lookup broke'); };
  await panel.handle({ type: 'ready' });
  assert.deepEqual(statuses(), ['runtime-error', 'fatal-error']);
  assert.equal(posted[1].error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(posted[1].error.message, /lookup/);
});

test('a failed refresh after loading replaced the view ends loading with the fatal error', async (t) => {
  const { panel, statuses } = panelFixture(t);
  panel.deliveryReady = true;
  panel.webviewReady = true;
  panel.selectedProject = { id: 'project' };
  panel.reloadAndScan = async () => {
    panel.sink.postMessage({ status: 'loading' });
    throw new TypeError('reload broke');
  };
  await panel.handle({ type: 'refresh' });
  assert.deepEqual(statuses(), ['loading', 'runtime-error', 'fatal-error']);
});

test('a failed refresh after stale sends only the banner, so nothing replaces the rows on screen', async (t) => {
  // The review's case: an upgrade applied 2.0.0 locally, its data refresh
  // failed (the webview quarantines that snapshot as stale and shows 2.0.0),
  // then a manual refresh throws after announcing stale. The host's last
  // completed scan still says 1.0.0, so any snapshot sent now would put the
  // old version back and drop the quarantine.
  const { panel, posted, statuses } = panelFixture(t);
  panel.deliveryReady = true;
  panel.webviewReady = true;
  const controller = realController();
  await controller.handleReady(panel.sink);
  panel.controller = controller;
  panel.selectedProject = { id: 'project' };
  panel.reloadAndScan = async () => {
    controller.beginRevalidation();
    controller.announceRevalidating(panel.sink);
    throw new TypeError('reload broke');
  };
  await panel.handle({ type: 'refresh' });
  const afterStale = posted.slice(statuses().lastIndexOf('stale') + 1);
  assert.deepEqual(afterStale.map((message) => message.status), ['runtime-error', 'refresh-failed']);
  assert.ok(!afterStale.some((message) => 'data' in message), 'no snapshot is replayed as if a scan finished');
  assert.equal(controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.0' }).reason, 'revalidating',
    'the host still treats the project as unchecked');
});

test('every failed refresh over stale rows ends refreshing, not only the first', async (t) => {
  const { panel, posted, statuses } = panelFixture(t);
  panel.deliveryReady = true;
  panel.webviewReady = true;
  const controller = realController();
  await controller.handleReady(panel.sink);
  panel.controller = controller;
  panel.selectedProject = { id: 'project' };
  panel.reloadAndScan = async () => {
    controller.beginRevalidation();
    controller.announceRevalidating(panel.sink);
    throw new TypeError('reload broke');
  };
  await panel.handle({ type: 'refresh' });
  await panel.handle({ type: 'refresh' });
  const secondStale = statuses().lastIndexOf('stale');
  const afterSecond = posted.slice(secondStale + 1).map((message) => message.status);
  assert.deepEqual(afterSecond, ['refresh-failed'], 'the retry is settled too, without a second banner');
  assert.equal(statuses().filter((status) => status === 'runtime-error').length, 1);
});

test('the webview ends only its refreshing indicator on the banner and keeps the rows stale', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync('webview/src/App.tsx', 'utf8');
  // The banner touches no dashboard state: rows, upgrade results and the
  // enrichment quarantine stay exactly as they were.
  assert.match(app, /if \(incoming\.status === 'runtime-error'\) \{\s*setRuntimeErrorText\(incoming\.message\);\s*setRefreshStopped\(true\);\s*return;\s*\}/);
  assert.match(app, /if \(incoming\.status === 'refresh-failed'\) \{\s*setRefreshStopped\(true\);\s*return;\s*\}/);
  // Any later snapshot, including a new stale announcement, shows its own state again.
  assert.match(app, /setRefreshStopped\(false\);\s*\/\/ Any other message is a dashboard snapshot/);
  // Still stale: upgrades and other complete-data actions stay disabled.
  assert.match(app, /const upgradesDisabled =\s*status === 'stale' \|\|/);
  // Only the indicator changes.
  assert.match(app, /refreshing=\{status === 'stale' && !refreshStopped\}/);
  assert.match(app, /status === 'stale' && refreshStopped \? \([\s\S]*?stale-status__icon--static[\s\S]*?Refresh did not finish/);
});

test('a failed refresh with rows on screen and no indicator adds only the banner', async (t) => {
  const { panel, statuses } = panelFixture(t);
  panel.deliveryReady = true;
  panel.sink.postMessage({ status: 'loading' });
  panel.shownDashboardStatus = 'ready';
  panel.handleMessage = async () => { throw new TypeError('x'); };
  await panel.handle({ type: 'refresh' });
  assert.deepEqual(statuses(), ['loading', 'runtime-error']);
});
