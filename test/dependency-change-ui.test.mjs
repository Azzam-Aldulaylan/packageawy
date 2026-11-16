import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RECOVERY_MESSAGES } from '../out/host/recoveryCopy.js';
import { makeProject, makeCoordinator, review } from './helpers/removal-project.mjs';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { RpcPlatform } from '../out/host/platform/rpc/rpcPlatform.js';

const require = createRequire(import.meta.url);
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hooks = { slots: [], cursor: 0, deps: [], effects: [], active: false };
globalThis.__dependencyHooks = hooks;
const sent = []; const listeners = new Map();
globalThis.acquireVsCodeApi = () => ({ postMessage: m => sent.push(m), getState() {}, setState() {} });
globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.document = { body: { dataset: {} } };
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  export { App } from './webview/src/App.tsx';
  export { DependencyChangeContext, DependencyChangeStatus } from './webview/src/components/DependencyChangeStatus.tsx';
  export { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
` }, bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'app-hooks', setup(plugin) {
  plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'dependency' }));
  plugin.onLoad({ filter: /.*/, namespace: 'dependency' }, () => ({ loader: 'js', contents: `
    export * from '${reactUrl}';
    import * as React from '${reactUrl}';
    const h = globalThis.__dependencyHooks;
    export const useState = initial => {
      if (!h.active) return React.useState(initial);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[i], next => h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next];
    };
    export const useRef = initial => {
      if (!h.active) return React.useRef(initial);
      const i = h.cursor++; return h.slots[i] ??= { current: initial };
    };
    export const useReducer = (reducer, initial, init) => {
      if (!h.active) return React.useReducer(reducer, initial, init);
      const [state, set] = useState(() => init ? init(initial) : initial);
      return [state, event => set(previous => reducer(previous, event))];
    };
    export const useEffect = (effect, deps) => {
      if (!h.active) return React.useEffect(effect, deps);
      const i = h.cursor++;
      if (!h.deps[i] || deps.some((v, j) => v !== h.deps[i][j])) { h.deps[i] = deps; h.effects.push(effect); }
    };
    export const useMemo = (fn, deps) => h.active ? fn() : React.useMemo(fn, deps);
    export const useCallback = (fn, deps) => h.active ? fn : React.useCallback(fn, deps);
  ` }));
  plugin.onResolve({ filter: /^react\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  plugin.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
} }] });
const { App, DependencyChangeContext, DependencyChangeStatus, ManageDependencyModal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function appFixture() {
  hooks.slots = []; hooks.deps = []; sent.length = 0; listeners.clear();
  const tree = () => {
    hooks.cursor = 0; hooks.effects = []; hooks.active = true;
    let node;
    try { node = App(); } finally { hooks.active = false; }
    hooks.effects.forEach(effect => effect());
    return node;
  };
  tree();
  return { tree, receive: message => listeners.get('message')({ data: message, origin: '', source: null }), html: () => renderToStaticMarkup(tree()) };
}
const emptyRecovery = state => ({ status: 'recovery', recovery: { state, message: state === 'none' ? '' : RECOVERY_MESSAGES.blocked, claim: null, canApply: false, canDismiss: false, files: [] } });

for (const mode of ['missing-result', 'launch-rejection', 'platform-disposal', 'disconnect', 'timeout']) test(`${mode} reaches the same blocked dashboard with a working recovery link`, async t => {
  const project = await makeProject(t); const locks = new ProjectMutationLocks(); let closed;
  const connection = { sendRequest: async () => null, sendNotification() {}, onNotification() {}, onClose(listener) { closed = listener; return { dispose() {} }; } };
  const rpc = new RpcPlatform(connection, { workspaceFolders: [], isWorkspaceTrusted: true, settings: {}, workspaceState: {}, globalState: {} });
  const platform = { getSetting: (_key, fallback) => fallback, isWorkspaceTrusted: () => true,
    showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {},
    runProcess: async () => {
      if (mode === 'launch-rejection') throw new Error('launch may have started');
      if (mode === 'timeout') throw Object.assign(new Error('task result timed out'), { name: 'TimeoutError' });
      if (mode === 'disconnect' || mode === 'platform-disposal') {
        const running = await rpc.runProcess({ executable: 'node', args: [], cwd: project.root, title: 'change', scope: 'test' });
        setImmediate(() => mode === 'disconnect' ? closed() : rpc.dispose());
        return running;
      }
      return { onDidExit(listener) { setImmediate(() => listener(undefined)); return { dispose() {} }; } };
    },
  };
  const f = makeCoordinator(project, { platform, mutationLocks: locks });
  f.coordinator.session.invocationResolver = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
  const id = await review(f);
  await f.coordinator.handleConfirmRemove({ analysisId: id });
  const error = f.messages.find(m => m.status === 'remove-error');
  assert.equal(error.error.code, 'OUTCOME_UNKNOWN');
  const app = appFixture();
  app.receive({ status: 'dependency-task', state: 'still-running' });
  app.receive(error);
  let html = app.html();
  assert.match(html, /An earlier change may still be running. Dependency changes are blocked/);
  assert.equal((html.match(/Start recovery/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Couldn't remove|Still running\./);
  // Arrival of the detailed journal keeps the choice on screen.
  app.receive(emptyRecovery('blocked'));
  html = app.html(); assert.doesNotMatch(html, /<h1[^>]*>Dependency recovery/);
  app.tree().props.value.openRecovery();
  assert.deepEqual(sent.at(-1), { type: 'inspect-recovery' });
  assert.match(app.html(), /Dependency recovery/);
});

test('Still running renders once and terminal task states remove it', () => {
  const app = appFixture();
  app.receive({ status: 'dependency-task', state: 'running' });
  assert.doesNotMatch(app.html(), /Still running\./);
  app.receive({ status: 'dependency-task', state: 'still-running' });
  const html = app.html();
  assert.equal((html.match(/Still running\./g) ?? []).length, 1);
  assert.match(html, /will not roll back or start another change on this project until it finishes/);
  app.receive({ status: 'dependency-task', state: 'idle' });
  assert.doesNotMatch(app.html(), /Still running\./);
});

const noop = () => {};
const props = { row: { name: 'react', current: '18.2.0', range: '^18', dev: false, advisories: [], worstSeverity: 'none', upgradeTo: null }, allRows: [],
  hygieneFindings: [], removalImpact: { phase: 'idle' }, activeTab: 'upgrade', actionsDisabled: true, upgradeDisabled: true, updateResolutionAvailable: true,
  advisoriesAvailable: true, blockClose: false, upgradeResult: null, upgradeEnrichment: null,
  upgrade: { targetVersion: null, targetState: { phase: 'idle' }, active: false, analyzingPhase: null, analysis: null, sections: {}, hardStale: false, busy: false, error: null,
    onAnalyze: noop, onTargetChange: noop, onConfirm: noop, onUseSmartPlan: noop, onCancel: noop, onConfigureVerification: noop, onRefresh: noop },
  removal: { active: false, analysis: null, busy: false, error: null, onAnalyze: noop, onConfirm: noop, onConfigureVerification: noop },
  onChangeTab: noop, onAnalyzeRemediation: noop, onReviewRemediation: noop, onApplyRemediation: noop, onCancelRemediation: noop, onRetryRemediation: noop, onOpenAdvisory: noop,
  onReanalyzeUsage: noop, onOpenUsageReference: noop, onRetryUpgradeEnrichment: noop, now: Date.now(), onClose: noop };

test('Upgrade screen renders the shared blocked recovery action and long-running explanation', () => {
  for (const blocked of [false, true]) {
    const html = renderToStaticMarkup(createElement(DependencyChangeContext.Provider, { value: { task: 'still-running', blocked, openRecovery: noop } }, createElement(ManageDependencyModal, props)));
    assert.equal((html.match(blocked ? /Dependency changes are blocked/g : /Still running\./g) ?? []).length, 1);
    assert.equal(html.includes('Start recovery'), blocked);
  }
  assert.equal(renderToStaticMarkup(createElement(DependencyChangeContext.Provider, { value: { task: 'idle', blocked: false, openRecovery: noop } }, createElement(DependencyChangeStatus))), '');
});

for (const status of ['upgrade-error', 'remove-error', 'remediation-error']) test(`${status} uses the blocked presentation without a duplicate failure`, () => {
  const app = appFixture();
  app.receive({ status, package: 'react', error: { code: 'OUTCOME_UNKNOWN', message: RECOVERY_MESSAGES.blocked } });
  const html = app.html();
  assert.equal((html.match(/Dependency changes are blocked/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Couldn't upgrade|Couldn't remove|Couldn't check/);
});

test('saved completed recovery and discovery failures retain their specific explanation', () => {
  const app = appFixture();
  app.receive({ ...emptyRecovery('completed'), recovery: { ...emptyRecovery('completed').recovery, message: RECOVERY_MESSAGES.completed } });
  assert.match(app.html(), /Recovery completed. Review the result before removing saved files/);
  app.receive({ ...emptyRecovery('discovery-error'), recovery: { ...emptyRecovery('discovery-error').recovery, message: RECOVERY_MESSAGES.discoveryFailed } });
  const html = app.html();
  assert.match(html, /Could not check for saved recovery files/);
  assert.equal((html.match(/>Retry discovery</g) ?? []).length, 1);
  assert.doesNotMatch(html, /Start recovery/);
});

function component(node, name) {
  if (node == null || typeof node !== 'object') return null;
  if (node.type?.name === name) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = component(child, name);
    if (found !== null) return found;
  }
  return null;
}

function readyApp() {
  const app = appFixture();
  const generatedAt = new Date().toISOString();
  app.receive({ status: 'ready', data: {
    rows: [{ ...props.row, optional: false, worstSeverity: null, wanted: '18.2.0', latest: '19.0.0', upgradeTo: '19.0.0', upgradeReason: 'update' }],
    availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    generatedAt, project: { id: 'fixture', label: 'fixture', manifestPath: 'package.json' },
    canChangeProject: false, hygieneFindings: [], extensionVersion: 'test', builtAt: generatedAt,
  } });
  return app;
}

function startManageUpgrade(app) {
  component(app.tree(), 'Dashboard').props.onOpenManage('react');
  let manage = component(app.tree(), 'ManageDependencyModal');
  manage.props.onChangeTab('upgrade');
  manage = component(app.tree(), 'ManageDependencyModal');
  manage.props.upgrade.onAnalyze('19.0.0');
  assert.equal(sent.at(-1).type, 'upgrade');
  return sent.at(-1).requestId;
}

function completeUpgradeAnalysis(app, requestId, analysisId) {
  const now = Date.now();
  const change = { packageName: 'react', currentVersion: '18.2.0', targetVersion: '19.0.0', classification: 'prod', majorUpdate: true };
  app.receive({ status: 'upgrade-analysis', requestId, analysis: {
    analysisId, analyzedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    package: 'react', currentVersion: '18.2.0', targetVersion: '19.0.0', classification: 'prod', majorUpdate: true, changes: [change],
    compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
    projectCompatibility: {
      identity: { packageName: 'react', currentVersion: '18.2.0', targetVersion: '19.0.0', requestId, sourceFingerprint: 'fixture' },
      analyzers: [], findings: [], startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(),
    },
    smartPlan: null, security: null, verification: { configured: false, suggestedScriptNames: [] },
    files: { manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json', rollbackAvailable: true },
  } });
  assert.equal(component(app.tree(), 'ManageDependencyModal').props.upgrade.analysis?.analysisId, analysisId);
}

test('an upgrade error from Manage appears only in its dialog', () => {
  const app = readyApp();
  const requestId = startManageUpgrade(app);
  app.receive({ status: 'upgrade-error', requestId, package: 'react', error: { code: 'UNKNOWN', message: 'The upgrade fixture failed.' } });
  const html = app.html();
  assert.match(html, /upgrade-review__error/);
  assert.equal((html.match(/The upgrade fixture failed\./g) ?? []).length, 1);
  assert.doesNotMatch(html, /Couldn(?:'|&#x27;)t upgrade/);
});

for (const correlation of ['requestId', 'analysisId']) for (const order of ['close then error', 'error then close']) test(`Manage dismisses its upgrade error for ${order} and after reopening by ${correlation}`, () => {
  const app = readyApp();
  const requestId = startManageUpgrade(app);
  if (correlation === 'analysisId') completeUpgradeAnalysis(app, requestId, 'manage-analysis');
  const fail = () => app.receive({ status: 'upgrade-error', [correlation]: correlation === 'requestId' ? requestId : 'manage-analysis', package: correlation === 'analysisId' ? 'unknown' : 'react', error: { code: 'UNKNOWN', message: 'Dismissed Manage failure.' } });
  if (order === 'error then close') {
    fail();
    assert.equal((app.html().match(/Dismissed Manage failure\./g) ?? []).length, 1);
  }
  component(app.tree(), 'ManageDependencyModal').props.onClose();
  if (order === 'close then error') fail();
  assert.doesNotMatch(app.html(), /Dismissed Manage failure/);
  component(app.tree(), 'Dashboard').props.onOpenManage('react');
  component(app.tree(), 'ManageDependencyModal').props.onChangeTab('upgrade');
  assert.doesNotMatch(app.html(), /Dismissed Manage failure/);
  component(app.tree(), 'ManageDependencyModal').props.upgrade.onAnalyze('19.0.0');
  const nextRequestId = sent.at(-1).requestId;
  assert.notEqual(nextRequestId, requestId);
  fail();
  assert.equal(component(app.tree(), 'ManageDependencyModal').props.upgrade.active, true);
  assert.doesNotMatch(app.html(), /Dismissed Manage failure/);
  app.receive({ status: 'upgrade-error', requestId: nextRequestId, package: 'react', error: { code: 'UNKNOWN', message: 'New Manage failure.' } });
  assert.equal((app.html().match(/New Manage failure\./g) ?? []).length, 1);
});

test('an upgrade error from dashboard bulk actions stays in the banner', () => {
  const app = readyApp();
  component(app.tree(), 'Dashboard').props.onOpenBulkActions();
  component(app.tree(), 'ManageDependenciesModal').props.onBulkUpgrade([
    { packageName: 'react', currentVersion: '18.2.0', targetVersion: '19.0.0', major: true },
  ]);
  assert.equal(sent.at(-1).type, 'bulk-upgrade');
  const requestId = sent.at(-1).requestId;
  app.receive({ status: 'upgrade-error', requestId, package: 'react', error: { code: 'UNKNOWN', message: 'The upgrade fixture failed.' } });
  const html = app.html();
  assert.match(html, /Couldn(?:'|&#x27;)t upgrade react: The upgrade fixture failed\./);
  assert.equal((html.match(/The upgrade fixture failed\./g) ?? []).length, 1);
});

test('a dashboard-origin upgrade error stays in the banner while Manage is open and after it closes', () => {
  const app = readyApp();
  component(app.tree(), 'Dashboard').props.onOpenBulkActions();
  component(app.tree(), 'ManageDependenciesModal').props.onBulkUpgrade([
    { packageName: 'react', currentVersion: '18.2.0', targetVersion: '19.0.0', major: true },
  ]);
  const requestId = sent.at(-1).requestId;
  component(app.tree(), 'Dashboard').props.onOpenManage('react');
  component(app.tree(), 'ManageDependencyModal').props.onChangeTab('upgrade');
  app.receive({ status: 'upgrade-error', requestId, package: 'react', error: { code: 'UNKNOWN', message: 'Dashboard failure during Manage.' } });
  assert.equal(component(app.tree(), 'ManageDependencyModal').props.upgrade.error, null);
  assert.match(app.html(), /Couldn(?:'|&#x27;)t upgrade react: Dashboard failure during Manage\./);
  component(app.tree(), 'ManageDependencyModal').props.onClose();
  assert.match(app.html(), /Dashboard failure during Manage/);
});

for (const correlation of [{}, { requestId: 'unknown-request' }, { analysisId: 'unknown-analysis' }]) test(`an unowned upgrade error keeps existing banner handling ${JSON.stringify(correlation)}`, () => {
  const app = readyApp();
  startManageUpgrade(app);
  app.receive({ status: 'upgrade-error', ...correlation, package: 'react', error: { code: 'UNKNOWN', message: 'Unowned upgrade failure.' } });
  assert.equal(component(app.tree(), 'ManageDependencyModal').props.upgrade.error, null);
  assert.match(app.html(), /Couldn(?:'|&#x27;)t upgrade react: Unowned upgrade failure\./);
});

for (const correlation of ['requestId', 'analysisId']) for (const lifecycle of ['closed', 'closed with newer request', 'superseded']) test(`a ${lifecycle} Manage request updates shared recovery by ${correlation} without changing newer local state`, () => {
  const app = readyApp();
  const requestId = startManageUpgrade(app);
  if (correlation === 'analysisId') completeUpgradeAnalysis(app, requestId, 'old-analysis');
  if (lifecycle === 'superseded') {
    app.receive({ status: 'upgrade-error', requestId, package: 'react', error: { code: 'UNKNOWN', message: 'Old failure.' } });
  } else {
    component(app.tree(), 'ManageDependencyModal').props.onClose();
  }
  let newerUpgrade;
  if (lifecycle !== 'closed') {
    const newerRequestId = startManageUpgrade(app);
    completeUpgradeAnalysis(app, newerRequestId, 'new-analysis');
    component(app.tree(), 'ManageDependencyModal').props.upgrade.onConfirm();
    newerUpgrade = component(app.tree(), 'ManageDependencyModal').props.upgrade;
    assert.equal(newerUpgrade.active, true);
    assert.equal(newerUpgrade.busy, true);
  }
  app.receive({ status: 'dependency-task', state: 'still-running' });
  assert.equal(app.tree().props.value.task, 'still-running');
  assert.equal((app.html().match(/Still running\./g) ?? []).length, 1);
  app.receive({ status: 'upgrade-error', [correlation]: correlation === 'requestId' ? requestId : 'old-analysis', package: 'react', error: { code: 'OUTCOME_UNKNOWN', message: RECOVERY_MESSAGES.blocked } });
  const tree = app.tree();
  assert.equal(tree.props.value.blocked, true);
  assert.equal(tree.props.value.task, 'idle');
  const html = app.html();
  assert.equal((html.match(/Dependency changes are blocked/g) ?? []).length, 1);
  assert.equal((html.match(/Start recovery/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Still running\.|Old failure|Couldn(?:'|&#x27;)t upgrade/);
  if (newerUpgrade !== undefined) {
    const upgrade = component(tree, 'ManageDependencyModal').props.upgrade;
    for (const key of ['active', 'busy', 'analysis', 'analyzingPhase', 'sections', 'error', 'targetVersion']) {
      assert.deepEqual(upgrade[key], newerUpgrade[key], `the newer request keeps ${key}`);
    }
  } else {
    assert.equal(component(tree, 'ManageDependencyModal'), null);
  }
  tree.props.value.openRecovery();
  assert.deepEqual(sent.at(-1), { type: 'inspect-recovery' });
  assert.match(app.html(), /Dependency recovery/);
});

test('shared task and recovery transitions apply after Manage closes while a newer request stays active', () => {
  const app = readyApp();
  startManageUpgrade(app);
  component(app.tree(), 'ManageDependencyModal').props.onClose();
  const requestId = startManageUpgrade(app);
  completeUpgradeAnalysis(app, requestId, 'current-analysis');
  component(app.tree(), 'ManageDependencyModal').props.upgrade.onConfirm();
  const analysis = component(app.tree(), 'ManageDependencyModal').props.upgrade.analysis;
  for (const [message, task, blocked] of [
    [{ status: 'dependency-task', state: 'still-running' }, 'still-running', false],
    [emptyRecovery('blocked'), 'idle', true],
    [emptyRecovery('none'), 'idle', false],
    [{ status: 'dependency-task', state: 'running' }, 'running', false],
    [{ status: 'dependency-task', state: 'idle' }, 'idle', false],
  ]) {
    app.receive(message);
    const tree = app.tree();
    assert.equal(tree.props.value.task, task);
    assert.equal(tree.props.value.blocked, blocked);
    const upgrade = component(tree, 'ManageDependencyModal').props.upgrade;
    assert.equal(upgrade.active, true);
    assert.equal(upgrade.busy, true);
    assert.deepEqual(upgrade.analysis, analysis);
  }
});

function preparedCleanupApp(start = true) {
  const app = appFixture();
  const generatedAt = new Date().toISOString();
  app.receive({ status: 'ready', data: {
    rows: [{ ...props.row, optional: false, worstSeverity: null, wanted: '18.2.0', latest: '18.2.0', upgradeReason: null }], availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    generatedAt, project: { id: 'fixture', label: 'fixture', manifestPath: 'package.json' },
    canChangeProject: false, hygieneFindings: [], extensionVersion: 'test', builtAt: generatedAt,
  } });
  component(app.tree(), 'Dashboard').props.onOpenSmartCleanup();
  app.receive({ status: 'cleanup-result', findings: [], analyzedAt: generatedAt, cacheExpiresAt: '2099-01-01T00:00:00.000Z' });
  let workspace = component(app.tree(), 'SmartCleanupWorkspace');
  assert.ok(workspace, 'Smart Cleanup is open');
  workspace.props.dispatch({ type: 'analysis-ready', requestId: workspace.props.state.requestId, plan: {
    planId: 'plan', requestId: workspace.props.state.requestId, projectName: 'fixture', generatedAt,
    recommendations: [{ id: 'remove-react', kind: 'remove-direct-dependency', packageName: 'react',
      dependencyType: 'production', confidence: 'safe', rationale: 'Unused', evidence: [] }], deprecated: [], security: [],
  } });
  // Use the shared preview request callback to supply the host evidence that
  // App requires before it records Smart Cleanup as this removal's origin.
  component(app.tree(), 'Dashboard').props.onOpenBulkActions();
  component(app.tree(), 'ManageDependenciesModal').props.onAnalyzeRemovalImpact(['react']);
  const request = sent.findLast(message => message.type === 'analyze-removal-impact');
  app.receive({ status: 'removal-impact-result', requestId: request.requestId, packages: ['react'], generatedAt,
    assessments: [{ packageName: 'react', usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } }] });
  component(app.tree(), 'ManageDependenciesModal').props.onClose();
  workspace = component(app.tree(), 'SmartCleanupWorkspace');
  workspace.props.dispatch({ type: 'show-confirmation' });
  component(app.tree(), 'SmartCleanupWorkspace').props.onPrepareRemoval(['remove-react']);
  assert.equal(sent.at(-1).type, 'smart-cleanup-remove');
  if (start) component(app.tree(), 'SmartCleanupWorkspace').props.dispatch({ type: 'execution-started', currentLabel: 'Applying cleanup' });
  return app;
}

test('Smart Cleanup open with an unknown outcome shows only the shared blocked presentation', () => {
  const app = preparedCleanupApp();
  app.receive({ status: 'remove-error', package: 'react', error: { code: 'OUTCOME_UNKNOWN', message: RECOVERY_MESSAGES.blocked } });
  const workspace = component(app.tree(), 'SmartCleanupWorkspace');
  assert.equal(workspace.props.state.phase, 'unknown');
  assert.equal(workspace.props.state.result, null);
  assert.equal(workspace.props.state.restore, null);
  assert.equal(workspace.props.state.execution, null);
  const html = app.html();
  assert.equal((html.match(/Dependency changes are blocked/g) ?? []).length, 1);
  assert.equal((html.match(/Start recovery/g) ?? []).length, 1);
  assert.doesNotMatch(html, /rollback|restor|\d+ (?:cleanup )?actions?|What changed|Failed actions|Removed dependencies/i);
  app.tree().props.value.openRecovery();
  assert.deepEqual(sent.at(-1), { type: 'inspect-recovery' });
  assert.match(app.html(), /Dependency recovery/);
});

test('unrecognized host messages render one protocol banner with no recovery or success implication', () => {
  const app = appFixture();
  app.receive({ status: 'future-status', token: 'secret', path: '/private/project/package.json' });
  app.receive({ status: 'future-status' });
  const html = app.html();
  assert.equal((html.match(/Packageawy received something it did not understand/g) ?? []).length, 1);
  assert.equal((html.match(/>Show Log</g) ?? []).length, 1);
  assert.equal((html.match(/>Reload</g) ?? []).length, 1);
  assert.doesNotMatch(html, /Start recovery|rollback|restored|success|secret|\/private\/project/);
  assert.equal(sent.filter(message => message.type === 'unhandled-host-message').length, 1);
});


test('Smart Cleanup displays each correlated host progress step', async t => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  const app = preparedCleanupApp(false);
  app.receive(fixture.messages.find(message => message.status === 'remove-analysis'));
  component(app.tree(), 'SmartCleanupWorkspace').props.onConfirmRemoval(analysisId);
  assert.equal(sent.at(-1).type, 'confirm-remove');
  for (const [phase, label] of [
    ['installing', 'Installing dependencies'],
    ['verifying', 'Verifying the project'],
    ['refreshing', 'Refreshing dependency data'],
  ]) {
    app.receive({ status: 'remove-progress', analysisId: 'unrelated', phase });
    assert.notEqual(component(app.tree(), 'SmartCleanupWorkspace').props.state.execution.currentLabel, label);
    app.receive({ status: 'remove-progress', analysisId, phase });
    assert.equal(component(app.tree(), 'SmartCleanupWorkspace').props.state.execution.currentLabel, label);
    const html = app.html();
    assert.ok(html.includes(`<p>${label}</p>`), 'the current host step is visible');
    assert.ok(html.includes(`aria-atomic="true">${label}</p>`), 'the live announcement follows the host step');
  }
});

test('Smart Cleanup execution has no progress bar, frozen count or Cancel and restore control', () => {
  const app = preparedCleanupApp();
  const workspace = component(app.tree(), 'SmartCleanupWorkspace');
  // A supplied legacy callback must not bring back an unsafe execution control.
  const html = renderToStaticMarkup(createElement(workspace.type, { ...workspace.props, onCancelExecution: noop }));
  assert.doesNotMatch(html, /<progress|role="progressbar"|smart-cleanup-execution__progress|actions completed|Cancel and restore/);
  assert.match(html, /Applying cleanup/);
  assert.match(html, /Close is unavailable while project files are changing/);
});
