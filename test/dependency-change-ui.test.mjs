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

test('Smart Cleanup open with an unknown outcome shows only the shared blocked presentation', () => {
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
  component(app.tree(), 'SmartCleanupWorkspace').props.dispatch({ type: 'execution-started', total: 1, currentLabel: 'Applying cleanup' });
  app.receive({ status: 'remove-error', package: 'react', error: { code: 'OUTCOME_UNKNOWN', message: RECOVERY_MESSAGES.blocked } });
  workspace = component(app.tree(), 'SmartCleanupWorkspace');
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
