import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPanel } from '../out/host/dashboardPanel.js';
import { inspectRecovery } from '../out/host/recovery/inspection.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { appHarness } from './helpers/app-harness.mjs';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ['webview/src/components/SmartCleanupWorkspace.tsx'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { SmartCleanupWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const packages = ['chalk', 'is-number', 'lodash'];
const actionIds = packages.map(name => `remove-direct:${name}`);
const dependencies = Object.fromEntries(packages.map(name => [name, '^1.0.0']));
const json = body => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: 0 });
function lockfile(removed = false) {
  return JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {
    '': { name: 'fixture', dependencies: removed ? {} : dependencies },
    ...Object.fromEntries((removed ? [] : packages).map(name => [`node_modules/${name}`, { version: '1.0.0' }])),
  } });
}
const workspace = view => view.find('SmartCleanupWorkspace');
const html = view => renderToStaticMarkup(createElement(SmartCleanupWorkspace, workspace(view).props));

/** Real disk reads, panel reloads, controller scans, transaction and App handler.
 * Only registry/audit IO, usage inputs and the package-manager process are fake.
 */
async function fixture(t, { autoClose = false, watcher = 'stable', hostKind = 'vscode', installFails = false } = {}) {
  globalThis.__BUILD_TIME__ = 'test';
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-final-refresh-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'package.json'), lockfilePath = path.join(root, 'package-lock.json');
  await writeFile(manifestPath, JSON.stringify({ name: 'fixture', dependencies }));
  await writeFile(lockfilePath, lockfile());
  const view = appHarness(t), posted = [], watches = [], tasks = [], scanOutcomes = [];
  let dispose, finalScans = 0, terminalCloses = 0;
  const values = new Map(), store = { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } };
  const folder = { id: root, name: 'fixture', path: root };
  const platform = {
    hostKind, workspaceFolders: () => [folder], isWorkspaceTrusted: () => true,
    findFiles: async () => [lockfilePath], readFile: filePath => readFile(filePath),
    getSetting: (_key, fallback) => fallback, globalState: store, workspaceState: store,
    onDidChangeSetting: () => ({ dispose() {} }), log() {},
    watchFiles: (baseDir, glob, listener) => {
      const watch = { baseDir, glob, listener, active: true }; watches.push(watch);
      return { dispose() { watch.active = false; } };
    },
    watchGitHead: async () => undefined,
    showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {},
    showModalWarning: async () => undefined,
    async runProcess(request) {
      tasks.push(request);
      assert.ok(request.args.includes('install'));
      assert.equal(request.cwd, root);
      await writeFile(lockfilePath, lockfile(!installFails));
      return { onDidExit(listener) {
        let observing = true;
        setImmediate(() => {
          listener(installFails ? 1 : 0);
          // Simulate the other change set's terminal auto-close after success.
          // A late undefined exit cannot replace the settled process result.
          if (autoClose) { terminalCloses++; if (observing) listener(undefined); }
        });
        return { dispose() { observing = false; } };
      } };
    },
  };
  const panel = new DashboardPanel(platform, {
    postMessage: message => { assert.ok(isHostToWebviewMessage(message), JSON.stringify(message)); posted.push(message); view.event(message); },
    onDidReceiveMessage() {}, onDidDispose: listener => { dispose = listener; }, reveal() {},
  }, { extensionVersion: 'test', integrationTestMode: false });
  t.after(() => dispose());
  panel.deliveryReady = true;
  // Background usage is outside this test. App receives the same reviewed
  // findings a completed usage/impact run would provide below.
  panel.requestAutomaticUsageRefresh = () => {};
  panel.httpClient = { get: async () => json({ version: '1.0.0' }), post: async () => json({}) };
  panel.auditRunner = { async run() {
    if (tasks.length > 0) {
      finalScans++;
      if ((watcher === 'late' && finalScans === 1) || watcher === 'persistent') {
        // Audit is pending inside the real final scan. Deliver a watcher
        // event after a microtask so beginRevalidation supersedes that scan.
        await Promise.resolve();
        const watch = watches.findLast(item => item.active && item.glob.includes('package-lock.json'));
        assert.ok(watch);
        assert.equal(watch.baseDir, root);
        watch.listener(lockfilePath);
      }
    }
    return { stdout: JSON.stringify({ vulnerabilities: {} }), exitCode: 0 };
  } };
  const candidate = { id: 'project', folderId: root, folderName: 'fixture', dir: '', manifestPath: 'package.json', folder };
  await panel.reloadAndScan(candidate, { strict: true });
  assert.equal(panel.controller.lastResultSnapshot().rows.length, 3);
  const controller = panel.controller, refresh = controller.refreshInBackground.bind(controller);
  controller.refreshInBackground = async (...args) => { const outcome = await refresh(...args); scanOutcomes.push(outcome.status); return outcome; };
  const coordinator = panel.upgradeCoordinator;
  coordinator.options.smartCleanupRemovalEvidence = () => ({ isCurrent: () => true });
  coordinator.options.getSmartCleanupDeprecationEvidence = () => ({ deprecatedPackages: [], installedVersions: Object.fromEntries(packages.map(name => [name, '1.0.0'])) });
  view.find('Dashboard').props.onOpenSmartCleanup(); view.render();
  const requestId = view.sent.findLast(message => message.type === 'analyze-smart-cleanup-metadata').requestId;
  view.event({ status: 'cleanup-result', analyzedAt: new Date().toISOString(), cacheExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    findings: packages.map(packageName => ({ packageName, kind: 'likely-unused', confidence: 'high', severity: 'info', summary: 'No usage found.',
      evidence: { kind: 'likely-unused', reason: 'No usage found.', scannedFileCount: 1, truncated: false } })) });
  const impact = view.sent.findLast(message => message.type === 'analyze-removal-impact');
  view.event({ status: 'removal-impact-result', requestId: impact.requestId, packages, generatedAt: new Date().toISOString(),
    assessments: packages.map(packageName => ({ packageName, usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } })) });
  view.event({ status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } });
  workspace(view).props.dispatch({ type: 'show-confirmation' }); view.render();
  workspace(view).props.onPrepareRemoval(actionIds); view.render();
  await coordinator.handleAnalyzeSmartCleanupRemove(view.sent.findLast(message => message.type === 'smart-cleanup-remove'));
  const analysis = posted.findLast(message => message.status === 'remove-analysis');
  assert.ok(analysis, JSON.stringify(posted.at(-1)));
  workspace(view).props.onConfirmRemoval(analysis.analysis.analysisId); view.render();
  await coordinator.handleConfirmRemove(view.sent.findLast(message => message.type === 'confirm-remove'));
  const result = posted.findLast(message => message.status === 'remove-result')?.result;
  assert.ok(result, JSON.stringify(posted.at(-1)));
  return { root, manifestPath, lockfilePath, view, result, coordinator, scanOutcomes, tasks, terminalCloses, finalScans, panel };
}

async function assertSuccess(f, autoClose) {
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies, {});
  const lock = JSON.parse(await readFile(f.lockfilePath, 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, {});
  for (const name of packages) assert.equal(lock.packages[`node_modules/${name}`], undefined);
  assert.equal(f.tasks.length, 1, 'three removals share one reconciliation task');
  assert.equal(f.terminalCloses, Number(autoClose));
  assert.equal(f.result.outcome, 'verified');
  assert.deepEqual(f.result.smartCleanup.completedActionIds, actionIds);
  assert.deepEqual(f.result.smartCleanup.failedActionIds, []);
  assert.deepEqual(f.result.smartCleanup.skippedActionIds, []);
  assert.equal(f.result.restoreAvailable, true);
  assert.equal(workspace(f.view).props.state.phase, 'complete');
  assert.equal(workspace(f.view).props.state.restore.status, 'available');
  const rendered = html(f.view);
  assert.match(rendered, /Cleanup done/);
  assert.match(rendered, /3 packages removed/);
  assert.match(rendered, />Undo cleanup</);
  assert.doesNotMatch(rendered, /Cleanup needs attention|manual review|Failed actions/);
  const backup = f.coordinator.cleanupBackups.get(f.result.analysisId);
  assert.ok(backup);
  assert.notEqual(backup.available, false);
  assert.match(backup.target.allowlistedPaths[0], /[\\/]package\.json$/);
  assert.equal((await inspectRecovery(backup.target)).view.state, 'undo-available');
  await f.coordinator.handleRestoreSmartCleanup({ analysisId: f.result.analysisId });
  assert.equal(f.view.find('RecoveryScreen').props.recovery.state, 'undo-available');
  f.view.find('RecoveryScreen').props.close(); f.view.render();
}

for (const hostKind of ['vscode', 'jetbrains']) for (const autoClose of [true, false]) for (const watcher of ['stable', 'late']) {
  test(`${hostKind}: auto-close ${autoClose}, ${watcher} final watcher preserves three successful removals and Undo`, async t => {
    const f = await fixture(t, { hostKind, autoClose, watcher });
    await assertSuccess(f, autoClose);
    assert.equal(f.result.smartCleanup.status, 'verified');
    assert.deepEqual(f.scanOutcomes, watcher === 'late' ? ['superseded', 'succeeded'] : ['succeeded']);
    assert.equal(f.finalScans, watcher === 'late' ? 2 : 1);
    assert.doesNotMatch(html(f.view), /Final dashboard counts could not be refreshed/);
  });
}

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind}: persistent supersession is bounded and keeps confirmed removals with a metrics caveat`, async t => {
  const f = await fixture(t, { hostKind, watcher: 'persistent' });
  await assertSuccess(f, false);
  assert.equal(f.result.smartCleanup.status, 'partial');
  assert.deepEqual(f.scanOutcomes, ['superseded', 'superseded']);
  assert.equal(f.finalScans, 2);
  assert.deepEqual(f.result.smartCleanup.metrics, []);
  assert.match(html(f.view), /Final dashboard counts could not be refreshed\. Analyze the current project to update them\./);
  assert.equal(workspace(f.view).props.state.result.metricsNote, f.result.smartCleanup.reason);
});

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind}: missing metrics never turns a restored cleanup into failed removals or success`, async t => {
  const f = await fixture(t, { hostKind, watcher: 'persistent', installFails: true });
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')).dependencies, dependencies);
  assert.equal(f.result.outcome, 'rolled-back');
  assert.deepEqual(f.result.smartCleanup.completedActionIds, []);
  assert.deepEqual(f.result.smartCleanup.failedActionIds, []);
  assert.deepEqual(f.result.smartCleanup.skippedActionIds, actionIds);
  assert.equal(f.result.restoreAvailable, undefined);
  assert.equal(workspace(f.view).props.state.phase, 'cancelled-rolled-back');
  assert.match(html(f.view), /Dependency files restored/);
  assert.doesNotMatch(html(f.view), /Cleanup done|3 packages removed|Undo cleanup|Failed actions/);
});

for (const change of ['project', 'controller', 'disposed', 'stopped']) test(`superseded final refresh never retries after ${change} changes`, async () => {
  const candidate = {}, controller = {}, panel = Object.create(DashboardPanel.prototype);
  Object.assign(panel, { selectedProject: candidate, controller, disposed: false, backgroundStopped: false });
  let calls = 0;
  panel.reloadAndScan = async () => {
    calls++;
    if (change === 'project') panel.selectedProject = {};
    if (change === 'controller') panel.controller = {};
    if (change === 'disposed') panel.disposed = true;
    if (change === 'stopped') panel.backgroundStopped = true;
    return { status: 'superseded' };
  };
  assert.equal(await panel.reloadAndCaptureFinalState(), undefined);
  assert.equal(calls, 1);
});

for (const status of ['failed', 'cancelled']) test(`${status} final refresh is not retried`, async () => {
  const panel = Object.create(DashboardPanel.prototype);
  let calls = 0;
  Object.assign(panel, { selectedProject: {}, controller: {}, disposed: false,
    reloadAndScan: async () => { calls++; return { status }; } });
  assert.equal(await panel.reloadAndCaptureFinalState(), undefined);
  assert.equal(calls, 1);
});

for (const change of ['project', 'controller']) test(`successful retry discards evidence if ${change} changed during the retry`, async () => {
  const panel = Object.create(DashboardPanel.prototype);
  let calls = 0;
  Object.assign(panel, { selectedProject: {}, controller: { lastResultEvidence() { assert.fail('must not use another project or controller'); } }, disposed: false,
    reloadAndScan: async () => {
      if (++calls === 1) return { status: 'superseded' };
      if (change === 'project') panel.selectedProject = {};
      else panel.controller = {};
      return { status: 'succeeded' };
    } });
  assert.equal(await panel.reloadAndCaptureFinalState(), undefined);
  assert.equal(calls, 2);
});
