/**
 * Review follow-ups for the internal error gate: usage background scans stop,
 * escaped branch reconciliation failures are reported, a failed request is
 * answered, an unopened link is reported, and a hostile handler result
 * cannot escape fireAndForget.
 */

import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';

import { fireAndForget } from '../out/core/fireAndForget.js';
import { BranchChangeCoordinator } from '../out/host/branchChangeCoordinator.js';
import { DashboardPanel } from '../out/host/dashboardPanel.js';
import { UsageAnalysisCoordinator } from '../out/host/usage/usageCoordinator.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function usageFixture(ensureController) {
  const coordinator = new UsageAnalysisCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage() {} },
    ensureController,
    getSelectedProject: () => ({ id: 'project' }),
    isDisposed: () => false,
  });
  const runs = [];
  coordinator.identityFor = () => ({});
  coordinator.handleAnalyzeCleanup = async (options = {}) => {
    runs.push(options.background === true ? 'background' : 'foreground');
    return true;
  };
  return { coordinator, runs };
}

test('a stopped usage coordinator starts no background scan, queued or already scheduling', async () => {
  let finishLookup;
  const waiting = usageFixture(() => new Promise((resolve) => { finishLookup = resolve; }));
  const scheduling = waiting.coordinator.requestBackgroundUsageRefresh({ force: true });
  await tick();
  waiting.coordinator.stopBackground();
  finishLookup({});
  await scheduling;
  assert.deepEqual(waiting.runs, [], 'the scheduler that was awaiting the controller stopped');

  const queued = usageFixture(async () => ({}));
  queued.coordinator.pendingBackgroundRequest = { force: true };
  queued.coordinator.stopBackground();
  queued.coordinator.triggerPendingBackgroundRefresh();
  await queued.coordinator.requestBackgroundUsageRefresh({ force: true });
  await tick();
  assert.deepEqual(queued.runs, [], 'the internal drain and new requests start nothing');

  await queued.coordinator.handleAnalyzeCleanup();
  assert.deepEqual(queued.runs, ['foreground'], 'a foreground analysis still runs');
});

test('the panel stops the usage coordinator queue on failure', async (t) => {
  globalThis.__BUILD_TIME__ = 'test';
  const store = { get: () => undefined, update: async () => {} };
  let dispose;
  const panel = new DashboardPanel({
    getSetting: (_key, fallback) => fallback, globalState: store, workspaceState: store, log() {},
    onDidChangeSetting: () => ({ dispose() {} }),
  }, { postMessage() {}, onDidReceiveMessage() {}, onDidDispose: (listener) => { dispose = listener; } },
  { extensionVersion: 'test', integrationTestMode: false });
  t.after(() => dispose());
  panel.usageCoordinator.pendingBackgroundRequest = { force: true };
  panel.handleMessage = async () => { throw new Error('x'); };
  await panel.handle({ type: 'refresh' });
  assert.equal(panel.usageCoordinator.pendingBackgroundRequest, undefined);
  assert.equal(panel.usageCoordinator.backgroundStopped, true);
});

test('a reconciliation failure that escapes the host reaches the reporter, and runs continue', async () => {
  const scheduled = [];
  const scheduler = { setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; }, clearTimeout() {} };
  const errors = [];
  let attempts = 0;
  const coordinator = new BranchChangeCoordinator(scheduler, {
    isMutationBusy: () => false,
    reconcile: async (generation) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('picker broke');
      coordinator.claim(generation);
    },
    onError: (error) => errors.push(error.name),
  }, 0);
  coordinator.notify();
  scheduled.shift()();
  await tick();
  assert.deepEqual(errors, ['TypeError']);
  coordinator.notify();
  scheduled.shift()();
  await tick();
  assert.equal(attempts, 2, 'a later HEAD change still reconciles');
});

test('load-upgrade-targets failing during controller lookup ends the loading state', async (t) => {
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
  panel.deliveryReady = true;
  panel.ensureController = async () => { throw new TypeError('lookup broke at /Users/me'); };
  await panel.handle({ type: 'load-upgrade-targets', package: 'left-pad', requestId: 'targets-1' });
  const answer = posted.find((message) => message.status === 'upgrade-targets-error');
  assert.ok(answer, `answered: ${JSON.stringify(posted)}`);
  assert.equal(answer.requestId, 'targets-1');
  assert.equal(answer.package, 'left-pad');
  assert.doesNotMatch(answer.error.message, /Users|lookup/);
  assert.equal(panel.upgradeCoordinator.upgradeTargetsLoad, undefined, 'the load record was dropped');
  assert.equal(posted.filter((message) => message.status === 'runtime-error').length, 1);
});

test('a failed confirmation is answered for the review it named, with an unknown outcome', async (t) => {
  globalThis.__BUILD_TIME__ = 'test';
  const store = { get: () => undefined, update: async () => {} };
  const posted = [];
  let dispose;
  const panel = new DashboardPanel({
    getSetting: (_key, fallback) => fallback, globalState: store, workspaceState: store, log() {},
    onDidChangeSetting: () => ({ dispose() {} }),
  }, { postMessage: (message) => posted.push(message), onDidReceiveMessage() {}, onDidDispose: (listener) => { dispose = listener; } },
  { extensionVersion: 'test', integrationTestMode: false });
  t.after(() => dispose());
  panel.deliveryReady = true;
  const coordinator = panel.upgradeCoordinator;
  coordinator.removal = { id: 'removal', reservationKey: 'react', expiresAt: Date.now() + 60_000 };
  coordinator.handleConfirmRemove = async () => {
    coordinator.removal = undefined;
    throw new Error('transaction bookkeeping broke');
  };
  await panel.handle({ type: 'confirm-remove', analysisId: 'removal' });
  const answer = posted.find((message) => message.status === 'remove-error');
  assert.equal(answer.package, 'react');
  assert.equal(answer.error.code, 'UNKNOWN');
});

test('a link the editor did not open is logged and reported once', async () => {
  const require = createRequire(import.meta.url);
  const shown = [];
  const vscode = {
    env: { openExternal: async () => false },
    Uri: { parse: (value) => value, joinPath: (...parts) => ({ fsPath: parts.join('/') }) },
    window: {
      createOutputChannel: () => ({ warn: (line) => shown.push(['log', line]), dispose() {} }),
      showErrorMessage: async (message) => { shown.push(['error', message]); },
    },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  try {
    const { VsCodePlatform } = require('../out/host/platform/vscode/vsCodePlatform.js');
    const platform = Object.create(VsCodePlatform.prototype);
    platform.openExternal('https://example.com/advisory');
    await tick();
  } finally {
    Module._load = load;
  }
  assert.deepEqual(shown, [
    ['log', 'runtime: open-link failed (Error)'],
    ['error', 'Packageawy could not open the link. The Packageawy log has the details.'],
  ]);
});

test('a handler result with a throwing then getter cannot escape', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  try {
    fireAndForget(Promise.reject(new Error('first')), () => ({
      get then() { throw new Error('getter broke'); },
    }));
    await tick();
    await tick();
  } finally {
    console.error = original;
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(lines.length, 1);
});

test('a background cleanup stopped while its own controller lookup waits starts no discovery', async () => {
  let discoveries = 0;
  const messages = [];
  const controller = {
    root: '/workspace',
    upgradeSource: {
      manifestText: JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.0.0' } }),
      lockfileText: null, lockfilePath: null, packageManager: 'npm', importerId: '.',
    },
    lastResultRows: () => [{ name: 'lodash' }],
  };
  let lookups = 0;
  let releaseSecond;
  const coordinator = new UsageAnalysisCoordinator({
    platform: {
      findFiles: async () => { discoveries += 1; return []; },
      statFile: async () => ({ size: 0 }),
      readFile: async () => new Uint8Array(),
      withProgress: async (_title, run) => run({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      getSetting: (_key, fallback) => fallback,
    },
    sink: { postMessage: (message) => messages.push(message) },
    ensureController: () => {
      lookups += 1;
      // The scheduler's lookup answers at once. The cleanup's own lookup waits.
      if (lookups === 2) return new Promise((resolve) => { releaseSecond = () => resolve(controller); });
      return Promise.resolve(controller);
    },
    getSelectedProject: () => ({
      id: 'project', dir: '', relativePath: 'package.json', manifestPath: '/workspace/package.json',
      folder: { id: 'file:///workspace', name: 'workspace', path: '/workspace' },
    }),
    isDisposed: () => false,
  });
  const scheduling = coordinator.requestBackgroundUsageRefresh({ force: true });
  while (releaseSecond === undefined) await tick();
  coordinator.stopBackground();
  releaseSecond();
  await scheduling;
  assert.equal(discoveries, 0, 'no source or config discovery ran');
  assert.deepEqual(messages.filter((message) => message.status === 'cleanup-result'), []);

  assert.equal(await coordinator.handleAnalyzeCleanup(), true, 'a foreground cleanup still completes');
  assert.ok(discoveries > 0);
  assert.equal(messages.filter((message) => message.status === 'cleanup-result').length, 1);
});

function settlementPanel(t) {
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
  panel.deliveryReady = true;
  return { panel, posted };
}

test('a retried fix whose controller lookup throws ends with an error for that package', async (t) => {
  const { panel, posted } = settlementPanel(t);
  const coordinator = panel.upgradeCoordinator;
  coordinator.remediationPlans.set('fix', { id: 'fix', packageName: 'lodash' });
  coordinator.remediationPlanByPackage.set('lodash', 'fix');
  panel.ensureController = async () => { throw new TypeError('lookup broke'); };
  await panel.handle({ type: 'retry-remediation', analysisId: 'fix' });
  assert.equal(coordinator.remediationPlans.has('fix'), false, 'the retry consumed the plan');
  const answer = posted.find((message) => message.status === 'remediation-error');
  assert.ok(answer, JSON.stringify(posted));
  assert.equal(answer.package, 'lodash');
});

test('a dependency data retry that fails to start ends as failed and can be retried', async (t) => {
  const { panel, posted } = settlementPanel(t);
  panel.mutationEnrichment = { refreshId: 'refresh-1', packageName: 'left-pad', state: 'failed' };
  panel.controller = {
    refreshInBackground: () => { throw new TypeError('refresh broke'); },
    dispose() {},
  };
  await panel.handle({ type: 'retry-upgrade-enrichment', refreshId: 'refresh-1' });
  const answer = posted.find((message) => message.status === 'upgrade-enrichment-result');
  assert.deepEqual([answer?.refreshId, answer?.package, answer?.outcome], ['refresh-1', 'left-pad', 'failed']);
  assert.equal(panel.mutationEnrichment.state, 'failed');
});

test('a dependency data refresh that rejects in the background ends as failed', async (t) => {
  const { panel, posted } = settlementPanel(t);
  panel.mutationEnrichment = { refreshId: 'refresh-2', packageName: 'left-pad', state: 'failed' };
  panel.controller = {
    refreshInBackground: async () => { throw new TypeError('refresh broke'); },
    dispose() {},
  };
  await panel.handle({ type: 'retry-upgrade-enrichment', refreshId: 'refresh-2' });
  await tick();
  const answer = posted.find((message) => message.status === 'upgrade-enrichment-result');
  assert.deepEqual([answer?.refreshId, answer?.outcome], ['refresh-2', 'failed']);
  assert.equal(panel.mutationEnrichment.state, 'failed');
  assert.equal(panel.runtimeFailed, false, 'a failed data refresh does not pause changes');
});
