/**
 * DashboardPanel after an internal error: the entry point catches it, changes
 * pause, read-only messages keep working, background work stops for good and
 * the banner stays until the panel closes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RUNTIME_ERROR_CODE, RUNTIME_ERROR_TEXT } from '../out/core/diagnostics.js';
import { FileChangeCoordinator } from '../out/core/cache/fileChangeCoordinator.js';
import { DashboardPanel } from '../out/host/dashboardPanel.js';
import { CHANGE_STARTING_MESSAGE_TYPES, isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makePanel(platformOverrides = {}) {
  globalThis.__BUILD_TIME__ = 'test';
  const posted = [];
  const logs = [];
  const watches = [];
  let settingChanged;
  let disposeChannel;
  const store = { get: () => undefined, update: async () => {} };
  const platform = {
    workspaceFolders: () => [],
    getSetting: (_key, fallback) => fallback,
    globalState: store,
    workspaceState: store,
    log: (line) => logs.push(line),
    onDidChangeSetting: (_key, listener) => {
      settingChanged = listener;
      return { dispose() { settingChanged = undefined; } };
    },
    watchFiles: (baseDir, glob) => {
      watches.push({ baseDir, glob });
      return { dispose() {} };
    },
    watchGitHead: async () => undefined,
    ...platformOverrides,
  };
  const channel = {
    postMessage: (message) => {
      assert.ok(isHostToWebviewMessage(message), `invalid host message ${JSON.stringify(message)}`);
      posted.push(message);
    },
    onDidReceiveMessage() {},
    onDidDispose: (listener) => { disposeChannel = listener; },
    reveal() {},
  };
  const panel = new DashboardPanel(platform, channel, { extensionVersion: 'test', integrationTestMode: false });
  panel.deliveryReady = true;
  return {
    panel,
    platform,
    posted,
    logs,
    watches,
    settingChanged: () => settingChanged?.(),
    close: () => disposeChannel?.(),
    banners: () => posted.filter((message) => message.status === 'runtime-error'),
  };
}

/** Puts the panel into its failed state the way a real dispatch failure does. */
async function failOnce(fixture, error = new TypeError('cannot read /Users/me/project/package.json')) {
  const original = fixture.panel.handleMessage;
  fixture.panel.handleMessage = async () => {
    throw error;
  };
  await fixture.panel.handle({ type: 'refresh' });
  fixture.panel.handleMessage = original;
}

test('a throwing message handler is caught, logged safely and shows one banner', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  await failOnce(fixture);
  assert.deepEqual(fixture.logs, ['runtime: webview-message failed (TypeError)']);
  assert.deepEqual(fixture.banners(), [{ status: 'runtime-error', code: RUNTIME_ERROR_CODE, message: RUNTIME_ERROR_TEXT }]);
  await failOnce(fixture);
  assert.equal(fixture.banners().length, 1, 'a second failure does not stack banners');
  assert.equal(fixture.logs.length, 2, 'but it is logged');
});

test('a throwing refresh after the message is caught separately', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  let handled = false;
  fixture.panel.handleMessage = async () => {
    handled = true;
  };
  fixture.panel.flushAdvisorySettingRefresh = async () => {
    throw new RangeError('refresh broke');
  };
  await fixture.panel.handle({ type: 'refresh' });
  assert.equal(handled, true);
  assert.deepEqual(fixture.logs, ['runtime: refresh-after-message failed (RangeError)']);
  assert.equal(fixture.banners().length, 1);
});

test('when both the message and the refresh after it fail, both are logged', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  fixture.panel.handleMessage = async () => {
    throw new TypeError('message broke');
  };
  fixture.panel.flushAdvisorySettingRefresh = async () => {
    throw new RangeError('refresh broke');
  };
  await assert.doesNotReject(fixture.panel.handle({ type: 'refresh' }));
  assert.deepEqual(fixture.logs, [
    'runtime: webview-message failed (TypeError)',
    'runtime: refresh-after-message failed (RangeError)',
  ]);
  assert.equal(fixture.banners().length, 1);
});

test('after a failure change-starting messages are refused and read-only ones still run', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  const coordinator = fixture.panel.upgradeCoordinator;
  const executed = [];
  coordinator.handleConfirmUpgrade = async () => executed.push('confirm-upgrade');
  coordinator.handleUseSmartPlan = async () => executed.push('use-smart-plan');
  coordinator.handleConfirmRemove = async () => executed.push('confirm-remove');
  coordinator.handleConfirmRemediation = async () => executed.push('confirm-remediation');
  coordinator.handleRestoreSmartCleanup = async () => executed.push('restore-smart-cleanup');
  coordinator.handleAnalyzeUpgrade = async () => executed.push('upgrade');
  coordinator.analysis = { id: 'review', eligibility: { packageName: 'left-pad' }, expiresAt: Date.now() + 60_000 };
  coordinator.removal = { id: 'removal', reservationKey: 'react', expiresAt: Date.now() + 60_000 };
  coordinator.remediationPlans.set('fix', { id: 'fix', packageName: 'lodash' });
  let refreshed = 0;
  fixture.panel.selectedProject = { id: 'project' };
  fixture.panel.reloadAndScan = async () => {
    refreshed += 1;
  };

  await failOnce(fixture);
  for (const message of [
    { type: 'confirm-upgrade', analysisId: 'review' },
    { type: 'use-smart-plan', analysisId: 'review' },
    { type: 'confirm-remove', analysisId: 'removal' },
    { type: 'confirm-remediation', analysisId: 'fix' },
    { type: 'restore-smart-cleanup', analysisId: 'kept' },
  ]) {
    await fixture.panel.handle(message);
  }
  assert.deepEqual(executed, [], 'no change-starting handler ran');
  const refusals = fixture.posted.filter((message) => message.error?.code === 'CHANGES_PAUSED');
  assert.deepEqual(refusals.map((message) => [message.status, message.package]), [
    ['upgrade-error', 'left-pad'],
    ['upgrade-error', 'left-pad'],
    ['remove-error', 'react'],
    ['remediation-error', 'lodash'],
    ['remove-error', 'Smart Cleanup'],
  ]);
  assert.equal(coordinator.analysis?.id, 'review', 'a refused confirmation does not consume the review');

  await fixture.panel.handle({ type: 'upgrade', package: 'left-pad', target: '2.0.0', requestId: 'r' });
  await fixture.panel.handle({ type: 'refresh' });
  assert.deepEqual(executed, ['upgrade'], 'analysis is read-only and still runs');
  assert.equal(refreshed, 1, 'Refresh still works');
});

test('every webview message type is classified as change-starting or read-only', () => {
  // A new message type fails here until someone decides whether it can start
  // writing dependency files. Change-starting ones go in
  // CHANGE_STARTING_MESSAGE_TYPES (webviewProtocol.ts) and are refused after
  // an internal error.
  const readOnly = new Set([
    'inspect-recovery', 'start-recovery', 'apply-recovery', 'dismiss-recovery',
    'ready', 'rendered', 'refresh', 'change-project', 'load-upgrade-targets', 'cancel-upgrade-targets', 'upgrade',
    'bulk-upgrade', 'bulk-remove', 'smart-cleanup-remove', 'open-advisory', 'cancel-upgrade', 'retry-upgrade-enrichment',
    'cancel-remove', 'configure-verification', 'configure-advisory-check', 'analyze-remediation', 'cancel-remediation',
    'retry-remediation', 'analyze-remediations', 'cancel-remediation-analysis', 'where-used', 'reanalyze-usage',
    'analyze-cleanup', 'analyze-smart-cleanup-metadata', 'cancel-smart-cleanup-metadata', 'analyze-removal-impact',
    'cancel-removal-impact', 'cancel-usage-analysis', 'open-usage-reference', 'show-log',
  ]);
  const source = readFileSync('src/host/webviewProtocol.ts', 'utf8');
  const union = source.slice(source.indexOf('export type WebviewToHostMessage ='), source.indexOf('export const CHANGE_STARTING_MESSAGE_TYPES'));
  const declared = new Set([...union.matchAll(/\btype: '([a-z-]+)'/g)].map((match) => match[1]));
  const changing = new Set(CHANGE_STARTING_MESSAGE_TYPES);
  assert.deepEqual([...changing].sort(), ['confirm-remediation', 'confirm-remove', 'confirm-upgrade', 'restore-smart-cleanup', 'use-smart-plan']);
  for (const type of declared) {
    assert.ok(changing.has(type) !== readOnly.has(type), `classify webview message '${type}' exactly once`);
  }
  assert.deepEqual([...readOnly].filter((type) => !declared.has(type)), [], 'the read-only list names only real types');

  // Every coordinator handler that leads to a mutation is reached only through a change-starting type.
  const panel = readFileSync('src/host/dashboardPanel.ts', 'utf8');
  for (const [handler, type] of [
    ['handleConfirmUpgrade', 'confirm-upgrade'],
    ['handleUseSmartPlan', 'use-smart-plan'],
    ['handleConfirmRemove', 'confirm-remove'],
    ['handleConfirmRemediation', 'confirm-remediation'],
    ['handleRestoreSmartCleanup', 'restore-smart-cleanup'],
  ]) {
    const calls = [...panel.matchAll(new RegExp(`message\\.type === '([a-z-]+)'\\) \\{\\s*await this\\.upgradeCoordinator\\.${handler}\\(`, 'g'))];
    assert.deepEqual(calls.map((match) => match[1]), [type], `${handler} is dispatched only for ${type}`);
  }
});

test('a reloaded webview gets the banner back, and a new panel starts without it', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  fixture.panel.handleReadyMessage = async () => {};
  await failOnce(fixture);
  await fixture.panel.handle({ type: 'ready' });
  await fixture.panel.handle({ type: 'ready' });
  assert.equal(fixture.banners().length, 3);

  const fresh = makePanel();
  t.after(fresh.close);
  fresh.panel.handleReadyMessage = async () => {};
  await fresh.panel.handle({ type: 'ready' });
  assert.equal(fresh.banners().length, 0);
  assert.equal(fresh.panel.runtimeFailed, false);
});

test('Show Log opens the host log', async (t) => {
  let shown = 0;
  const fixture = makePanel({ showLog: () => { shown += 1; } });
  t.after(fixture.close);
  await fixture.panel.handle({ type: 'show-log' });
  assert.equal(shown, 1);
});

test('a Git HEAD watcher still being set up when the failure lands is disposed when it arrives', async (t) => {
  let finishSetup;
  let disposed = 0;
  const fixture = makePanel({
    watchGitHead: () => new Promise((resolve) => { finishSetup = resolve; }),
  });
  t.after(fixture.close);
  fixture.panel.setupGitHeadWatcher('/work/app/package.json');
  await failOnce(fixture);
  finishSetup({ dispose: () => { disposed += 1; } });
  await tick();
  assert.equal(disposed, 1);
  assert.equal(fixture.panel.gitHeadWatcher, undefined);
});

test('a refresh after the failure installs no watcher and schedules no usage scan', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  let usageScans = 0;
  fixture.panel.usageCoordinator.requestBackgroundUsageRefresh = async () => {
    usageScans += 1;
  };
  fixture.panel.automaticUsageReleased = true;
  await failOnce(fixture);
  const candidate = { id: 'project', dir: '', folder: { path: '/work/app' } };
  fixture.panel.setupFileWatchers(candidate, '/work/app/package.json');
  fixture.panel.requestAutomaticUsageRefresh({ force: true });
  fixture.panel.onBackgroundTick();
  await tick();
  assert.deepEqual(fixture.watches, []);
  assert.equal(usageScans, 0);
});

test('queued file reloads and a pending setting refresh do not run when the transaction releases its lock', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  const coordinator = fixture.panel.upgradeCoordinator;
  let busy = true;
  coordinator.isBusy = () => busy;
  coordinator.isMutationBusy = () => busy;
  coordinator.isRemediationBusy = () => false;
  const started = [];
  fixture.panel.reloadAfterFileChange = async () => started.push('file reload');
  fixture.panel.reloadAndScan = async () => started.push('scan');
  fixture.panel.selectedProject = { id: 'project' };
  fixture.panel.controller = { handleAdvisorySettingChanged() {}, dispose() {} };

  // A watcher burst lands while the change is running: it is deferred.
  fixture.panel.fileChangeCoordinator.notify('lockfile');
  await fixture.panel.fileChangeCoordinator.flush();
  fixture.panel.fileChangeCoordinator.notify('manifest');
  fixture.settingChanged();
  await tick();
  assert.equal(fixture.panel.fileChangeCoordinator.hasDeferred, true);
  assert.equal(fixture.panel.advisorySettingRefreshPending, true);

  await failOnce(fixture);
  busy = false;
  await coordinator.options.flushDeferredChanges();
  coordinator.options.onMutationLockReleased();
  await tick();
  assert.deepEqual(started, [], 'no reload or scan starts after the failure');
  assert.equal(fixture.panel.advisorySettingRefreshPending, false);
});

test('a disk read in flight when the failure lands starts no scan', async (t) => {
  const fixture = makePanel();
  t.after(fixture.close);
  let finishRead;
  let scans = 0;
  const candidate = { id: 'project', dir: '', folder: { id: 'f', name: 'app', path: '/work/app' } };
  fixture.panel.selectedProject = candidate;
  fixture.panel.controller = {
    beginRevalidation: () => 1,
    announceRevalidating() {},
    invalidateCache() {},
    updateProjectSnapshot() {},
    refreshInBackground: async () => { scans += 1; },
    dispose() {},
  };
  fixture.panel.loadProjectMeasured = () => new Promise((resolve) => { finishRead = resolve; });
  const reload = fixture.panel.reloadAfterFileChange(new Set(['manifest']), fixture.panel.reloadGeneration);
  await failOnce(fixture);
  finishRead({ root: '/work/app', manifestText: '{}', lockfileText: null, lockfilePath: null, registry: 'https://registry.npmjs.org/' });
  await reload;
  assert.equal(scans, 0);
});

test('the file change coordinator stop cancels a reload already queued', async () => {
  const reloads = [];
  let finishFirst;
  const coordinator = new FileChangeCoordinator({
    isBusy: () => false,
    currentGeneration: () => 1,
    reload: async (kinds) => {
      reloads.push([...kinds]);
      if (reloads.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    },
  });
  coordinator.notify('manifest');
  const first = coordinator.flush();
  await tick();
  coordinator.notify('lockfile');
  const queued = coordinator.flush();
  coordinator.stop();
  finishFirst();
  await Promise.all([first, queued]);
  assert.deepEqual(reloads, [['manifest']], 'the queued step saw the stop and did nothing');

  const fresh = new FileChangeCoordinator({ isBusy: () => false, currentGeneration: () => 1, reload: async () => reloads.push('fresh') });
  fresh.notify('manifest');
  const pending = fresh.flush();
  fresh.stop();
  await pending;
  fresh.notify('lockfile');
  await fresh.flush();
  assert.equal(await fresh.flushAll(), false);
  assert.deepEqual(reloads, [['manifest']], 'notify, flush, stop invokes no reload, and later calls are no-ops');
});

test('the sidecar entry point reaches the open panel and reports when none is open', async (t) => {
  assert.equal(DashboardPanel.reportRuntimeFailure('unhandled-rejection', new Error('x')), false);
  const fixture = makePanel();
  DashboardPanel.current = fixture.panel;
  t.after(() => {
    fixture.close();
    DashboardPanel.current = undefined;
  });
  assert.equal(DashboardPanel.reportRuntimeFailure('unhandled-rejection', new Error('/secret')), true);
  assert.deepEqual(fixture.logs, ['runtime: unhandled-rejection failed (Error)']);
  assert.equal(fixture.banners().length, 1);
  assert.equal(fixture.panel.backgroundStopped, true);
});

test('the webview keeps the banner through later snapshots and never shows a Reload button for it', () => {
  const app = readFileSync('webview/src/App.tsx', 'utf8');
  assert.match(app, /if \(incoming\.status === 'runtime-error'\) \{\s*setRuntimeErrorText\(incoming\.message\);\s*setRefreshStopped\(true\);\s*return;\s*\}/);
  assert.deepEqual([...app.matchAll(/setRuntimeErrorText\(([^)]*)\)/g)].map((match) => match[1]), ['incoming.message'],
    'nothing clears the banner while the panel is open');
  assert.match(app, /runtimeErrorText !== null \? \(\s*<StatusBanner tone="error" action=\{\{ label: 'Show Log', onClick: requestShowLog \}\}>/);
});
