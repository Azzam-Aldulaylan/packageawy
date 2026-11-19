import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { smartCleanupProjectCapability } from '../out/host/smartCleanupProjectCapability.js';

const require = createRequire(import.meta.url);
const bundled = await build({ stdin: { contents: `
  export { buildSmartCleanupPlan } from './webview/src/smartCleanupPlanAdapter.ts';
  export { RecoveryScreen } from './webview/src/components/RecoveryScreen.tsx';
  export { SmartCleanupWorkspace } from './webview/src/components/SmartCleanupWorkspace.tsx';
  export { DependencyChangeContext } from './webview/src/components/DependencyChangeStatus.tsx';
  export { UndoBackupContext } from './webview/src/components/UndoChangeButton.tsx';
  export { createSmartCleanupState, smartCleanupReducer } from './webview/src/smartCleanupState.ts';
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { buildSmartCleanupPlan, RecoveryScreen, SmartCleanupWorkspace, DependencyChangeContext, UndoBackupContext, createSmartCleanupState, smartCleanupReducer: reduce } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const noop = () => {};
const result = { analysisId: 'cleanup-a', metrics: [], completedActionIds: [], skippedActionIds: [],
  failedActionIds: ['remove-direct:a', 'remove-direct:b', 'remove-direct:c'], resolvedAdvisories: [], introducedAdvisories: [],
  verification: 'not-run', rollback: 'incomplete' };
const incomplete = () => reduce(createSmartCleanupState('fixture'), { type: 'execution-incomplete', result, message: 'Cleanup stopped.' });
const file = { id: '11111111-1111-4111-8111-111111111111', path: path.join('packages', 'app', 'package.json'), existed: true,
  backup: 'b'.repeat(64), current: 'a'.repeat(64), backupPreview: '{}', currentPreview: '{}', progress: 'Not restored' };
const recovery = { state: 'incomplete', message: 'Restoring files is not complete.', files: [file], claim: null, canApply: true, canDismiss: true };

function mount(t, element) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button><main></main></body>');
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // jsdom has no layout. Supply visibility only for the focus trap's check.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { get() { return this.hidden ? null : this.parentElement; } });
  const document = dom.window.document;
  document.querySelector('#opener').focus();
  const root = createRoot(document.querySelector('main'));
  act(() => root.render(element));
  t.after(() => {
    act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return { document, window: dom.window, update: element => act(() => root.render(element)), unmount: () => act(() => root.unmount()) };
}
function workspace(state, context = {}, overrides = {}) {
  return h(DependencyChangeContext.Provider, { value: { task: 'idle', blocked: false, openRecovery: noop, ...context } },
    h(SmartCleanupWorkspace, { state, dispatch: noop, onClose: noop, onAnalyze: noop, onCancelAnalysis: noop, removalPreflight: null,
      preflightBusy: false, onPrepareRemoval: noop, onConfirmRemoval: noop, onKeepDependency: noop, onBackToReview: noop,
      onOpenDependencyReview: noop, onRestoreFiles: noop, ...overrides }));
}
const texts = nodes => [...nodes].map(node => node.textContent);

test('cleanup result disables Undo and announces opening inside the dialog until the host responds', t => {
  const state = reduce(reduce(createSmartCleanupState('fixture'), { type: 'execution-complete', result: {
    ...result, failedActionIds: [], rollback: 'not-needed', verification: 'not-configured',
  } }), { type: 'restore-available', analysisId: result.analysisId });
  let requests = 0;
  const element = openingId => h(UndoBackupContext.Provider, { value: { entries: [], disabled: openingId !== null, openingId, review: noop } },
    workspace(state, {}, { onRestoreFiles: () => requests++ }));
  const dom = mount(t, element(null));
  const footer = dom.document.querySelector('.smart-cleanup-footer');
  assert.equal(footer.previousElementSibling.className, 'smart-cleanup-body');
  assert.deepEqual(texts(footer.querySelectorAll('button')), ['Undo cleanup', 'Analyze current project']);
  assert.equal(dom.document.querySelector('.smart-cleanup-results__headline button'), null);
  const button = footer.querySelector('[data-undo-id]');
  assert.equal(button.disabled, false);
  act(() => button.click());
  assert.equal(requests, 1);
  dom.update(element(result.analysisId));
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.match(dom.document.querySelector('[role="dialog"]').textContent, /Opening the backup\.\.\./);
  assert.ok([...dom.document.querySelectorAll('[role="status"]')].some(node => node.textContent === 'Opening the backup...'));
  act(() => button.click());
  assert.equal(requests, 1);
  dom.update(element(null));
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(dom.document.body.textContent, /Opening the backup\.\.\./);
});

test('recovery decisions share a final section, consistent rows and keyboard order', async t => {
  const dom = mount(t, h(RecoveryScreen, { recovery, send: noop, close: noop }));
  const { document } = dom;
  assert.equal(document.activeElement.id, 'recovery-title');
  const section = document.querySelector('.recovery__actions');
  assert.equal(section.parentElement.lastElementChild, section);
  assert.equal(section.getAttribute('aria-labelledby'), 'recovery-actions-title');
  const rows = [...section.querySelectorAll('.recovery__action')];
  assert.deepEqual(texts(rows.map(row => row.querySelector('button'))), ['Apply file choices', 'Delete backup without restoring', 'Keep the backup for later']);
  for (const row of rows) {
    assert.equal(row.firstElementChild.tagName, 'H3');
    assert.equal(row.children[1].tagName, 'P');
    assert.equal(row.lastElementChild.tagName, 'BUTTON');
    assert.equal(row.querySelector('p button'), null);
  }
  assert.equal(document.querySelectorAll('.recovery button').length, rows.length);
  assert.ok(rows[0].querySelector('button').classList.contains('button--primary'));
  assert.equal(rows[1].querySelector('button').disabled, false);
  for (const button of section.querySelectorAll('button:not([disabled])')) { button.focus(); assert.equal(document.activeElement, button); }
  assert.match(document.querySelector('legend').textContent, /packages[\\/]app[\\/]package\.json/);
  const css = await readFile(path.join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.recovery__action\s*\{[^}]*flex-direction: column/);
  assert.match(css, /\.smart-cleanup-results__actions \.button--primary \{ font-weight: 700/);
  assert.match(css, /\.recovery button:focus-visible[^}]*var\(--vscode-focusBorder\)/);
});

test('completed choices make finishing primary and focus the updated recovery heading', t => {
  const sent = [];
  const props = { recovery: { ...recovery, state: 'open', canDismiss: false }, send: message => sent.push(message), close: noop };
  const dom = mount(t, h(RecoveryScreen, props));
  const apply = dom.document.querySelector('.recovery__action button');
  act(() => apply.click());
  assert.equal(sent[0].type, 'apply-recovery');
  dom.update(h(RecoveryScreen, { ...props, recovery: { ...recovery, state: 'completed', canApply: false, files: [{ ...file, current: file.backup, progress: 'restored' }] } }));
  assert.equal(dom.document.activeElement.id, 'recovery-title');
  const finish = [...dom.document.querySelectorAll('button')].find(node => node.textContent === 'Finish undo');
  assert.ok(finish.classList.contains('button--primary'));
  assert.equal(dom.document.querySelector('.recovery__action button'), finish);
  assert.equal(finish.disabled, false);
  act(() => finish.click());
  assert.deepEqual(sent[1], { type: 'dismiss-recovery', stopped: true, discardIncomplete: false });
});

for (const retryDiscovery of [false, true]) test(`cleanup has one blocked status and action group, discovery retry ${retryDiscovery}`, t => {
  let opened = 0;
  const state = reduce(incomplete(), { type: 'restore-available', analysisId: 'cleanup-a' });
  const message = retryDiscovery ? 'Could not check for backups.' : 'File choices are complete. Review the result before deleting the backup.';
  const dom = mount(t, workspace(state, { blocked: true, retryDiscovery, message, openRecovery: () => opened++ }));
  const { document } = dom;
  assert.equal(document.querySelectorAll('.smart-cleanup-results__headline').length, 1);
  assert.equal(document.querySelector('.banner'), null);
  assert.equal(document.querySelector('.smart-cleanup-footer').parentElement, document.querySelector('[role="dialog"]'));
  assert.ok(document.querySelector('.smart-cleanup-footer .smart-cleanup-results__actions'));
  assert.equal(document.querySelector('.smart-cleanup-body .smart-cleanup-results__actions'), null);
  const group = document.querySelector('.smart-cleanup-results__actions');
  assert.deepEqual(texts(group.querySelectorAll('button')), [retryDiscovery ? 'Retry discovery' : 'Open recovery', 'Analyze current project']);
  assert.equal(group.querySelectorAll('.button--primary').length, 1);
  assert.equal(group.children[1].disabled, true);
  assert.doesNotMatch(document.body.textContent, /before the result can be trusted|Undo cleanup/);
  assert.match(document.querySelector('[role="status"]').textContent, /Finish dependency recovery/);
  act(() => group.children[0].click());
  assert.equal(opened, 1);
  const last = group.querySelector('button:not(:disabled)');
  last.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement, document.querySelector('.modal__close'));
  document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, last);
});

test('resolved recovery replaces failed outcome, announces next step and keeps focus in the dialog', t => {
  const initial = incomplete();
  let analyzed = 0, closed = 0;
  const callbacks = { onAnalyze: () => analyzed++, onClose: () => closed++ };
  const dom = mount(t, workspace(initial, {}, callbacks));
  assert.match(dom.document.body.textContent, /3 cleanup actions did not finish/);
  const resolved = reduce(initial, { type: 'backup-updated', analysisId: 'cleanup-a', outcome: 'resolved' });
  dom.update(workspace(resolved, {}, callbacks));
  assert.equal(resolved.phase, 'complete');
  assert.equal(dom.document.activeElement.id, 'smart-cleanup-title');
  assert.match(dom.document.body.textContent, /Recovery complete/);
  assert.match(dom.document.querySelector('[role="status"]').textContent, /The backup was deleted. Analyze the current project/);
  assert.doesNotMatch(dom.document.body.textContent, /3 cleanup actions|Failed actions|manual review|Cleanup done|checks passed/);
  assert.equal(dom.document.querySelector('.smart-cleanup-metrics'), null);
  const group = dom.document.querySelector('.smart-cleanup-results__actions');
  assert.equal(group.children[0].disabled, false);
  act(() => group.children[0].click()); assert.equal(analyzed, 1);
  act(() => dom.document.querySelector('.modal__close').click()); assert.equal(closed, 1);
  dom.unmount();
  assert.equal(dom.document.activeElement.id, 'opener');
});

test('backup replacement cannot resolve failed cleanup and unrelated resolutions are ignored', () => {
  const state = incomplete();
  assert.equal(reduce(state, { type: 'backup-updated', analysisId: 'other', outcome: 'resolved' }), state);
  const replaced = reduce(state, { type: 'backup-updated', analysisId: 'cleanup-a', outcome: 'unavailable' });
  assert.equal(replaced.phase, 'incomplete');
  assert.equal(replaced.restore, null);
});

for (const filePath of [path.join('packages', 'app', 'package.json'), path.win32.join('packages', 'app', 'package.json')]) {
  test(`recovery displays the original file path ${JSON.stringify(filePath)}`, t => {
    const dom = mount(t, h(RecoveryScreen, { recovery: { ...recovery, files: [{ ...file, path: filePath }] }, send: noop, close: noop }));
    assert.equal(dom.document.querySelector('legend').textContent, filePath);
    assert.match(dom.document.querySelector('legend').textContent, /packages[\\/]app[\\/]package\.json/);
  });
}

test('a blocked result never retains a verified badge or success icon', t => {
  const state = reduce(createSmartCleanupState('fixture'), { type: 'execution-complete', result: { ...result, verification: 'passed', failedActionIds: [], rollback: 'not-needed' } });
  const dom = mount(t, workspace(state, { blocked: true, message: 'Review the backup.' }));
  const headline = dom.document.querySelector('.smart-cleanup-results__headline');
  assert.equal(headline.dataset.tone, 'attention');
  assert.equal(headline.dataset.verified, undefined);
  assert.equal(headline.querySelector('h3').textContent, 'Finish dependency recovery');
  assert.doesNotMatch(headline.textContent, /Configured project checks passed/);
});

test('successful removals show missing counts separately and announce both outcomes', t => {
  const metricsNote = 'Final dashboard counts could not be refreshed. Analyze the current project to update them.';
  const complete = reduce(createSmartCleanupState('fixture'), { type: 'execution-complete', result: {
    ...result, verification: 'not-configured', rollback: 'not-needed', failedActionIds: [],
    completedActionIds: result.failedActionIds, metricsNote,
  } });
  const state = reduce(complete, { type: 'restore-available', analysisId: 'cleanup-a' });
  const dom = mount(t, workspace(state));
  const headline = dom.document.querySelector('.smart-cleanup-results__headline');
  assert.equal(headline.querySelector('h3').textContent, 'Cleanup done');
  assert.match(headline.textContent, /3 packages removed/);
  assert.equal(dom.document.querySelector('.smart-cleanup-metrics'), null);
  const caveat = [...headline.querySelectorAll('p')].find(p => p.textContent.includes(metricsNote));
  assert.ok(caveat.querySelector('svg'), 'the caveat uses an icon and text');
  assert.match(dom.document.querySelector('[role="status"]').textContent, /Cleanup done\. 3 packages removed\./);
  assert.ok(dom.document.querySelector('[role="status"]').textContent.includes(metricsNote));
  const actions = dom.document.querySelector('.smart-cleanup-results__actions');
  assert.deepEqual(texts(actions.querySelectorAll('button')), ['Undo cleanup', 'Analyze current project']);
  for (const button of actions.querySelectorAll('button')) { button.focus(); assert.equal(dom.document.activeElement, button); }
  assert.doesNotMatch(dom.document.body.textContent, /Failed actions|manual review|Cleanup needs attention/);
  dom.update(workspace(reduce(state, { type: 'backup-updated', analysisId: 'cleanup-a', outcome: 'changed' })));
  dom.update(workspace(reduce(reduce(state, { type: 'backup-updated', analysisId: 'cleanup-a', outcome: 'changed' }),
    { type: 'backup-updated', analysisId: 'cleanup-a', outcome: 'resolved' })));
  assert.doesNotMatch(dom.document.body.textContent, /Final dashboard counts|3 packages removed/);
});

test('count comparisons use readable text instead of an arrow', t => {
  const state = reduce(createSmartCleanupState('fixture'), { type: 'execution-complete', result: {
    ...result, failedActionIds: [], rollback: 'not-needed', verification: 'not-configured',
    metrics: [{ id: 'dependencies', label: 'Direct dependencies', before: 3, after: 0, detail: '3 removed' }],
  } });
  const dom = mount(t, workspace(state));
  const spans = [...dom.document.querySelectorAll('.smart-cleanup-metric dd span')];
  assert.deepEqual(texts(spans), ['3', 'to']);
  assert.equal(spans[1].hasAttribute('aria-hidden'), false);
  assert.doesNotMatch(dom.document.body.textContent, /[–—→;]/);
});

for (const filePath of [path.join('packages', 'app', 'package.json'), path.win32.join('packages', 'app', 'package.json')]) {
  test(`restore result preserves the file path ${JSON.stringify(filePath)}`, t => {
    const dom = mount(t, h(RecoveryScreen, { recovery: { ...recovery, state: 'completed', canApply: false,
      reinstall: 'succeeded', files: [{ ...file, path: filePath, current: file.backup, progress: 'restored' }] }, send: noop, close: noop }));
    assert.equal(dom.document.querySelector('.recovery__result li').textContent, `${filePath}: Matches backup`);
    assert.match(dom.document.querySelector('.recovery__result li').textContent, /packages[\\/]app[\\/]package\.json/);
    assert.match(dom.document.body.textContent, /Reinstall completed/);
    assert.doesNotMatch(dom.document.body.textContent, /[–—→;]/);
  });
}


function reviewState(confidences, phase = 'ready') {
  return {
    ...createSmartCleanupState('fixture'), phase, requestId: 'review',
    expandedCategories: new Set(['unused']),
    plan: { planId: 'review', requestId: 'review', projectName: 'fixture', generatedAt: '2026-11-18T00:00:00.000Z',
      recommendations: confidences.map((confidence, index) => ({
        id: `remove-direct:package-${index}`, kind: 'remove-direct-dependency', packageName: `package-${index}`,
        dependencyType: 'production', confidence, rationale: 'Test reason.', evidence: ['Test evidence.'],
      })), deprecated: [], security: [] },
  };
}

for (const [confidences, phase, headline] of [
  [[], 'ready', 'Nothing to clean up'],
  [['blocked'], 'ready', 'No cleanup available here'],
  [['unknown'], 'ready', 'No cleanup available here'],
  [['safe', 'blocked'], 'ready', 'Recommended cleanup is ready'],
  [['review', 'blocked'], 'ready', 'Cleanup plan needs your review'],
  [['safe', 'review'], 'ready', 'Cleanup plan needs your review'],
  [['blocked'], 'partial', 'Review the available cleanup evidence'],
  [['safe', 'review'], 'partial', 'Review the available cleanup evidence'],
]) test(`cleanup headline for ${phase} ${confidences.join(',') || 'empty'}`, t => {
  const { document } = mount(t, workspace(reviewState(confidences, phase)));
  assert.equal(document.querySelector('.smart-cleanup-outcome h3').textContent, headline);
});

for (const confidences of [[], ['blocked'], ['unknown'], ['review']]) {
  test(`empty selection has no tick or enabled bulk action for ${confidences.join(',') || 'empty'}`, async t => {
    const dispatched = [];
    const { document } = mount(t, workspace(reviewState(confidences), {}, { dispatch: action => dispatched.push(action) }));
    const status = document.querySelector('.smart-cleanup-selection-bar__status');
    const icon = status.querySelector('span');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.getAttribute('data-selected'), 'false');
    assert.equal(icon.querySelector('svg'), null);
    assert.equal(status.querySelector('p').textContent, '0 selected');
    const button = document.querySelector('.smart-cleanup-selection-bar button');
    assert.equal(button.textContent, 'Select recommendations');
    assert.equal(button.disabled, true);
    assert.ok(button.classList.contains('button'));
    act(() => button.click());
    assert.deepEqual(dispatched, []);
    // The empty icon slot keeps its dimensions while hiding the filled square.
    const css = await readFile(path.join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
    assert.match(css, /\.smart-cleanup-selection-bar__status > span\s*\{[^}]*width: 1\.35rem;[^}]*height: 1\.35rem;/);
    assert.match(css, /\.smart-cleanup-selection-bar__status > span\[data-selected='false'\]\s*\{\s*visibility: hidden;/);
  });
}

for (const confidence of ['safe', 'review']) test(`bulk selection can clear selected ${confidence} actions`, t => {
  let state = reviewState([confidence]);
  state = { ...state, reviewedActionIds: new Set(['remove-direct:package-0']) };
  const dispatch = action => { state = reduce(state, action); dom.update(workspace(state, {}, { dispatch })); };
  const dom = mount(t, workspace(state, {}, { dispatch }));
  let button = dom.document.querySelector('.smart-cleanup-selection-bar button');
  if (confidence === 'safe') {
    assert.equal(button.disabled, false);
    button.focus();
    assert.equal(dom.document.activeElement, button);
    act(() => button.click());
  } else {
    act(() => dom.document.querySelector('.smart-cleanup-action__checkbox').click());
  }
  button = dom.document.querySelector('.smart-cleanup-selection-bar button');
  assert.equal(button.textContent, 'Clear selection');
  assert.equal(button.disabled, false);
  assert.ok(dom.document.querySelector('.smart-cleanup-selection-bar__status > span svg'));
  act(() => button.click());
  assert.equal(state.selectedActionIds.size, 0);
  assert.equal(dom.document.querySelector('.smart-cleanup-selection-bar__status svg'), null);
  assert.equal(button.textContent, 'Select recommendations');
  assert.equal(button.disabled, confidence === 'review');
});

for (const source of [
  { importerId: path.join('packages', 'web'), lockfileName: 'package-lock.json' },
  { importerId: path.win32.join('packages', 'web'), lockfileName: 'package-lock.json' },
  { importerId: '.', lockfileName: null },
  { importerId: '.', lockfileName: 'npm-shrinkwrap.json' },
]) test(`capability reason appears once per row for ${source.importerId} ${source.lockfileName}`, t => {
  const capability = smartCleanupProjectCapability({ packageManager: 'npm', ...source });
  const options = { projectName: 'fixture', requestId: 'review',
    rows: [{ name: 'unused', dev: false, optional: false, advisories: [] }],
    hygieneFindings: [{ packageName: 'unused', kind: 'likely-unused', evidence: { kind: 'likely-unused' } }],
    exactDeprecatedFindings: [], capability,
    removalImpact: { phase: 'done', assessments: new Map([['unused', { assessment: { status: 'low-risk', evidence: [
      { summary: capability.reason }, { summary: 'No project usage found.' },
    ] } }]]) },
  };
  const plan = buildSmartCleanupPlan(options);
  const recommendation = plan.recommendations[0];
  assert.equal(recommendation.confidence, 'blocked');
  assert.equal(recommendation.rationale, capability.reason);
  assert.deepEqual(recommendation.evidence, ['No project usage found.']);
  const { document } = mount(t, workspace({ ...reviewState([]), plan }));
  const row = document.querySelector('.smart-cleanup-action');
  assert.equal(row.textContent.split(capability.reason).length - 1, 1);
  assert.ok(row.querySelector('.smart-cleanup-action__reason').textContent.startsWith(capability.reason));
  assert.equal(row.querySelector('summary').textContent, 'Why removal is blocked');
  assert.equal(row.querySelector('details li').textContent, 'No project usage found.');
  assert.equal(row.querySelector('input').disabled, true);
  const noAssessment = buildSmartCleanupPlan({ ...options, removalImpact: { phase: 'idle' } }).recommendations[0];
  assert.equal(noAssessment.rationale, capability.reason);
  assert.deepEqual(noAssessment.evidence, []);
});
