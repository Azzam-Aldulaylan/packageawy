import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { RUNTIME_ERROR_CODE, RUNTIME_ERROR_TEXT } from '../out/core/diagnostics.js';
import { makeCoordinator, makeProject } from './helpers/removal-project.mjs';
import { failedRequestSettlement } from '../out/host/failedRequestSettlement.js';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `
  export { App } from './webview/src/App.tsx';
  export { UndoBackupContext, UndoChangeButton } from './webview/src/components/UndoChangeButton.tsx';
  export { RemovalResultPanel } from './webview/src/components/RemovalProgressPanels.tsx';
  export { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
  export { TransitiveFixReview } from './webview/src/components/TransitiveFixReview.tsx';
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
let sent;
const previousApi = Object.getOwnPropertyDescriptor(globalThis, 'acquireVsCodeApi');
Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({ postMessage: message => sent?.push(message) }) });
const { App, UndoBackupContext, RemovalResultPanel, ManageDependencyModal, TransitiveFixReview } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
if (previousApi) Object.defineProperty(globalThis, 'acquireVsCodeApi', previousApi); else delete globalThis.acquireVsCodeApi;
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const row = { name: 'react', current: '18.2.0', range: '^18.0.0', wanted: '18.3.0', latest: '18.3.0', dev: false, optional: false,
  advisories: [], worstSeverity: null, upgradeTo: '18.3.0', upgradeReason: 'update' };
const snapshot = { status: 'ready', data: { rows: [], generatedAt: 'now',
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  project: { id: 'project', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
  extensionVersion: 'test', builtAt: 'test', hygieneFindings: [] } };
const noop = () => {};

function mount(t, element = h(App)) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  const frames = new Map(); let frameId = 0;
  const saved = new Map();
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: key => frames.delete(key) };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { get() { return this.hidden ? null : this.parentElement; } });
  sent = [];
  const root = createRoot(dom.window.document.querySelector('#root'));
  act(() => root.render(element));
  t.after(() => {
    act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    sent = undefined;
  });
  const update = element => act(() => root.render(element));
  const event = message => {
    assert.equal(isHostToWebviewMessage(message), true, JSON.stringify(message));
    act(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })));
  };
  const paint = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); });
  const click = button => act(() => { button.focus(); button.click(); });
  return { document: dom.window.document, event, paint, click, update, get sent() { return sent; } };
}

for (const label of [path.join('packages', 'app'), path.win32.join('packages', 'app')]) for (const outcome of ['success', 'unavailable', 'runtime error', 'host refusal', 'request error']) {
  test(`real App blocks duplicate Undo requests before paint and clears delayed ${outcome} for ${JSON.stringify(label)}`, t => {
    const dom = mount(t);
    dom.event(snapshot);
    dom.event({ status: 'smart-cleanup-backups', entries: [
      { analysisId: id, label, operation: 'cleanup' }, { analysisId: otherId, label: 'other', operation: 'upgrade' },
    ] });
    const [opener, other] = dom.document.querySelectorAll('[data-undo-id]');
    assert.match(opener.closest('section').textContent, /packages[\\/]app/);
    act(() => { opener.click(); other.click(); opener.click(); });
    assert.equal(dom.sent.filter(message => message.type === 'restore-smart-cleanup').length, 1);
    assert.equal(opener.disabled, true);
    assert.equal(other.disabled, true);
    assert.equal(opener.getAttribute('aria-busy'), 'true');
    assert.equal(other.getAttribute('aria-busy'), 'false');
    assert.equal(dom.document.querySelector('[role="status"]').textContent.trim(), 'Opening the backup...');
    // Delayed host work can deliver unrelated discovery or dashboard messages.
    dom.event(snapshot);
    dom.event({ status: 'smart-cleanup-backup', analysisId: otherId, outcome: 'unavailable' });
    assert.equal(opener.disabled, true);
    assert.match(dom.document.body.textContent, /Opening the backup\.\.\./);
    if (outcome === 'success') {
      dom.event({ status: 'recovery', recovery: { undoReview: true, undoOperation: 'cleanup', state: 'undo-available',
        message: 'The change is done.', files: [], claim: null, canApply: false, canDismiss: false } });
      assert.equal(dom.document.activeElement.textContent, 'Undo cleanup');
      dom.click([...dom.document.querySelectorAll('button')].find(button => button.textContent === 'Keep the backup for later'));
    } else if (outcome === 'unavailable') dom.event({ status: 'smart-cleanup-backup', analysisId: id, outcome: 'unavailable' });
    else if (outcome === 'runtime error') dom.event({ status: 'runtime-error', code: RUNTIME_ERROR_CODE, message: RUNTIME_ERROR_TEXT });
    else dom.event(failedRequestSettlement({ type: 'restore-smart-cleanup', analysisId: id }, 'Smart Cleanup',
      outcome === 'host refusal' ? { code: 'CHANGES_PAUSED', message: 'Dependency changes are paused.' } : undefined));
    assert.doesNotMatch(dom.document.body.textContent, /Opening the backup\.\.\./);
    const retry = dom.document.querySelector('[data-undo-id]');
    assert.equal(retry.disabled, false);
    assert.equal(retry.getAttribute('aria-busy'), 'false');
    dom.click(retry);
    assert.equal(dom.sent.filter(message => message.type === 'restore-smart-cleanup').length, 2);
    assert.match(dom.document.body.textContent, /Opening the backup\.\.\./);
  });
}

for (const operation of ['cleanup', 'removal', 'upgrade', 'remediation']) for (const exit of ['keep', 'backup disappears', 'host closes review']) {
  test(`real App ${operation} Undo round trip restores focus when ${exit}`, t => {
    const dom = mount(t);
    dom.event(snapshot);
    dom.event({ status: 'smart-cleanup-backups', entries: [{ analysisId: id, label: path.join('packages', 'app'), operation }] });
    const opener = dom.document.querySelector('.cleanup-undo button');
    assert.equal(opener.disabled, false);
    dom.click(opener);
    assert.deepEqual(dom.sent.at(-1), { type: 'restore-smart-cleanup', analysisId: id });
    dom.event({ status: 'recovery', recovery: { undoReview: true, undoOperation: operation,
      state: 'undo-available', message: 'The change is done.', files: [], claim: null, canApply: false, canDismiss: false } });
    assert.equal(opener.isConnected, false, 'the dashboard and opener really unmounted');
    assert.equal(dom.document.activeElement.id, 'recovery-title');
    assert.equal(dom.document.activeElement.textContent, opener.textContent);
    if (exit === 'backup disappears') dom.event({ status: 'smart-cleanup-backups', entries: [] });
    if (exit === 'host closes review') dom.event({ status: 'recovery', recovery: {
      state: 'none', message: '', files: [], claim: null, canApply: false, canDismiss: false } });
    else dom.click([...dom.document.querySelectorAll('button')].find(button => button.textContent === 'Keep the backup for later'));
    dom.paint();
    assert.equal(dom.document.querySelector('.recovery'), null);
    if (exit === 'backup disappears') {
      assert.equal(dom.document.activeElement, dom.document.querySelector('.dashboard__title'));
      assert.equal(dom.document.activeElement.tabIndex, -1);
    } else {
      const remounted = dom.document.querySelector('.cleanup-undo button');
      assert.notEqual(remounted, opener);
      assert.equal(dom.document.activeElement, remounted);
      assert.equal(remounted.disabled, false);
      dom.click(remounted);
      assert.deepEqual(dom.sent.at(-1), { type: 'restore-smart-cleanup', analysisId: id });
    }
    assert.notEqual(dom.document.activeElement, dom.document.body);
  });
}

const removalResult = { undoId: id, analysisId: 'removal', packages: ['react'], outcome: 'verified', verification: 'not-configured', rollback: 'not-needed', message: 'Removed.' };
const upgradeResult = { undoId: id, package: 'react', refreshId: 'refresh', install: 'succeeded', application: 'applied', verification: 'not-configured', refreshingDerivedData: false,
  changes: [{ packageName: 'react', previousVersion: '18.2.0', requestedVersion: '18.3.0', currentVersion: '18.3.0', declaredRange: '^18.0.0', classification: 'prod' }] };
const plan = { rootPackage: 'react', analysisId: 'fix', files: {}, changes: [], packageManager: 'npm' };
const fixResult = { undoId: id, outcome: 'unverified', verification: 'not-configured', rollback: 'not-needed', message: 'Fix applied.', resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] };
const panels = {
  removal: h(RemovalResultPanel, { row, result: removalResult }),
  upgrade: h(ManageDependencyModal, { row, allRows: [row], removalImpact: { phase: 'idle' }, hygieneFindings: [], activeTab: 'upgrade',
    onChangeTab: noop, actionsDisabled: false, upgradeDisabled: false, updateResolutionAvailable: true, advisoriesAvailable: true,
    blockClose: false, upgradeResult, upgradeEnrichment: null, upgrade: { active: false, analysis: null, busy: false }, removal: { active: false, analysis: null, busy: false },
    onClose: noop, onRetryUpgradeEnrichment: noop, now: Date.now() }),
  remediation: h(TransitiveFixReview, { rootPackage: 'react', subject: 'react', dependencyPath: ['react'],
    state: { phase: 'result', plan, result: fixResult }, disabled: false, onAnalyze: noop }),
};
for (const [operation, panel] of Object.entries(panels)) test(`${operation} result offers only its current transaction's Undo action`, t => {
  const reviewed = [];
  const element = (transactionId = id, disabled = false) => h(UndoBackupContext.Provider, {
    value: { entries: [{ analysisId: transactionId, label: 'fixture', operation }], disabled, review: id => reviewed.push(id) },
  }, panel);
  const dom = mount(t, element());
  const button = dom.document.querySelector('[data-undo-id]');
  assert.ok(button, `${operation} matching result has Undo`);
  assert.equal(button.textContent, { removal: 'Undo removal', upgrade: 'Undo upgrade', remediation: 'Undo transitive fix' }[operation]);
  dom.click(button);
  assert.deepEqual(reviewed, [id]);
  dom.update(element(otherId));
  assert.equal(dom.document.querySelector('[data-undo-id]'), null, 'a newer transaction never attaches to the old result');
  dom.update(element(id, true));
  assert.equal(dom.document.querySelector('[data-undo-id]').disabled, true);
});

for (const [operation, panel] of Object.entries(panels)) test(`${operation} result announces a pending Undo inside its own surface`, t => {
  const dom = mount(t, h(UndoBackupContext.Provider, { value: {
    entries: [{ analysisId: id, label: 'fixture', operation }], disabled: true, openingId: id, review: noop,
  } }, panel));
  const button = dom.document.querySelector('[data-undo-id]');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  const feedback = dom.document.querySelector('.change-result > p[role="status"]');
  assert.equal(feedback.textContent, 'Opening the backup...');
  assert.equal(feedback.getAttribute('aria-live'), 'polite');
  assert.equal(feedback.closest('.dialog-footer__standalone-actions'), null);
});

for (const outcome of ['keep backup', 'restore starts']) test(`real App upgrade result Undo returns to its remounted dialog when ${outcome}`, t => {
  const dom = mount(t);
  dom.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
  dom.event({ status: 'upgrade-result', result: upgradeResult });
  dom.event({ status: 'smart-cleanup-backups', entries: [{ analysisId: id, label: 'fixture', operation: 'upgrade' }] });
  dom.click([...dom.document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Manage'));
  dom.click([...dom.document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.includes('Upgrade review')));
  const opener = dom.document.querySelector('[role="dialog"] [data-undo-id]');
  assert.ok(opener, 'matching upgrade result has Undo in the real App');
  dom.click(opener);
  assert.equal(opener.disabled, true);
  assert.equal(opener.getAttribute('aria-busy'), 'true');
  const feedback = dom.document.querySelector('.manage-modal__body .change-result > p[role="status"]');
  assert.equal(feedback.textContent, 'Opening the backup...');
  assert.equal(feedback.getAttribute('aria-live'), 'polite');
  assert.equal(dom.document.querySelector('.dialog-footer [role="status"]'), null);
  dom.event({ status: 'recovery', recovery: { undoReview: true, undoOperation: 'upgrade',
    state: 'undo-available', message: 'The change is done.', files: [], claim: null, canApply: false, canDismiss: false } });
  assert.equal(opener.isConnected, false);
  if (outcome === 'restore starts') {
    dom.event({ status: 'smart-cleanup-backup', analysisId: id, outcome: 'changed' });
    dom.event({ status: 'smart-cleanup-backups', entries: [] });
  }
  dom.click([...dom.document.querySelectorAll('button')].find(button => button.textContent === 'Keep the backup for later'));
  dom.paint();
  if (outcome === 'keep backup') {
    assert.equal(dom.document.activeElement, dom.document.querySelector('[role="dialog"] [data-undo-id]'));
    assert.notEqual(dom.document.activeElement, dom.document.querySelector('.cleanup-undo button'), 'focus returns inside the dialog');
  } else {
    assert.equal(dom.document.querySelector('#upgrade-result-heading'), null, 'restore invalidates the original success');
    assert.equal(dom.document.activeElement, dom.document.querySelector('#manage-dependency-title'));
  }
});

const removalAnalysis = {
  analysisId: 'removal', package: 'react', analyzedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  changes: [{ packageName: 'react', classification: 'prod', stillRequiredBy: [] }],
  files: { manifestPath: path.join('packages', 'app', 'package.json'), lockfilePath: path.join('packages', 'app', 'package-lock.json'), rollbackAvailable: true },
  verification: { configured: false, suggestedScriptNames: [] },
};
const remediationPlan = {
  analysisId: 'fix', rootPackage: 'react', currentVersion: '18.2.0', outcome: 'full', explanation: 'A fix is available.',
  generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), packageManager: 'npm', packageManagerVersion: null,
  lifecycleScriptsEnabled: false, directRootUnchanged: true,
  files: { manifestPath: 'package.json', lockfilePath: 'package-lock.json', manifestChanged: false, lockfileChanged: true },
  changes: [{ packageName: 'minimist', fromVersions: ['1.0.0'], toVersions: ['1.2.8'], affectedPaths: [['react', 'minimist']], targeted: true }],
  resolvedAdvisories: [{ advisoryId: 'GHSA-AAAA-BBBB-CCCC', identifiers: [], title: 'Issue', severity: 'high', flaggedPackage: 'minimist', affectedPaths: [['react', 'minimist']] }], remainingAdvisories: [], introducedAdvisories: [], blockingReasons: [], verification: { configured: false, suggestedScriptNames: [] },
};
function openResult(dom, operation, label) {
  const clickText = text => {
    const button = [...dom.document.querySelectorAll('button')].find(button => button.textContent.trim() === text);
    assert.ok(button, `button ${text} exists`);
    assert.equal(button.disabled, false, text);
    dom.click(button);
  };
  const impact = () => {
    const request = dom.sent.findLast(message => message.type === 'analyze-removal-impact');
    dom.event({ status: 'removal-impact-result', requestId: request.requestId, packages: ['react'], generatedAt: new Date().toISOString(),
      assessments: [{ packageName: 'react', usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } }] });
  };
  dom.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
  if (operation === 'cleanup') {
    clickText('Smart Cleanup');
    const requestId = dom.sent.findLast(message => message.type === 'analyze-smart-cleanup-metadata').requestId;
    dom.event({ status: 'cleanup-result', analyzedAt: new Date().toISOString(), cacheExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      findings: [{ packageName: 'react', kind: 'likely-unused', confidence: 'high', severity: 'info', summary: 'No usage found.',
        evidence: { kind: 'likely-unused', reason: 'No usage found.', scannedFileCount: 1, truncated: false } }] });
    impact();
    dom.event({ status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } });
    clickText('Review 1 selected');
    dom.event({ status: 'remove-analysis', analysis: removalAnalysis });
    clickText('Confirm and clean 1 action');
    dom.event({ status: 'remove-result', result: { ...removalResult, restoreAvailable: true, smartCleanup: {
      status: 'verified', metrics: [], removedAdvisories: [], introducedAdvisories: [],
      completedActionIds: ['remove-direct:react'], skippedActionIds: [], failedActionIds: [],
    } } });
  } else {
    if (operation === 'upgrade') dom.event({ status: 'upgrade-result', result: upgradeResult });
    clickText('Manage');
    if (operation === 'remediation') {
      dom.event({ status: 'remediation-plan', package: 'react', plan: remediationPlan });
      dom.event({ status: 'remediation-apply-result', package: 'react', analysisId: 'fix', result: fixResult });
      clickText('Vulnerabilities');
    } else {
      clickText(operation === 'upgrade' ? 'Upgrade review' : 'Removal review');
      if (operation === 'removal') {
        clickText('Analyze removal'); impact();
        dom.event({ status: 'remove-analysis', analysis: removalAnalysis });
        clickText('Remove react');
        dom.event({ status: 'remove-result', result: removalResult });
      }
    }
  }
  dom.event({ status: 'smart-cleanup-backups', entries: [{ analysisId: operation === 'cleanup' ? removalAnalysis.analysisId : id, label, operation }] });
  const button = dom.document.querySelector('[role="dialog"] [data-undo-id]');
  assert.ok(button, `${operation} has Undo inside its real App dialog`);
  return button;
}

for (const hostKind of ['vscode', 'jetbrains']) for (const operation of ['cleanup', 'removal', 'upgrade', 'remediation']) {
  for (const failure of ['refusal', 'request failure', 'runtime failure']) test(`${hostKind} ${operation} keeps Undo ${failure} feedback inside the originating real App dialog`, async t => {
    const project = await makeProject(t);
    const f = makeCoordinator(project);
    f.coordinator.options.platform.hostKind = hostKind;
    t.after(() => f.coordinator.disposeWhenIdle());
    const dom = mount(t);
    const label = hostKind === 'jetbrains' ? path.win32.join('packages', 'app') : path.join('packages', 'app');
    const opener = openResult(dom, operation, label);
    dom.click(opener);
    const request = dom.sent.findLast(message => message.type === 'restore-smart-cleanup');
    assert.equal(request.analysisId, opener.dataset.undoId);
    const dialog = opener.closest('[role="dialog"]');
    assert.match(dialog.textContent, /Opening the backup\.\.\./);
    // Another backup's failure cannot settle or label this request.
    dom.event(failedRequestSettlement({ ...request, analysisId: otherId }, 'Smart Cleanup'));
    assert.equal(opener.disabled, true);
    assert.equal(dialog.querySelector('[role="alert"]'), null);
    let response;
    if (failure === 'refusal') {
      f.coordinator.refuseChangeAfterFailure(request);
      response = f.messages.at(-1);
    } else {
      if (failure === 'runtime failure') dom.event({ status: 'runtime-error', code: RUNTIME_ERROR_CODE, message: RUNTIME_ERROR_TEXT });
      response = failedRequestSettlement(request, f.coordinator.requestTarget(request));
    }
    assert.equal(response.undoId, request.analysisId);
    dom.event(response);
    const alert = dialog.querySelector('[role="alert"]');
    assert.ok(alert, 'the failure is announced inside the originating dialog');
    assert.match(alert.textContent, /Couldn't open the backup\./);
    assert.ok(alert.textContent.includes(failure === 'runtime failure' ? RUNTIME_ERROR_TEXT : response.error.message));
    assert.ok(alert.querySelector('svg'), 'error feedback has an icon as well as text');
    assert.doesNotMatch(dom.document.body.textContent, /Couldn't remove Smart Cleanup|Opening the backup\.\.\./);
    assert.equal(opener.disabled, false);
    assert.equal(opener.getAttribute('aria-busy'), 'false');
    // Refreshing the dashboard must not erase the result's request error.
    dom.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
    assert.ok(dialog.querySelector('[role="alert"]'));
    dom.click(opener);
    assert.equal(dialog.querySelector('[role="alert"]'), null, 'retry clears the previous error');
    assert.match(dialog.textContent, /Opening the backup\.\.\./);
    assert.equal(dom.sent.filter(message => message.type === 'restore-smart-cleanup').length, 2);
    assert.deepEqual(f.commands, [], 'failed review requests never run a package manager');
  });
}
