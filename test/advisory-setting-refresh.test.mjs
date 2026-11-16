import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardPanel } from '../out/host/dashboardPanel.js';

// Exercise the real setting subscription and message dispatcher. Replace only
// the operation and reload boundaries so no disk or network scan is needed.
for (const type of ['upgrade', 'analyze-remediation']) {
  test(`setting refresh waits for ${type} to settle and coalesces changes`, async () => {
    globalThis.__BUILD_TIME__ = 'test';
    let settingChanged;
    let dispose;
    const store = { get: () => undefined, update: async () => {} };
    const panel = new DashboardPanel({
      getSetting: (_, fallback) => fallback, globalState: store, workspaceState: store,
      onDidChangeSetting: (_, listener) => { settingChanged = listener; return { dispose() {} }; },
    }, { postMessage() {}, onDidReceiveMessage() {}, onDidDispose: listener => { dispose = listener; } },
    { extensionVersion: 'test', integrationTestMode: false });
    const coordinator = panel.upgradeCoordinator;
    let busy = false;
    let settle;
    let started;
    const start = new Promise(resolve => { started = resolve; });
    const work = new Promise(resolve => { settle = resolve; });
    const run = async () => { busy = true; started(); await work; busy = false; };
    coordinator.isBusy = () => busy && type === 'upgrade';
    coordinator.isRemediationBusy = () => busy && type !== 'upgrade';
    coordinator.handleAnalyzeUpgrade = run;
    coordinator.handleAnalyzeRemediation = run;
    const scans = [];
    let invalidations = 0;
    panel.controller = { root: '/fixture', upgradeSource: { lockfilePath: null }, handleAdvisorySettingChanged: () => invalidations++, dispose() {} };
    panel.selectedProject = { id: 'fixture' };
    panel.reloadAndScan = async () => {
      assert.equal(busy, false, 'the refresh runs after active work settles');
      scans.push('scan');
    };
    try {
      const pending = panel.handle({ type, package: 'app', packages: ['app'], requestId: 'review', target: '2.0.0' });
      await start;
      settingChanged();
      settingChanged();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(scans, []);
      assert.equal(invalidations, 2, 'controller evidence is invalidated immediately');
      settle();
      await pending;
      assert.deepEqual(scans, ['scan'], 'one corrective refresh is retained');
      await panel.handle({ type: 'cancel-remediation-analysis' });
      assert.deepEqual(scans, ['scan'], 'later messages do not repeat the refresh');
    } finally {
      settle();
      dispose();
    }
  });
}

test('a setting refresh queued behind another panel change runs when the shared lock is released', async () => {
  globalThis.__BUILD_TIME__ = 'test';
  let settingChanged;
  const store = { get: () => undefined, update: async () => {} };
  const panel = new DashboardPanel({
    getSetting: (_, fallback) => fallback, globalState: store, workspaceState: store,
    onDidChangeSetting: (_, listener) => { settingChanged = listener; return { dispose() {} }; },
  }, { postMessage() {}, onDidReceiveMessage() {}, onDidDispose() {} },
  { extensionVersion: 'test', integrationTestMode: false });
  const coordinator = panel.upgradeCoordinator;
  let otherPanelHoldsLock = true;
  coordinator.isBusy = () => otherPanelHoldsLock;
  coordinator.isRemediationBusy = () => false;
  const scans = [];
  panel.controller = { root: '/fixture', upgradeSource: { lockfilePath: null }, handleAdvisorySettingChanged() {}, dispose() {} };
  panel.selectedProject = { id: 'fixture' };
  panel.reloadAndScan = async () => { scans.push('scan'); };
  await settingChanged();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scans, [], 'no refresh while the other panel holds the lock');
  otherPanelHoldsLock = false;
  coordinator.options.onMutationLockReleased();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scans, ['scan'], 'the queued refresh runs on lock release');
});
