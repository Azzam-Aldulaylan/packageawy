import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageAnalysisCoordinator } from '../out/host/usage/usageCoordinator.js';
import { appHarness } from './helpers/app-harness.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'the expected lifecycle boundary was reached');
    await tick();
  }
}
function fixture(t, onMessage = () => {}) {
  const messages = [], scans = [], notifications = [], lookups = [];
  const state = { selected: {
    id: 'project', dir: '', manifestPath: '/workspace/package.json',
    folder: { id: 'workspace', name: 'workspace', path: '/workspace' },
  }, disposed: false, busy: false };
  const controller = {
    root: '/workspace',
    upgradeSource: {
      manifestText: JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.0.0', react: '^18.0.0' } }),
      lockfileText: null, lockfilePath: null, packageManager: 'npm', importerId: '.',
    },
    lastResultRows: () => [{ name: 'lodash' }, { name: 'react' }],
  };
  let discoveries = 0;
  const coordinator = new UsageAnalysisCoordinator({
    platform: {
      findFiles: (_query, token) => {
        const index = Math.floor(discoveries++ / 3);
        scans[index] ??= { ...deferred(), token };
        return scans[index].promise;
      },
      statFile: async () => ({ size: 0 }), readFile: async () => new Uint8Array(),
      getSetting: (_key, fallback) => fallback,
      withProgress: async (_title, run) => {
        const notification = { reports: [], cancelled: false };
        notifications.push(notification);
        return run({ report: value => notification.reports.push(value) }, {
          get isCancellationRequested() { return notification.cancelled; },
          onCancellationRequested: callback => {
            notification.cancel = () => { notification.cancelled = true; callback(); };
            return { dispose() {} };
          },
        });
      },
    },
    sink: { postMessage: message => { messages.push(message); onMessage(message); } },
    ensureController: () => { lookups.push(true); return state.lookup?.() ?? Promise.resolve(controller); },
    getSelectedProject: () => state.selected, isDisposed: () => state.disposed,
    isUpgradeBusy: () => state.busy,
  });
  t.after(() => coordinator.dispose());
  const count = status => messages.filter(message => message.status === status).length;
  const finish = async index => { await until(() => scans[index]); scans[index].resolve([]); };
  return { coordinator, controller, state, messages, scans, notifications, lookups, count, finish };
}

function openSmartCleanup(view) {
  view.event({ status: 'ready', data: {
    rows: ['lodash', 'react'].map(name => ({ name, current: '1.0.0', range: '^1.0.0', wanted: '1.0.0', latest: '1.0.0',
      dev: false, optional: false, advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null })),
    generatedAt: 'before', availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    project: { id: 'project', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
    extensionVersion: 'test', builtAt: 'test', hygieneFindings: [],
  } });
  view.find('Dashboard').props.onOpenSmartCleanup();
  view.render();
}

test('cleanup observes a held background scan and repeated clicks coalesce into one publication', async t => {
  const f = fixture(t);
  const background = f.coordinator.requestBackgroundUsageRefresh({ force: true });
  await until(() => f.scans.length === 1);
  const scan = f.coordinator.activeScan;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  assert.equal(f.coordinator.handleAnalyzeCleanup(), cleanup);
  await until(() => scan.progressSubscribers.size === 2);
  for (const subscriber of scan.progressSubscribers) subscriber(1, 2);
  assert.equal(f.notifications[0].reports.length, 1);
  await f.finish(0);
  assert.equal(await cleanup, true);
  await background;
  assert.equal(f.scans.length, 1);
  assert.equal(f.lookups.length, 2, 'one lookup for the scheduled background pass and one for cleanup');
  assert.equal(f.count('cleanup-result'), 1);
  assert.equal(f.count('cleanup-error'), 0);
  assert.equal(scan.progressSubscribers.size, 0);
});

test('cancel during controller lookup prevents attachment and releases priority', async t => {
  const f = fixture(t), lookup = deferred();
  f.state.lookup = () => lookup.promise;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  f.coordinator.handleCancel();
  lookup.resolve(f.controller);
  assert.equal(await cleanup, false);
  assert.equal(f.scans.length, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.coordinator.activeCleanupRequest, undefined);
});

for (const phase of ['lookup', 'waiting', 'observing', 'owning']) {
  test(`progress cancellation while ${phase} leaves Smart Cleanup cancelled in App`, async t => {
    const view = appHarness(t);
    const f = fixture(t, message => view.event(message));
    const lookup = deferred();
    const background = phase === 'observing' ? f.coordinator.handleAnalyzeCleanup({ background: true }) : undefined;
    const other = phase === 'waiting' ? f.coordinator.handleWhereUsed({ package: 'react' }) : undefined;
    if (background || other) await until(() => f.scans.length === 1);
    if (phase === 'lookup') f.state.lookup = () => lookup.promise;
    openSmartCleanup(view);
    const cleanup = f.coordinator.handleAnalyzeCleanup();
    const workspace = () => view.find('SmartCleanupWorkspace').props;
    const requestId = view.sent.findLast(m => m.type === 'analyze-smart-cleanup-metadata').requestId;
    if (phase === 'waiting') await until(() => f.count('cleanup-analyzing') === 1);
    if (phase === 'observing') await until(() => f.coordinator.activeScan.progressSubscribers.size === 2);
    if (phase === 'owning') await until(() => f.scans.length === 1);
    assert.equal(workspace().state.phase, 'analyzing');
    f.notifications[0].cancel();
    f.notifications[0].cancel();
    assert.equal(workspace().state.phase, 'cancelled', 'progress cancellation terminates the review immediately');
    assert.deepEqual(f.messages.filter(m => m.status === 'cleanup-error'), [{
      status: 'cleanup-error',
      error: { code: 'CANCELLED', message: 'Cleanup analysis was cancelled. Select Analyze again.' },
    }]);
    if (phase === 'lookup') lookup.resolve(f.controller);
    else {
      assert.equal(f.scans[0].token.isCancellationRequested, phase === 'owning');
      await f.finish(0);
    }
    assert.equal(await cleanup, false);
    await Promise.all([background, other]);
    view.event({ status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } });
    assert.equal(workspace().state.phase, 'cancelled', 'late scan and metadata completion cannot reopen the review');
    assert.equal(f.count('cleanup-error'), 1);
    assert.equal(f.count('cleanup-result'), Number(phase === 'observing'));
    assert.equal(f.count('usage-result'), Number(phase === 'waiting'));
    assert.equal(f.coordinator.activeCleanupRequest, undefined);
    assert.equal(f.scans.length, phase === 'lookup' ? 0 : 1);
    if (phase === 'observing') {
      await f.coordinator.handleWhereUsed({ package: 'lodash' });
      assert.equal(f.messages.at(-1).analysis.fromCache, true);
      assert.equal(f.scans.length, 1);
    }
  });
}

for (const disposal of ['coordinator', 'panel']) test(`progress cancellation after ${disposal} disposal stays quiet`, async t => {
  const f = fixture(t), lookup = deferred();
  f.state.lookup = () => lookup.promise;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  if (disposal === 'coordinator') f.coordinator.dispose();
  else f.state.disposed = true;
  f.notifications[0].cancel();
  lookup.resolve(f.controller);
  assert.equal(await cleanup, false);
  assert.deepEqual(f.messages, []);
  assert.equal(f.scans.length, 0);
});

for (const consumer of ['where-used', 'removal-impact']) for (const cancel of ['message', 'progress']) {
  test(`cleanup cancellation through ${cancel} preserves a joined ${consumer} consumer and background cache`, async t => {
    const f = fixture(t);
    const background = f.coordinator.handleAnalyzeCleanup({ background: true });
    await until(() => f.scans.length === 1);
    const other = consumer === 'where-used'
      ? f.coordinator.handleWhereUsed({ package: 'react' })
      : f.coordinator.handleAnalyzeRemovalImpact({ requestId: 'impact', packages: ['react'] });
    await until(() => f.coordinator.foregroundOperations.isClaimed());
    const scan = f.coordinator.activeScan;
    const cleanup = f.coordinator.handleAnalyzeCleanup();
    await until(() => scan.progressSubscribers.size === (consumer === 'where-used' ? 2 : 3));
    assert.equal(f.coordinator.handleAnalyzeCleanup(), cleanup);
    if (cancel === 'message') f.coordinator.handleCancel();
    else f.notifications[0].cancel();
    const before = f.messages.length;
    for (const subscriber of scan.progressSubscribers) subscriber(1, 2);
    assert.equal(f.messages.slice(before).filter(m => m.status === 'cleanup-analyzing').length, 0);
    assert.equal(f.scans[0].token.isCancellationRequested, false);
    await f.finish(0);
    await Promise.all([background, other, cleanup]);
    assert.equal(f.count('cleanup-result'), 1);
    assert.equal(f.count('cleanup-error'), Number(cancel === 'progress'));
    assert.equal(f.count(consumer === 'where-used' ? 'usage-result' : 'removal-impact-result'), 1);
    await f.coordinator.handleWhereUsed({ package: 'lodash' });
    assert.equal(f.messages.at(-1).analysis.fromCache, true);
    assert.equal(f.scans.length, 1);
    assert.equal(scan.progressSubscribers.size, 0);
  });
}

test('a joined background failure produces one cleanup error for repeated clicks', async t => {
  const f = fixture(t);
  const background = f.coordinator.handleAnalyzeCleanup({ background: true });
  await until(() => f.scans.length === 1);
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  assert.equal(f.coordinator.handleAnalyzeCleanup(), cleanup);
  await until(() => f.coordinator.activeScan.progressSubscribers.size === 2);
  f.scans[0].reject(new Error('discovery failed'));
  await Promise.all([background, cleanup]);
  assert.equal(f.count('cleanup-error'), 1);
  assert.equal(f.count('cleanup-result'), 0);
});

test('cleanup waits past a rejected foreground scan and takes a fresh package snapshot', async t => {
  const f = fixture(t);
  const other = f.coordinator.handleWhereUsed({ package: 'react' });
  await until(() => f.scans.length === 1);
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await until(() => f.lookups.length === 2);
  f.controller.lastResultRows = () => [{ name: 'lodash' }];
  f.scans[0].reject(new Error('discovery failed'));
  await until(() => f.scans.length === 2);
  assert.deepEqual([...f.coordinator.activeScan.packageNames], ['lodash']);
  await f.finish(1);
  await other;
  assert.equal(await cleanup, true);
  assert.equal(f.count('cleanup-result'), 1);
  assert.equal(f.count('cleanup-error'), 0);
});

test('cancelling cleanup while it waits never cancels foreground where-used', async t => {
  const f = fixture(t);
  const other = f.coordinator.handleWhereUsed({ package: 'react' });
  await until(() => f.scans.length === 1);
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await until(() => f.lookups.length === 2);
  f.coordinator.handleCancel();
  assert.equal(f.scans[0].token.isCancellationRequested, false);
  await f.finish(0);
  await other;
  assert.equal(await cleanup, false);
  assert.equal(f.count('usage-result'), 1);
  assert.equal(f.scans.length, 1);
});

for (const change of ['identity', 'fingerprint', 'project', 'cancel-scan', 'dispose']) {
  test(`${change} during a join prevents stale cleanup publication`, async t => {
    const view = appHarness(t);
    const f = fixture(t, message => view.event(message));
    const background = f.coordinator.handleAnalyzeCleanup({ background: true });
    await until(() => f.scans.length === 1);
    const scan = f.coordinator.activeScan;
    openSmartCleanup(view);
    const cleanup = f.coordinator.handleAnalyzeCleanup();
    await until(() => scan.progressSubscribers.size === 2);
    if (change === 'identity') f.coordinator.invalidateProjectSource('project');
    if (change === 'fingerprint') f.controller.upgradeSource.manifestText += ' ';
    if (change === 'project') f.state.selected = { ...f.state.selected, id: 'other' };
    if (change === 'cancel-scan') scan.cts.cancel();
    if (change === 'dispose') f.coordinator.dispose();
    await f.finish(0);
    assert.deepEqual(await Promise.all([background, cleanup]), [false, false]);
    const results = f.messages.filter(m => m.status === 'cleanup-result');
    assert.equal(results.length, change === 'identity' ? 1 : 0, 'only source invalidation posts the existing stale reset');
    if (change === 'identity') assert.equal(Date.parse(results[0].cacheExpiresAt), 0);
    const errors = f.messages.filter(m => m.status === 'cleanup-error');
    assert.equal(errors.length, change === 'dispose' ? 0 : 1, 'every live join has a terminal error');
    if (change !== 'dispose') {
      assert.equal(errors[0].error.code, change === 'cancel-scan' ? 'CANCELLED' : 'STALE_SOURCE');
      assert.equal(errors[0].error.message, change === 'cancel-scan'
        ? 'Cleanup analysis was cancelled. Select Analyze again.'
        : 'Project files changed during the analysis. Select Analyze again.');
    }
    if (change !== 'dispose') assert.equal(view.find('SmartCleanupWorkspace').props.state.phase,
      change === 'identity' ? 'stale' : change === 'cancel-scan' ? 'cancelled' : 'failed');
    assert.equal(scan.progressSubscribers.size, 0);
  });
}

for (const change of ['identity', 'fingerprint', 'project']) test(`Retry before the ${change} superseded join settles uses fresh evidence in App`, async t => {
  const view = appHarness(t);
  const f = fixture(t, message => view.event(message));
  const background = f.coordinator.handleAnalyzeCleanup({ background: true });
  await until(() => f.scans.length === 1);
  const scan = f.coordinator.activeScan;
  openSmartCleanup(view);
  const old = f.coordinator.handleAnalyzeCleanup();
  await until(() => scan.progressSubscribers.size === 2);
  if (change === 'identity') f.coordinator.invalidateProjectSource('project');
  if (change === 'fingerprint') f.controller.upgradeSource.manifestText += ' ';
  if (change === 'project') f.state.selected = { ...f.state.selected, id: 'other' };
  const workspace = () => view.find('SmartCleanupWorkspace').props;
  workspace().onAnalyze();
  view.render();
  assert.equal(view.sent.filter(m => m.type === 'analyze-cleanup').length, 2);
  const retry = f.coordinator.handleAnalyzeCleanup();
  assert.notEqual(retry, old, 'a superseded request cannot absorb Retry');
  await until(() => f.count('cleanup-analyzing') === 2);
  f.notifications[0].cancel();
  assert.equal(f.coordinator.activeCleanupRequest.cancelled, false, 'a superseded progress token cannot cancel Retry');
  assert.equal(f.count('cleanup-error'), 0, 'a superseded progress token cannot fail Retry');
  const requestId = view.sent.findLast(m => m.type === 'analyze-smart-cleanup-metadata').requestId;
  view.event({ status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } });
  assert.equal(workspace().state.phase, 'analyzing', 'metadata alone cannot complete Retry');
  await f.finish(0);
  await until(() => f.scans.length === 2);
  assert.equal(await old, false);
  assert.equal(await background, false);
  assert.equal(f.count('cleanup-error'), 0, 'the old observer cannot fail the Retry');
  assert.equal(workspace().state.phase, 'analyzing');
  await f.finish(1);
  assert.equal(await retry, true);
  const result = f.messages.findLast(m => m.status === 'cleanup-result');
  assert.ok(Date.parse(result.cacheExpiresAt) > Date.now());
  assert.deepEqual(result.findings.map(finding => finding.packageName), ['lodash', 'react']);
  const impact = view.sent.findLast(m => m.type === 'analyze-removal-impact');
  assert.ok(impact, 'fresh findings reach removal safety instead of reporting no findings');
  view.event({ status: 'removal-impact-result', requestId: impact.requestId, packages: impact.packages,
    generatedAt: new Date().toISOString(), assessments: impact.packages.map(packageName => ({
      packageName, usageId: 'usage', assessment: { status: 'low-risk', evidence: [] },
    })),
  });
  assert.equal(workspace().state.phase, 'ready');
  assert.equal(f.scans.length, 2);
});

for (const joined of [true, false]) test(`Cancel then Retry survives an old progress token with joined ${joined}`, async t => {
  const f = fixture(t);
  const background = joined ? f.coordinator.handleAnalyzeCleanup({ background: true }) : undefined;
  if (joined) await until(() => f.scans.length === 1);
  const old = f.coordinator.handleAnalyzeCleanup();
  await until(() => f.scans.length === 1 && (joined ? f.coordinator.activeScan.progressSubscribers.size === 2 : true));
  f.coordinator.handleCancel();
  const retry = f.coordinator.handleAnalyzeCleanup();
  assert.notEqual(retry, old);
  if (joined) {
    await until(() => f.coordinator.activeScan.progressSubscribers.size === 3);
    f.notifications[0].cancel();
    assert.equal(f.scans[0].token.isCancellationRequested, false);
  }
  await f.finish(0);
  if (!joined) {
    await until(() => f.scans.length === 2);
    f.notifications[0].cancel();
    assert.equal(f.scans[1].token.isCancellationRequested, false);
    await f.finish(1);
  }
  assert.equal(await retry, true);
  assert.equal(await old, false);
  await background;
  assert.equal(f.count('cleanup-result'), 1);
  assert.equal(f.count('cleanup-error'), 0);
});

test('a scheduler waiting for its controller yields to waiting cleanup and keeps its forced request', async t => {
  const f = fixture(t);
  const lookup = deferred();
  f.state.lookup = () => lookup.promise;
  const scheduled = f.coordinator.requestBackgroundUsageRefresh({ force: true });
  f.state.lookup = undefined;
  const other = f.coordinator.handleWhereUsed({ package: 'react' });
  await until(() => f.scans.length === 1);
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await until(() => f.lookups.length === 3);
  await f.coordinator.requestBackgroundUsageRefresh();
  assert.equal(f.coordinator.pendingBackgroundRequest.force, false);
  lookup.resolve(f.controller);
  await scheduled;
  assert.equal(f.scans.length, 1);
  assert.equal(f.coordinator.pendingBackgroundRequest.force, true);
  await f.finish(0);
  await until(() => f.scans.length === 2);
  await f.finish(1);
  await Promise.all([other, cleanup]);
  await tick();
  assert.equal(f.scans.length, 2, 'cleanup satisfies the earlier forced refresh');
  assert.equal(f.coordinator.pendingBackgroundRequest, undefined);
});

test('the background handler final gate returns its claimed request to the scheduler', async t => {
  const f = fixture(t), lookup = deferred();
  f.state.lookup = () => lookup.promise;
  let cleanup, reads = 0;
  const source = f.controller.upgradeSource;
  Object.defineProperty(f.controller, 'upgradeSource', { get() {
    // The second read follows the handler's first priority check.
    if (++reads === 2) cleanup = f.coordinator.handleAnalyzeCleanup();
    return source;
  } });
  const claimed = { force: true, sequence: 1 };
  f.coordinator.backgroundRequestSequence = 1;
  const returned = await f.coordinator.handleAnalyzeCleanup({
    background: true, controller: f.controller, pendingRequest: claimed,
  });
  assert.equal(returned, claimed);
  f.coordinator.mergePendingBackgroundRequest(returned);
  assert.ok(cleanup, 'cleanup arrived between the initial and final priority checks');
  assert.deepEqual(f.coordinator.pendingBackgroundRequest, claimed);
  assert.equal(f.scans.length, 0);
  assert.equal(f.lookups.length, 1, 'only the foreground request looked up its controller');
  f.coordinator.handleCancel();
  lookup.resolve(f.controller);
  await cleanup;
  await until(() => f.scans.length === 1);
  await f.finish(0);
  await until(() => !f.coordinator.isBusy());
});

for (const outcome of ['success', 'cancel', 'failure']) for (const queued of ['before', 'after']) {
  test(`forced refresh queued ${queued} cleanup starts, cleanup outcome ${outcome}`, async t => {
    const f = fixture(t), lookup = deferred();
    f.state.lookup = () => lookup.promise;
    const cleanup = f.coordinator.handleAnalyzeCleanup();
    if (queued === 'before') await f.coordinator.requestBackgroundUsageRefresh({ force: true });
    f.state.lookup = undefined;
    lookup.resolve(f.controller);
    await until(() => f.scans.length === 1);
    if (queued === 'after') await f.coordinator.requestBackgroundUsageRefresh({ force: true });
    if (outcome === 'cancel') f.coordinator.handleCancel();
    if (outcome === 'failure') f.scans[0].reject(new Error('failed'));
    else await f.finish(0);
    assert.equal(await cleanup, outcome === 'success');
    const extra = queued === 'after' || outcome !== 'success';
    if (extra) {
      await until(() => f.scans.length === 2);
      await f.finish(1);
      await until(() => f.count('cleanup-result') >= 1 + Number(outcome === 'success'));
    }
    await tick();
    assert.equal(f.scans.length, extra ? 2 : 1);
    assert.equal(f.messages.some(m => m.error?.code === 'ANALYSIS_IN_PROGRESS'), false);
  });
}

test('cleanup finishing without a controller releases queued background work', async t => {
  const f = fixture(t), lookup = deferred();
  f.state.lookup = () => lookup.promise;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await f.coordinator.requestBackgroundUsageRefresh({ force: true });
  f.state.lookup = undefined;
  lookup.resolve(undefined);
  assert.equal(await cleanup, false);
  await until(() => f.scans.length === 1);
  await f.finish(0);
  await until(() => f.count('cleanup-result') === 1);
});

test('explicit cleanup still looks up its controller and starts an owned scan', async t => {
  const f = fixture(t);
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await until(() => f.scans.length === 1);
  assert.equal(f.lookups.length, 1);
  assert.equal(f.coordinator.activeCleanupRequest.consumer.value.ownsScan, true);
  await f.finish(0);
  assert.equal(await cleanup, true);
});

for (const mismatch of ['coverage', 'identity', 'project']) test(`cleanup waits behind a background scan with different ${mismatch}`, async t => {
  const view = appHarness(t);
  const f = fixture(t, message => view.event(message));
  if (mismatch === 'coverage') f.controller.lastResultRows = () => [{ name: 'lodash' }];
  const background = f.coordinator.handleAnalyzeCleanup({ background: true });
  await until(() => f.scans.length === 1);
  if (mismatch === 'coverage') f.controller.lastResultRows = () => [{ name: 'lodash' }, { name: 'react' }];
  if (mismatch === 'identity') f.controller.upgradeSource.manifestText += ' ';
  if (mismatch === 'project') f.state.selected = { ...f.state.selected, id: 'other' };
  openSmartCleanup(view);
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  const workspace = () => view.find('SmartCleanupWorkspace').props;
  const requestId = view.sent.findLast(m => m.type === 'analyze-smart-cleanup-metadata').requestId;
  view.event({ status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } });
  await until(() => f.lookups.length === 2);
  await tick();
  assert.equal(f.coordinator.activeScan.progressSubscribers.size, 1, 'cleanup waits without observing the incompatible scan');
  await f.finish(0);
  await until(() => f.scans.length === 2);
  await background;
  const prematureImpact = view.sent.findLast(m => m.type === 'analyze-removal-impact');
  if (prematureImpact) await f.coordinator.handleAnalyzeRemovalImpact(prematureImpact);
  assert.equal(workspace().state.phase, 'analyzing', 'incompatible findings cannot complete the review');
  assert.equal(f.count('cleanup-result'), 0);
  assert.equal(prematureImpact, undefined, 'removal safety waits for full usage evidence');
  await f.finish(1);
  assert.equal(await cleanup, true);
  const impact = view.sent.findLast(m => m.type === 'analyze-removal-impact');
  assert.deepEqual([...impact.packages], ['lodash', 'react']);
  await f.coordinator.handleAnalyzeRemovalImpact(impact);
  assert.equal(workspace().state.phase, 'ready');
  assert.deepEqual([...workspace().state.plan.recommendations].map(item => item.packageName).sort(), ['lodash', 'react']);
  assert.equal(f.scans.length, 2, 'removal safety uses cached evidence');
  assert.equal(f.count('cleanup-error'), 0);
  assert.equal(f.count('cleanup-result'), 1);
});

for (const cancelled of [false, true]) test(`partial background coverage still publishes without a waiting cleanup, cancelled ${cancelled}`, async t => {
  const f = fixture(t);
  f.controller.lastResultRows = () => [{ name: 'lodash' }];
  const background = f.coordinator.handleAnalyzeCleanup({ background: true });
  await until(() => f.scans.length === 1);
  f.controller.lastResultRows = () => [{ name: 'lodash' }, { name: 'react' }];
  let cleanup;
  if (cancelled) {
    cleanup = f.coordinator.handleAnalyzeCleanup();
    await until(() => f.lookups.length === 2);
    f.coordinator.handleCancel();
  }
  await f.finish(0);
  assert.equal(await background, true);
  if (cleanup) assert.equal(await cleanup, false);
  assert.equal(f.count('cleanup-result'), 1);
  assert.deepEqual(f.messages.find(m => m.status === 'cleanup-result').findings.map(item => item.packageName), ['lodash']);
  await f.coordinator.handleWhereUsed({ package: 'lodash' });
  assert.equal(f.messages.at(-1).analysis.fromCache, true);
  assert.equal(f.scans.length, 1);
});

test('background publication waits for cleanup coverage during controller lookup and keeps cached evidence', async t => {
  const f = fixture(t), lookup = deferred();
  f.controller.lastResultRows = () => [{ name: 'lodash' }];
  const background = f.coordinator.handleAnalyzeCleanup({ background: true });
  await until(() => f.scans.length === 1);
  f.controller.lastResultRows = () => [{ name: 'lodash' }, { name: 'react' }];
  f.state.lookup = () => lookup.promise;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  f.state.lookup = undefined;
  await f.finish(0);
  assert.equal(await background, false);
  assert.equal(f.count('cleanup-result'), 0);
  await f.coordinator.handleWhereUsed({ package: 'lodash' });
  assert.equal(f.messages.at(-1).analysis.fromCache, true);
  assert.equal(f.scans.length, 1);
  lookup.resolve(f.controller);
  await until(() => f.scans.length === 2);
  await f.finish(1);
  assert.equal(await cleanup, true);
  assert.equal(f.count('cleanup-result'), 1);
  assert.equal(f.count('cleanup-error'), 0);
});

for (const newerForce of [false, true]) test(`an already claimed refresh is satisfied by cleanup, newer force ${newerForce}`, async t => {
  const f = fixture(t), lookup = deferred();
  f.state.lookup = () => lookup.promise;
  const scheduled = f.coordinator.requestBackgroundUsageRefresh({ force: true });
  f.state.lookup = undefined;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await until(() => f.scans.length === 1);
  if (newerForce) await f.coordinator.requestBackgroundUsageRefresh({ force: true });
  await f.finish(0);
  assert.equal(await cleanup, true);
  lookup.resolve(f.controller);
  if (newerForce) {
    await until(() => f.scans.length === 2);
    await f.finish(1);
  }
  await scheduled;
  assert.equal(f.scans.length, newerForce ? 2 : 1);
  assert.equal(f.coordinator.pendingBackgroundRequest, undefined);
});

for (const exit of ['error', 'empty']) test(`cleanup ${exit} before starting a scan releases queued background work`, async t => {
  const f = fixture(t), lookup = deferred();
  f.state.lookup = () => lookup.promise;
  const cleanup = f.coordinator.handleAnalyzeCleanup();
  await f.coordinator.requestBackgroundUsageRefresh({ force: true });
  f.state.lookup = undefined;
  if (exit === 'error') lookup.reject(new Error('lookup failed'));
  else {
    let reads = 0;
    f.controller.lastResultRows = () => ++reads === 1 ? [] : [{ name: 'lodash' }];
    lookup.resolve(f.controller);
  }
  assert.equal(await cleanup, exit === 'empty');
  await until(() => f.scans.length === 1);
  await f.finish(0);
  await until(() => f.count('cleanup-result') === (exit === 'empty' ? 2 : 1));
  assert.equal(f.count('cleanup-error'), exit === 'error' ? 1 : 0);
});
