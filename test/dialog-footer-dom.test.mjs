import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { buildUpgradeAnalysisPresentation } from '../out/host/upgradeAnalysisPresentation.js';

const bundle = await build({ stdin: { contents: `
  export { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
  export { ManageDependenciesModal } from './webview/src/components/ManageDependenciesModal.tsx';
  export { UpgradeAnalysisModal } from './webview/src/components/UpgradeAnalysisModal.tsx';
  export { RemoveAnalysisModal } from './webview/src/components/RemoveAnalysisModal.tsx';
  export { ChangeResultModal, RemovalChangeResultModal } from './webview/src/components/ChangeResultModal.tsx';
  export { SmartCleanupWorkspace } from './webview/src/components/SmartCleanupWorkspace.tsx';
  export { createSmartCleanupState } from './webview/src/smartCleanupState.ts';
  export { filledButtonForeground } from './webview/src/dialogButtonContrast.ts';
  export { UndoBackupContext } from './webview/src/components/UndoChangeButton.tsx';
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' });
const module = { exports: {} };
vm.runInThisContext(`(function(module,exports,require){${bundle.outputFiles[0].text}\n})`, { filename: join(process.cwd(), 'dialog-footer.fixture.cjs') })(module, module.exports, createRequire(import.meta.url));
const { ManageDependencyModal, ManageDependenciesModal, UpgradeAnalysisModal, RemoveAnalysisModal, ChangeResultModal, RemovalChangeResultModal,
  SmartCleanupWorkspace, createSmartCleanupState, filledButtonForeground, UndoBackupContext } = module.exports;
const css = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
const noop = () => {};
const now = Date.now();
const row = { name: 'alpha', current: '1.0.0', range: '^1.0.0', wanted: '1.1.0', latest: '2.0.0', upgradeTo: '2.0.0',
  upgradeReason: 'update', advisories: [], worstSeverity: null, dev: false, optional: false };
const files = { manifestPath: join('fixture', 'package.json'), lockfilePath: join('fixture', 'package-lock.json'), rollbackAvailable: true };
const upgrade = buildUpgradeAnalysisPresentation({ analysisId: 'review', analyzedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
  packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo, classification: 'prod',
  compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
  projectCompatibility: { identity: { packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo }, analyzers: [], findings: [] }, security: null, smartPlan: null,
  verificationScriptNames: [], ...files });
const removal = { analysisId: 'removal', analyzedAt: upgrade.analyzedAt, expiresAt: upgrade.expiresAt,
  changes: [{ packageName: row.name, classification: 'prod', stillRequiredBy: [] }], files, verification: { configured: false, suggestedScriptNames: [] } };
const result = { application: 'applied', refreshId: 'refresh', install: 'succeeded', verification: 'not-configured', rollback: 'not-needed',
  changes: [{ packageName: row.name, previousVersion: row.current, currentVersion: row.upgradeTo }] };
const removalResult = { analysisId: 'removal', packages: [row.name], outcome: 'verified', verification: 'not-configured', rollback: 'not-needed', message: 'Removed.' };
const impact = { phase: 'done', packages: [row.name], generatedAt: new Date(now).toISOString(), assessments: new Map([[row.name, { assessment: { status: 'low-risk', evidence: [] } }]]) };
const upgradeState = { active: false, targetVersion: row.upgradeTo, targetState: { phase: 'idle' }, analysis: null, busy: false, error: null,
  hardStale: false, onAnalyze: noop, onTargetChange: noop, onConfirm: noop, onUseSmartPlan: noop, onCancel: noop, onConfigureVerification: noop, onRefresh: noop };
const removalState = { active: false, analysis: null, busy: false, error: null, onAnalyze: noop, onConfirm: noop, onConfigureVerification: noop };
const manageProps = { row, allRows: [row], activeTab: 'overview', onChangeTab: noop, actionsDisabled: false, upgradeDisabled: false,
  advisoriesAvailable: false, blockClose: false, upgradeResult: null, upgradeEnrichment: null, upgrade: upgradeState, removal: removalState,
  removalImpact: impact, hygieneFindings: [], now, onClose: noop, onOpenAdvisory: noop, onAnalyzeRemediation: noop,
  onReanalyzeUsage: noop, onOpenUsageReference: noop, onDismissRemediation: noop };

function mount(t, element) {
  const dom = new JSDOM('<!doctype html><body class="vscode-dark"><button id="opener">Open</button><main></main></body>');
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: callback => { callback(); return 1; } })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { get() { return this.hidden ? null : this.parentElement; } });
  dom.window.HTMLElement.prototype.scrollIntoView = noop;
  const root = createRoot(document.querySelector('main'));
  document.querySelector('#opener').focus();
  act(() => root.render(element));
  t.after(() => {
    act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return { document, window: dom.window, update: element => act(() => root.render(element)) };
}
function checkFooter(document, variant = null) {
  const dialog = document.querySelector('[role="dialog"]');
  const footers = dialog.querySelectorAll('footer');
  assert.equal(footers.length, 1);
  const footer = footers[0];
  assert.ok(footer.classList.contains('dialog-footer'));
  assert.equal(footer.parentElement, dialog);
  assert.equal(dialog.lastElementChild, footer);
  assert.equal(footer.closest('.modal__body, .manage-modal__body, .smart-cleanup-body'), null);
  assert.equal(footer.querySelector('.banner, [role="status"], [role="alert"], .manage-modal__footer-note, .dialog-footer__status'), null);
  const buttons = [...footer.querySelectorAll('button')];
  assert.ok(buttons.some(button => /close|cancel/i.test(button.textContent)), 'every state has close or cancel, including disabled execution controls');
  for (const button of buttons) {
    assert.ok(button.classList.contains('button--secondary') || button.classList.contains('button--primary'));
    if (!button.disabled) { button.focus(); assert.equal(document.activeElement, button); }
  }
  const primary = buttons.filter(button => button.classList.contains('button--primary'));
  if (variant !== null) {
    assert.ok(primary.length > 0);
    assert.equal(buttons.at(-1), primary.at(-1));
    assert.equal(primary.at(-1).classList.contains('button--upgrade'), variant === 'upgrade');
    assert.equal(primary.at(-1).classList.contains('button--removal'), variant === 'removal');
  }
  return { footer, buttons };
}

const analysisNote = 'Analysis does not modify your project. Registry metadata and the local package manager may be used during analysis.';
const appliedNote = 'Changes were applied to package.json and the lockfile.';
const restoredNote = 'Your dependency files were restored.';
const fixPlan = { analysisId: 'fix-notes', rootPackage: row.name, currentVersion: row.current, packageManager: 'npm', outcome: 'safe',
  changes: [], files, verification: { configured: false, suggestedScriptNames: [] }, resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] };
const fixResult = { outcome: 'verified', rollback: 'not-needed', verification: 'passed', message: 'Fix finished.',
  resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] };

for (const activeTab of ['overview', 'vulnerabilities', 'usage', 'upgrade', 'removal']) {
  for (const [state, patch, note, hiddenTabs] of [
    ['idle', {}, analysisNote, []],
    ['upgrade review', { upgrade: { ...upgradeState, active: true, analysis: upgrade } }, analysisNote, ['upgrade']],
    ['upgrade applying', { upgrade: { ...upgradeState, active: true, analysis: upgrade, busy: true }, blockClose: true }, analysisNote, ['upgrade']],
    ['upgrade applied', { upgradeResult: result }, appliedNote, ['upgrade']],
    ['upgrade rolled back', { upgradeResult: { ...result, application: 'rolled-back' } }, restoredNote, ['upgrade']],
    ['upgrade unconfirmed', { upgradeResult: { ...result, application: 'unconfirmed' } }, null, []],
    ['removal review', { removal: { ...removalState, active: true, analysis: removal } }, analysisNote, ['removal']],
    ['removal applying', { removalRun: { phase: 'running', progress: 'installing' }, blockClose: true }, null, []],
    ['removal applied', { removalRun: { phase: 'result', result: removalResult } }, appliedNote, ['removal']],
    ['removal rolled back', { removalRun: { phase: 'result', result: { ...removalResult, outcome: 'rolled-back' } } }, restoredNote, ['removal']],
    ['removal failed', { removalRun: { phase: 'error', error: { code: 'ROLLBACK_FAILED', message: 'Restore failed.' } } }, null, []],
    ['transitive applying', { remediation: { phase: 'applying', plan: fixPlan, progress: 'installing', cancelRequested: false }, blockClose: true }, analysisNote, []],
    ['transitive completed', { remediation: { phase: 'result', plan: fixPlan, result: fixResult } }, analysisNote, ['overview', 'vulnerabilities']],
    ['transitive recovery', { remediation: { phase: 'result', plan: fixPlan, result: { ...fixResult, outcome: 'recovery-required', rollback: 'failed' } } }, analysisNote, ['overview', 'vulnerabilities']],
  ]) test(`Manage ${activeTab} note retains index visibility for ${state}`, t => {
    const dom = mount(t, h(ManageDependencyModal, { ...manageProps, activeTab, ...patch }));
    const expected = hiddenTabs.includes(activeTab) ? null : note;
    const notes = [...dom.document.querySelectorAll('.manage-modal__footer-note:not(.removal-review__rollback)')];
    assert.deepEqual(notes.map(node => node.textContent.trim()), expected === null ? [] : [expected]);
    assert.ok(notes.every(node => node.closest('.manage-modal__body') !== null));
    if (state === 'transitive recovery' && ['overview', 'vulnerabilities'].includes(activeTab)) {
      assert.match(dom.document.querySelector('#transitive-result-heading').textContent, /Recovery required/);
    }
  });
  test(`Manage dependency ${activeTab} idle has one external footer`, t => {
    const dom = mount(t, h(ManageDependencyModal, { ...manageProps, activeTab }));
    checkFooter(dom.document, activeTab === 'removal' ? 'removal' : null);
  });
}
for (const [label, patch, variant] of [
  ['upgrade loading', { activeTab: 'upgrade', upgrade: { ...upgradeState, active: true } }, null],
  ['upgrade review', { activeTab: 'upgrade', upgrade: { ...upgradeState, active: true, analysis: upgrade } }, 'upgrade'],
  ['upgrade applying', { activeTab: 'upgrade', blockClose: true, upgrade: { ...upgradeState, active: true, analysis: upgrade, busy: true } }, null],
  ['upgrade error', { activeTab: 'upgrade', upgrade: { ...upgradeState, active: true, error: 'Read failed.' } }, null],
  ['upgrade result', { activeTab: 'upgrade', upgradeResult: result }, 'neutral'],
  ['removal loading', { activeTab: 'removal', removal: { ...removalState, active: true } }, null],
  ['removal review', { activeTab: 'removal', removal: { ...removalState, active: true, analysis: removal } }, 'removal'],
  ['removal applying', { activeTab: 'removal', removalRun: { phase: 'running', progress: 'installing' }, blockClose: true }, null],
  ['removal result', { activeTab: 'removal', removalRun: { phase: 'result', result: removalResult } }, 'neutral'],
  ['removal error', { activeTab: 'removal', removalRun: { phase: 'error', error: { code: 'ROLLBACK_FAILED', message: 'Restore failed.' } } }, 'neutral'],
  ['removal review error', { activeTab: 'removal', removal: { ...removalState, active: true, error: { code: 'FAILED', message: 'Read failed.' } } }, null],
]) test(`Manage dependency ${label} keeps one footer and its flow variant`, t => {
  const dom = mount(t, h(ManageDependencyModal, { ...manageProps, ...patch }));
  const { buttons } = checkFooter(dom.document, variant);
  if (label.endsWith('applying')) assert.ok(buttons.every(button => button.disabled));
  if (label === 'removal review') {
    assert.match(dom.document.querySelector('.manage-modal__body .removal-review__rollback').textContent, /A restore point will be created/);
    assert.equal(dom.document.querySelector('.dialog-footer .removal-review__rollback'), null);
  }
  assert.equal(dom.document.querySelector('.dialog-footer .manage-modal__footer-note'), null);
});

for (const reducedMotion of [false, true]) for (const makePath of [join, win32.join]) {
  test(`new Undo feedback scrolls without focus changes with reduced motion=${reducedMotion} and ${makePath === join ? 'native' : 'Windows'} paths`, t => {
    const undoId = 'undo-feedback';
    const entry = { analysisId: undoId, operation: 'upgrade', label: row.name };
    const element = h(ChangeResultModal, { result: { ...result, undoId }, enrichment: null, onClose: noop });
    const render = (openingId = null, error = null) => h(UndoBackupContext.Provider,
      { value: { entries: [entry], disabled: false, openingId, error, review: noop } }, element);
    const dom = mount(t, render());
    const scrolled = [];
    dom.window.matchMedia = query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return { matches: reducedMotion }; };
    dom.window.HTMLElement.prototype.scrollIntoView = function (options) {
      scrolled.push({ node: this, options, bodyFeedback: this.closest('.modal__body') !== null });
    };
    const focused = dom.document.querySelector('.dialog-footer > .dialog-footer__actions > button');
    focused.focus();
    dom.update(render(null, { id: 'another-backup', message: 'Unrelated error.' }));
    assert.equal(scrolled.length, 0);
    dom.update(render(undoId));
    assert.equal(scrolled.length, 1);
    assert.equal(scrolled[0].node.textContent, 'Opening the backup...');
    assert.equal(dom.document.activeElement, focused);
    const message = `Could not read ${makePath('fixture', 'saved', 'package.json')}.`;
    dom.update(render(null, { id: undoId, message }));
    assert.equal(scrolled.length, 2);
    assert.equal(scrolled[1].node.textContent, `Couldn't open the backup. ${message}`);
    assert.equal(scrolled[1].node.getAttribute('role'), 'alert');
    assert.equal(dom.document.activeElement, focused);
    assert.ok(scrolled.every(({ bodyFeedback, options }) => bodyFeedback &&
      options.block === 'start' && options.inline === 'nearest' && options.behavior === (reducedMotion ? 'instant' : 'smooth')));
    dom.update(render(null, { id: undoId, message }));
    assert.equal(scrolled.length, 2, 'unrelated rerenders leave the user scroll position alone');
    dom.update(render());
    assert.equal(scrolled.length, 2, 'clearing feedback does not scroll');
    dom.update(render(null, { id: undoId, message }));
    assert.equal(scrolled.length, 3, 'the same error is revealed again after it was cleared');
  });
}

for (const [Component, flow, ready] of [[UpgradeAnalysisModal, 'upgrade', upgrade], [RemoveAnalysisModal, 'removal', removal]]) {
  for (const state of (flow === 'removal' ? ['loading', 'review', 'applying'] : ['loading', 'review', 'applying', 'error'])) test(`${flow} analysis ${state} has a shared footer`, t => {
    const busy = state === 'applying';
    const dom = mount(t, h(Component, { packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo,
      packages: [row.name], matchTags: new Map(), analysis: ['review', 'applying'].includes(state) ? ready : null,
      error: state === 'error' ? 'Read failed.' : null, busy, hardStale: false, now, onConfirm: noop, onUseSmartPlan: noop,
      onCancel: noop, onRefresh: noop, onConfigureVerification: noop, onOpenAdvisory: noop }));
    const { buttons } = checkFooter(dom.document, state === 'review' || flow === 'removal' ? flow : null);
    if (busy) assert.ok(buttons.every(button => button.disabled));
  });
}
for (const state of ['upgrade', 'removal', 'removal error']) test(`standalone ${state} result has neutral Close last`, t => {
  const dom = mount(t, state === 'upgrade' ? h(ChangeResultModal, { result, enrichment: null, onClose: noop })
    : h(RemovalChangeResultModal, { outcome: state === 'removal' ? { result: removalResult }
      : { error: { code: 'ROLLBACK_FAILED', message: 'Restore failed.' }, details: { packages: [row.name], checks: [] } }, onClose: noop }));
  checkFooter(dom.document, 'neutral');
  assert.equal(dom.document.querySelector('.modal__body footer'), null);
});

for (const impactState of [{ phase: 'idle' }, { phase: 'analyzing', scanned: 0, total: 1 }, impact, { phase: 'error', message: 'Read failed.' }]) {
  test(`bulk manage select and review with ${impactState.phase} impact`, t => {
    const dom = mount(t, h(ManageDependenciesModal, { rows: [row], hygieneFindings: [], initialCriteria: { updates: new Set(['major-update']), severity: new Set(), health: new Set(), type: new Set() },
      cleanupBusy: false, removalImpact: impactState, onRecheckHealth: noop, onBulkUpgrade: noop, onBulkRemove: noop,
      onAnalyzeRemovalImpact: noop, onCancelRemovalImpact: noop, onClose: noop }));
    const { buttons } = checkFooter(dom.document, 'neutral');
    assert.equal(buttons.at(-1).disabled, false);
    act(() => buttons.at(-1).click());
    const reviewed = checkFooter(dom.document, 'upgrade');
    assert.equal(reviewed.footer.querySelector('.button--removal') !== null, impactState.phase !== 'analyzing');
    assert.deepEqual([...reviewed.footer.querySelectorAll('.dialog-footer__navigation button')].map(button => button.textContent.trim()), ['Close', 'Back']);
    assert.equal(reviewed.buttons.some(button => button.textContent === 'Cancel'), impactState.phase === 'analyzing');
  });
}

const cleanupResult = { analysisId: 'cleanup', metrics: [], completedActionIds: [], skippedActionIds: [], failedActionIds: [], resolvedAdvisories: [],
  introducedAdvisories: [], verification: 'not-configured', rollback: 'not-needed' };
const cleanupPlan = { planId: 'cleanup', projectName: 'fixture', generatedAt: new Date(now).toISOString(), recommendations: [], deprecated: [], security: [] };
for (const changed of [false, true]) test(`restoration status retains its original result guard with changed=${changed}`, t => {
  const state = { ...createSmartCleanupState('fixture'), phase: 'rolling-back', result: cleanupResult,
    restore: changed ? { status: 'changed', analysisId: cleanupResult.analysisId, message: 'Project changed.' } : null };
  const dom = mount(t, h(SmartCleanupWorkspace, { state, dispatch: noop, onClose: noop, onAnalyze: noop, onCancelAnalysis: noop,
    removalPreflight: null, preflightBusy: false, onPrepareRemoval: noop, onConfirmRemoval: noop, onKeepDependency: noop,
    onBackToReview: noop, onOpenDependencyReview: noop }));
  assert.deepEqual([...dom.document.querySelectorAll('.dialog-footer__status')].map(node => node.textContent),
    changed ? [] : ['Restoration in progress…']);
});
for (const phase of ['unknown', 'analyzing', 'ready', 'partial', 'confirming', 'executing', 'rolling-back', 'complete', 'incomplete', 'cancelled-rolled-back', 'stale', 'cancelled', 'empty', 'unsupported', 'failed']) {
  test(`Smart Cleanup ${phase} has one visible external footer`, t => {
    const state = { ...createSmartCleanupState('fixture'), phase, plan: cleanupPlan,
      result: ['complete', 'incomplete', 'cancelled-rolled-back'].includes(phase) ? cleanupResult : null };
    const dom = mount(t, h(SmartCleanupWorkspace, { state, dispatch: noop, onClose: noop, onAnalyze: noop, onCancelAnalysis: noop,
      removalPreflight: null, preflightBusy: false, onPrepareRemoval: noop, onConfirmRemoval: noop, onKeepDependency: noop,
      onBackToReview: noop, onOpenDependencyReview: noop }));
    const { buttons } = checkFooter(dom.document, ['unknown', 'analyzing', 'executing', 'rolling-back', 'empty', 'unsupported'].includes(phase) ? null : 'neutral');
    assert.equal(dom.document.querySelector('.dialog-footer .dialog-footer__status'), null);
    if (phase === 'rolling-back') assert.equal(dom.document.querySelector('.smart-cleanup-body .dialog-footer__status').textContent, 'Restoration in progress…');
    if (['executing', 'rolling-back'].includes(phase)) assert.ok(buttons.every(button => button.disabled));
  });
}
for (const rollbackAvailable of [false, true]) for (const applying of [false, true]) {
  test(`removal restore note retains rollback=${rollbackAvailable} and applying=${applying} guards`, t => {
    const dom = mount(t, h(ManageDependencyModal, { ...manageProps, activeTab: 'removal',
      removalRun: applying ? { phase: 'running', progress: 'installing' } : null,
      removal: { ...removalState, active: true, busy: applying, analysis: { ...removal, files: { ...files, rollbackAvailable } } } }));
    const notes = [...dom.document.querySelectorAll('.removal-review__rollback')];
    assert.equal(notes.length, rollbackAvailable && !applying ? 1 : 0);
    if (notes.length) {
      assert.equal(notes[0].textContent.trim(), 'A restore point will be created before removing.Packageawy restores your dependency files and stops if it sees they changed.');
      assert.ok(notes[0].closest('.manage-modal__body'));
    }
  });
}
for (const makePath of [join, win32.join]) test(`relocated removal footer preserves ${makePath === join ? 'native' : 'Windows'} file paths and handlers`, t => {
  let confirmed = 0, closed = 0;
  const dom = mount(t, h(ManageDependencyModal, { ...manageProps, activeTab: 'removal', onClose: () => closed++,
    removal: { ...removalState, active: true, analysis: { ...removal, files: { ...files,
      manifestPath: makePath('fixture', 'package.json'), lockfilePath: makePath('fixture', 'package-lock.json') } }, onConfirm: () => confirmed++ } }));
  const { footer } = checkFooter(dom.document, 'removal');
  act(() => footer.querySelector('.button--removal').click());
  act(() => footer.querySelector('.button--secondary').click());
  assert.equal(confirmed, 1); assert.equal(closed, 1);
  const paths = [...dom.document.querySelectorAll('.upgrade-files-list__item')].map(node => node.textContent);
  assert.ok(paths.some(text => text.includes('package.json')));
  assert.ok(paths.every(text => !/fixture[\\/]/.test(text)));
});

test('footer layout wraps actions in DOM order and contains no retired sticky rows', () => {
  assert.match(css, /\.modal\s*\{[^}]*display: flex;[^}]*flex-direction: column/s);
  for (const body of ['modal__body', 'manage-modal__body', 'smart-cleanup-body']) {
    const rules = [...css.matchAll(new RegExp(`\\.${body}\\s*\\{([^}]+)`, 'g'))].map(match => match[1]).join('');
    assert.match(rules, /min-height: 0/);
    assert.match(rules, /overflow-y: auto/);
  }
  assert.match(css, /\.dialog-footer\s*\{[^}]*flex-wrap: wrap;[^}]*flex: 0 0 auto/s);
  assert.match(css, /\.dialog-footer__actions,[^}]*flex-wrap: wrap/s);
  assert.doesNotMatch(css, /\.dialog-footer \.button:disabled\s*\{/);
  assert.match(css, /\.button:disabled\s*\{[^}]*opacity: 0\.5;[^}]*cursor: default/s);
  assert.match(css, /\.button--removal:hover:not\(:disabled\)\s*\{[^}]*color: var\(--vscode-button-foreground\);[^}]*background: var\(--vscode-button-hoverBackground\);/s);
  assert.doesNotMatch(css, /\.button--removal:hover:not\(:disabled\)\s*\{[^}]*(?:text-decoration|text-underline)/s);
  assert.match(css, /\.dialog-footer \.button\[data-dialog-accent-fallback\]\s*\{[^}]*color: var\(--vscode-button-foreground\);[^}]*background: var\(--vscode-button-background\);/s);
  assert.doesNotMatch(css, /review-panel__footer|removal-review__footer|change-result__actions|smart-cleanup-footer|column-reverse/);
  assert.match(css, /\.button:focus-visible[^}]*outline: 2px solid var\(--vscode-focusBorder/s);
  assert.match(css, /vscode-high-contrast-light \.dialog-footer \.button--primary[^}]*--vscode-button-foreground[^}]*--vscode-contrastBorder/s);
});

test('short and narrow viewport CSS keeps the fixed footer compact and lets the body shrink', () => {
  // CSS contracts only. JSDOM cannot verify the 250 x 300 layout geometry.
  const compact = css.slice(css.indexOf('@media (max-height: 24rem), (max-width: 26rem)'));
  assert.match(compact, /\.dialog-footer,\s*\.manage-modal > \.modal__footer\s*\{[^}]*gap: 0\.35rem;[^}]*padding: 0\.35rem 0\.5rem;/s);
  assert.match(compact, /\.dialog-footer__actions,\s*\.dialog-footer__navigation\s*\{[^}]*gap: 0\.35rem;/s);
  assert.match(compact, /\.dialog-footer \.button\s*\{[^}]*min-width: 0;[^}]*min-height: 1\.75rem;[^}]*padding: 0\.25rem 0\.45rem;/s);
  assert.match(compact, /@media \(max-height: 24rem\)\s*\{[^]*?\.manage-modal \.manage-tabs__tab\s*\{[^}]*min-height: 1\.75rem;/);
  assert.match(compact, /\.modal__body,\s*\.manage-modal \.manage-modal__body\s*\{[^}]*padding: 0\.4rem 0\.6rem;/s);
  assert.match(css, /\.dialog-footer__navigation\s*\{[^}]*margin-left: 0;[^}]*justify-content: flex-start;/s);
  assert.match(css, /\.dialog-footer \.button\s*\{[^}]*max-width: 100%;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s);
});

const luminance = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
for (const [theme, upgradeFill, removalFill, neutralFill, neutralText] of [
  ['dark', '#b180d7', '#d18616', '#0078d4', '#ffffff'],
  ['light', '#652d90', '#d18616', '#005fb8', '#ffffff'],
  ['high contrast dark', '#000000', '#000000', '#000000', '#ffffff'],
  ['high contrast light', '#0f4a85', '#0f4a85', '#0f4a85', '#ffffff'],
]) test(`${theme} filled button contrast is at least 4.5:1`, () => {
  const surface = theme === 'light' ? '#ffffff' : '#252526';
  for (const fill of [upgradeFill, removalFill]) {
    const foreground = theme.startsWith('high') ? null : filledButtonForeground(fill, surface);
    assert.ok(contrast(foreground === null ? neutralFill : fill, foreground ?? neutralText) >= 4.5);
  }
  assert.ok(contrast(neutralFill, neutralText) >= 4.5);
});
test('accent foreground selection handles computed colors and arbitrary custom accents', () => {
  assert.equal(filledButtonForeground('rgb(177, 128, 215)', '#252526'), '#000000');
  assert.equal(filledButtonForeground('color(srgb 0.396 0.176 0.565)', '#ffffff'), '#ffffff');
  assert.equal(filledButtonForeground('unresolved', '#ffffff'), null);
  for (let red = 0; red <= 255; red += 17) for (let green = 0; green <= 255; green += 17) for (let blue = 0; blue <= 255; blue += 17) {
    const fill = `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`;
    assert.ok(contrast(fill, filledButtonForeground(fill, '#ffffff') ?? filledButtonForeground(fill, '#000000')) >= 4.5);
  }
});

for (const [surface, accents, composited, expected] of [
  ['#ffffff', ['rgba(0, 0, 0, 0.5)', 'rgb(0 0 0 / 50%)', 'color(srgb 0 0 0 / 0.5)', '#00000080', '#0008'], '#808080', '#000000'],
  ['#202020', ['rgba(255, 255, 255, 0.35)', 'rgb(100% 100% 100% / 35%)', 'color(srgb 1 1 1 / 35%)', '#ffffff59'], '#6e6e6e', '#ffffff'],
]) test(`translucent accents choose readable text after compositing over ${surface}`, () => {
  for (const accent of accents) assert.equal(filledButtonForeground(accent, surface), expected, accent);
  assert.ok(contrast(composited, expected) >= 4.5);
});

test('transparent, indistinct or unparseable fills and unknown surfaces request the host button pair', () => {
  for (const surface of ['#ffffff', '#202020']) {
    for (const accent of ['transparent', '#0000', '#ffffff00', 'rgba(120, 120, 120, 0.01)', 'rgb(1 2)', 'rgba(1, 2, 3, invalid)', 'rgb(1, 2, 3) trailing', 'color(display-p3 1 0 0)', 'unresolved']) {
      assert.equal(filledButtonForeground(accent, surface), null, accent);
    }
    assert.equal(filledButtonForeground(surface, surface), null);
  }
  assert.equal(filledButtonForeground('#000000', 'transparent'), null);
  assert.equal(filledButtonForeground('#000000', 'unresolved'), null);
  assert.equal(filledButtonForeground('#ffffff', ['transparent', 'rgba(0, 0, 0, 0.5)', '#ffffff']), '#000000');
  assert.equal(filledButtonForeground('#000000', ['transparent', '#ffffff', 'unresolved']), '#ffffff');
});

test('portaled upgrade actions keep Cancel focus and the exact security consent gate', t => {
  let confirmed;
  const security = { status: 'remains', checkState: 'complete', resolvedAdvisories: [], remaining: [], introduced: [{
    advisory: { id: 'introduced', title: 'Known issue', severity: 'high', vulnerableVersions: '>=2' },
    flaggedPackage: row.name, path: [row.name], resolvedVersion: row.upgradeTo, patchedVersion: { status: 'unknown' }, status: 'remains',
  }] };
  const props = { ...manageProps, activeTab: 'upgrade', upgrade: { ...upgradeState, active: true, onConfirm: acknowledged => { confirmed = acknowledged; } } };
  const dom = mount(t, h(ManageDependencyModal, props));
  const cancel = dom.document.querySelector('.dialog-footer button'); cancel.focus();
  const value = { ...upgrade, security };
  const ready = { ...props, upgrade: { ...props.upgrade, analysis: value } };
  dom.update(h(ManageDependencyModal, ready));
  assert.equal(dom.document.querySelector('.dialog-footer button') === cancel, true);
  assert.equal(dom.document.activeElement === cancel, true);
  const confirm = dom.document.querySelector('.dialog-footer .button--upgrade');
  assert.equal(confirm.disabled, true);
  const consent = dom.document.querySelector('.upgrade-security-acknowledgement input');
  act(() => consent.click());
  assert.equal(confirm.disabled, false);
  act(() => confirm.click());
  assert.equal(confirmed, true);
  dom.update(h(ManageDependencyModal, { ...ready, upgrade: { ...ready.upgrade, analysis: { ...value, analysisId: 'new-review' } } }));
  assert.equal(dom.document.querySelector('.dialog-footer .button--upgrade').disabled, true);
});

test('accent text recomputes when VS Code or JetBrains updates theme styles', async t => {
  const dom = mount(t, h(ManageDependencyModal, { ...manageProps, activeTab: 'removal', removal: { ...removalState, active: true, analysis: removal } }));
  const button = dom.document.querySelector('.button--removal');
  const style = dom.document.createElement('style');
  const theme = (fill, surface) => `.modal {background: ${surface}} .dialog-footer {background: transparent} .button--removal {--dialog-accent-background: ${fill}; background: ${fill}}`;
  await act(async () => { style.textContent = theme('rgb(209, 134, 22)', '#202020'); dom.document.head.append(style); await Promise.resolve(); });
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '#000000');
  await act(async () => { style.textContent = `${theme('rgb(209, 134, 22)', '#202020')} .button--removal {background: #0078d4}`; await Promise.resolve(); });
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '#000000', 'the hover fill does not choose text for the accent after hover ends');
  assert.equal(button.style.getPropertyValue('background-color'), '', 'temporary color resolution leaves the authored background intact');
  await act(async () => { style.textContent = theme('rgb(40, 20, 60)', '#ffffff'); await Promise.resolve(); });
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '#ffffff');
  await act(async () => { dom.document.body.className = 'vscode-light'; style.textContent = theme('rgb(250, 180, 30)', '#202020'); await Promise.resolve(); });
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '#000000');
  await act(async () => { style.textContent = theme('rgba(0, 0, 0, 0.5)', '#ffffff'); await Promise.resolve(); });
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '#000000');
  assert.equal(button.hasAttribute('data-dialog-accent-fallback'), false);
  await act(async () => { style.textContent = theme('rgba(0, 0, 0, 0.01)', '#ffffff'); await Promise.resolve(); });
  assert.equal(button.hasAttribute('data-dialog-accent-fallback'), true);
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '');
  await act(async () => { style.textContent = theme('color(display-p3 1 0 0)', '#ffffff'); await Promise.resolve(); });
  assert.equal(button.hasAttribute('data-dialog-accent-fallback'), true);
  await act(async () => { dom.document.documentElement.style.setProperty('--vscode-editorWidget-background', '#202020'); style.textContent = theme('rgba(255, 255, 255, 0.35)', '#202020'); await Promise.resolve(); });
  assert.equal(button.hasAttribute('data-dialog-accent-fallback'), false);
  assert.equal(button.style.getPropertyValue('--dialog-accent-foreground'), '#ffffff');
});

test('bulk impact cancellation replaces removal, restores it afterwards and preserves navigation and upgrade rules', t => {
  let cancelled = 0, closed = 0, upgraded;
  const props = { rows: [row], hygieneFindings: [], initialCriteria: { updates: new Set(['major-update']), severity: new Set(), health: new Set(), type: new Set() },
    cleanupBusy: false, removalImpact: { phase: 'idle' }, onRecheckHealth: noop, onBulkUpgrade: rows => { upgraded = rows; }, onBulkRemove: noop,
    onAnalyzeRemovalImpact: noop, onCancelRemovalImpact: () => cancelled++, onClose: () => closed++ };
  const dom = mount(t, h(ManageDependenciesModal, props));
  act(() => checkFooter(dom.document).buttons.at(-1).click());
  dom.update(h(ManageDependenciesModal, { ...props, removalImpact: { phase: 'analyzing', scanned: 0, total: 1 } }));
  const { footer, buttons } = checkFooter(dom.document, 'upgrade');
  assert.deepEqual(buttons.map(button => button.textContent.trim()), ['Close', 'Back', 'Cancel', 'Upgrade 1']);
  assert.equal(footer.querySelector('.button--removal'), null);
  assert.equal(buttons.at(-1).disabled, false);
  act(() => buttons[2].click());
  assert.equal(cancelled, 1);
  for (const removalImpact of [{ phase: 'idle' }, impact, { phase: 'error', message: 'Read failed.' }]) {
    dom.update(h(ManageDependenciesModal, { ...props, removalImpact }));
    const restored = checkFooter(dom.document, 'upgrade');
    assert.ok(restored.footer.querySelector('.button--removal'));
    assert.equal(restored.buttons.some(button => button.textContent.trim() === 'Cancel'), false);
  }
  act(() => footer.querySelector('.button--upgrade').click());
  assert.deepEqual(upgraded.map(candidate => candidate.packageName), [row.name]);
  dom.update(h(ManageDependenciesModal, { ...props, rows: [{ ...row, upgradeTo: null }], removalImpact: { phase: 'analyzing', scanned: 0, total: 1 } }));
  assert.equal(footer.querySelector('.button--upgrade').disabled, true);
  act(() => footer.querySelector('.dialog-footer__navigation button:last-child').click());
  assert.match(dom.document.querySelector('#manage-dependencies-title').textContent, /Manage dependencies/);
  act(() => footer.querySelector('.dialog-footer__navigation button').click());
  assert.equal(closed, 2);
});

for (const status of ['available', 'restoring', 'changed', 'restored', 'resolved', 'refused']) test(`Smart Cleanup ${status} restore state retains a neutral Close`, t => {
  const state = { ...createSmartCleanupState('fixture'), phase: 'complete', result: cleanupResult,
    restore: { status, analysisId: cleanupResult.analysisId, message: 'Project changed.' } };
  const dom = mount(t, h(SmartCleanupWorkspace, { state, dispatch: noop, onClose: noop, onAnalyze: noop, onCancelAnalysis: noop,
    removalPreflight: null, preflightBusy: false, onPrepareRemoval: noop, onConfirmRemoval: noop, onKeepDependency: noop,
    onBackToReview: noop, onOpenDependencyReview: noop, onRestoreFiles: noop }));
  const { buttons } = checkFooter(dom.document, 'neutral');
  assert.equal(buttons.at(-1).disabled, status === 'restoring');
});

test('Smart Cleanup final confirmation uses neutral fill and keeps the host analysis id', t => {
  let confirmed;
  const recommendation = { id: 'remove-direct:alpha', kind: 'remove-direct-dependency', packageName: row.name, dependencyType: 'production', confidence: 'safe', rationale: 'Unused', evidence: [] };
  const state = { ...createSmartCleanupState('fixture'), phase: 'confirming', plan: { ...cleanupPlan, recommendations: [recommendation] }, selectedActionIds: new Set([recommendation.id]) };
  const dom = mount(t, h(SmartCleanupWorkspace, { state, dispatch: noop, onClose: noop, onAnalyze: noop, onCancelAnalysis: noop,
    removalPreflight: removal, preflightBusy: false, onPrepareRemoval: noop, onConfirmRemoval: id => { confirmed = id; }, onKeepDependency: noop,
    onBackToReview: noop, onOpenDependencyReview: noop }));
  const { buttons } = checkFooter(dom.document, 'neutral');
  act(() => buttons.at(-1).click());
  assert.equal(confirmed, removal.analysisId);
});

for (const phase of ['plan', 'reviewed', 'applying', 'cancelling', 'result']) test(`Manage transitive ${phase} actions live in the shared footer`, t => {
  let applied, cancelled;
  const plan = { analysisId: 'fix', rootPackage: row.name, currentVersion: row.current, packageManager: 'npm', outcome: 'safe',
    changes: [{ packageName: 'child', fromVersions: ['1.0.0'], toVersions: ['1.0.1'], affectedPaths: [[row.name, 'child']], targeted: true }],
    files, verification: { configured: false, suggestedScriptNames: [] }, resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] };
  const applying = phase === 'applying' || phase === 'cancelling';
  const remediation = applying ? { phase: 'applying', plan, progress: 'installing', cancelRequested: phase === 'cancelling' }
    : phase === 'result' ? { phase: 'result', plan, result: { outcome: 'verified', rollback: 'not-needed', verification: 'passed', message: 'Fix finished.', resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] } }
    : { phase: 'plan', plan, reviewed: phase === 'reviewed' };
  const dom = mount(t, h(ManageDependencyModal, { ...manageProps, remediation, blockClose: applying,
    onApplyRemediation: id => { applied = id; }, onCancelRemediation: id => { cancelled = id; } }));
  const { footer } = checkFooter(dom.document, applying ? null : 'neutral');
  assert.equal(dom.document.querySelector('.manage-modal__body .dialog-footer__standalone-actions'), null);
  if (phase === 'reviewed') {
    act(() => footer.querySelector('.button--primary').click());
    assert.equal(applied, plan.analysisId);
  }
  if (applying) {
    const button = [...footer.querySelectorAll('button')].find(button => /Cancel fix|Cancelling/.test(button.textContent));
    assert.equal(button.disabled, phase === 'cancelling');
    if (!button.disabled) { act(() => button.click()); assert.equal(cancelled, plan.analysisId); }
  }
});

for (const phase of ['unavailable', 'no-fix', 'unsafe', 'error', 'stale']) for (const disabled of [false, true]) {
  test(`Manage transitive ${phase} retry stays in the footer with disabled=${disabled}`, t => {
    let analyzed = 0, retried;
    const plan = { analysisId: 'retry-fix', rootPackage: row.name, currentVersion: row.current, packageManager: 'npm', outcome: phase,
      explanation: 'No fix is available.', blockingReasons: [], changes: [], files, verification: { configured: false, suggestedScriptNames: [] },
      resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] };
    const remediation = phase === 'error' ? { phase, message: 'Read failed.' }
      : phase === 'stale' ? { phase, plan: { ...plan, outcome: 'safe' }, message: 'Review changed.' }
      : { phase: 'plan', plan, reviewed: false };
    const dom = mount(t, h(ManageDependencyModal, { ...manageProps, remediation, upgradeDisabled: disabled,
      onAnalyzeRemediation: name => { assert.equal(name, row.name); analyzed++; }, onRetryRemediation: id => { retried = id; } }));
    const { footer } = checkFooter(dom.document, 'neutral');
    const button = footer.querySelector('.button--primary');
    assert.equal(button.textContent.trim(), phase === 'error' ? 'Try again' : phase === 'stale' ? 'Re-check fix' : 'Check again');
    assert.equal(button.disabled, disabled);
    assert.equal(dom.document.querySelector('.manage-modal__body .banner__action'), null);
    act(() => button.click());
    assert.equal(analyzed, !disabled && phase === 'error' ? 1 : 0);
    assert.equal(retried, !disabled && phase !== 'error' ? plan.analysisId : undefined);
  });
}

test('dialog footer controls fit short and narrow viewports in both host themes', {
  skip: !process.env.PACKAGEAWY_CHROMIUM_PATH && 'Set PACKAGEAWY_CHROMIUM_PATH to run rendered footer geometry checks',
  timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'packageawy-footer-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bulk = { rows: [row], hygieneFindings: [], initialCriteria: { updates: new Set(['major-update']), severity: new Set(), health: new Set(), type: new Set() },
    cleanupBusy: false, onRecheckHealth: noop, onBulkUpgrade: noop, onBulkRemove: noop,
    onAnalyzeRemovalImpact: noop, onCancelRemovalImpact: noop, onClose: noop };
  const cases = [
    { name: 'removal review', props: { ...manageProps, activeTab: 'removal', removal: { ...removalState, active: true, analysis: removal } } },
    { name: 'scoped removal review', props: { ...manageProps, row: { ...row, name: '@typescript-eslint/eslint-plugin' }, activeTab: 'removal', removal: { ...removalState, active: true, analysis: { ...removal, changes: [{ ...removal.changes[0], packageName: '@typescript-eslint/eslint-plugin' }] } } } },
    { name: 'removal error', props: { ...manageProps, activeTab: 'removal', removal: { ...removalState, active: true, error: { code: 'FAILED', message: 'Read failed.' } } } },
    { name: 'upgrade review', props: { ...manageProps, activeTab: 'upgrade', upgrade: { ...upgradeState, active: true, analysis: upgrade } } },
    { name: 'transitive error', props: { ...manageProps, remediation: { phase: 'error', message: 'Read failed.' } } },
    { name: 'bulk select', bulk: true, props: { ...bulk, removalImpact: impact } },
    { name: 'bulk review', bulk: true, review: true, props: { ...bulk, removalImpact: impact } },
    { name: 'bulk analyzing', bulk: true, review: true, props: { ...bulk, removalImpact: { phase: 'analyzing', scanned: 0, total: 1 } } },
  ];
  for (const makePath of [join, win32.join]) for (const pending of [true, false]) for (const surface of ['upgrade result', 'removal result', 'manage result']) {
    const undoId = 'undo-layout';
    const message = `The backup at ${makePath('fixture', 'saved', 'package.json')} could not be read. ` + 'The saved dependency files are unavailable. '.repeat(30);
    cases.push({ name: `${surface} Undo ${pending ? 'pending' : 'failed'} ${makePath === join ? 'native' : 'Windows'}`, surface,
      props: surface === 'manage result' ? { ...manageProps, activeTab: 'upgrade', upgradeResult: { ...result, undoId } }
        : surface === 'removal result' ? { outcome: { result: { ...removalResult, undoId } }, onClose: noop }
          : { result: { ...result, undoId }, enrichment: null, onClose: noop },
      undo: { entries: [{ analysisId: undoId, operation: surface === 'removal result' ? 'removal' : 'upgrade', label: 'fixture' }],
        disabled: false, openingId: pending ? undoId : null, error: pending ? null : { id: undoId, message }, review: noop } });
  }
  const serialized = JSON.stringify(cases, (_key, value) => typeof value === 'function' ? { fixtureType: 'function' }
    : value instanceof Map ? { fixtureType: 'map', entries: [...value] }
      : value instanceof Set ? { fixtureType: 'set', entries: [...value] } : value);
  const fixture = await build({ stdin: { contents: `
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
    import { ManageDependenciesModal } from './webview/src/components/ManageDependenciesModal.tsx';
    import { ChangeResultModal, RemovalChangeResultModal } from './webview/src/components/ChangeResultModal.tsx';
    import { UndoBackupContext } from './webview/src/components/UndoChangeButton.tsx';
    const cases = JSON.parse(${JSON.stringify(serialized)}, (_key, value) => value?.fixtureType === 'function' ? () => {}
      : value?.fixtureType === 'map' ? new Map(value.entries) : value?.fixtureType === 'set' ? new Set(value.entries) : value);
    const root = createRoot(document.getElementById('root'));
    const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    window.measurements = [];
    for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light', 'jetbrains-dark', 'jetbrains-light']) {
      const light = theme.endsWith('light');
      const highContrast = theme.includes('high-contrast');
      document.body.className = theme.startsWith('jetbrains') ? theme + (light ? ' vscode-light' : ' vscode-dark') : theme;
      const variables = {
        'editor-background': light ? '#ffffff' : '#1f1f1f', 'editorWidget-background': light ? '#f3f3f3' : '#252526',
        'foreground': light ? '#333333' : '#cccccc', 'descriptionForeground': light ? '#616161' : '#a6a6a6',
        'panel-border': light ? '#cccccc' : '#454545', 'button-background': light ? '#005fb8' : '#0078d4',
        'button-foreground': '#ffffff', 'button-hoverBackground': light ? '#005096' : '#026ec1',
        'button-secondaryBackground': light ? '#e5e5e5' : '#3a3d41', 'button-secondaryForeground': light ? '#333333' : '#ffffff',
        'focusBorder': light ? '#005fb8' : '#ffffff', 'charts-purple': light ? '#652d90' : '#b180d7', 'charts-orange': '#d18616',
      };
      for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty('--vscode-' + name, value);
      if (highContrast) document.documentElement.style.setProperty('--vscode-contrastBorder', light ? '#000000' : '#ffffff');
      else document.documentElement.style.removeProperty('--vscode-contrastBorder');
      for (const entry of cases) {
        const Component = entry.surface === 'upgrade result' ? ChangeResultModal : entry.surface === 'removal result' ? RemovalChangeResultModal
          : entry.bulk ? ManageDependenciesModal : ManageDependencyModal;
        const element = h(Component, { ...entry.props, key: theme + entry.name });
        const render = undo => flushSync(() => root.render(undo ? h(UndoBackupContext.Provider, { value: undo }, element) : element));
        // Keep the same mounted dialog through idle, opening and failure. A new mount can hide a scroll regression.
        render(entry.undo ? { ...entry.undo, openingId: null, error: null } : null);
        const transitions = [];
        if (entry.undo) {
          const focused = document.querySelector('.dialog-footer .button--primary');
          focused.focus();
          const states = [{ ...entry.undo, openingId: entry.undo.entries[0].analysisId, error: null }];
          if (entry.undo.error) states.push(entry.undo);
          for (const state of states) {
            render(state);
            const feedback = document.querySelector('.undo-change-feedback');
            let body = feedback.parentElement;
            while (body && !['auto', 'scroll'].includes(getComputedStyle(body).overflowY)) body = body.parentElement;
            transitions.push({ feedback: bounds(feedback), body: bounds(body), focusKept: document.activeElement === focused,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, scrollTop: body.scrollTop });
          }
        }
        if (entry.review) flushSync(() => document.querySelector('.dialog-footer__actions button').click());
        const dialog = document.querySelector('[role="dialog"]');
        const footer = dialog.querySelector('.dialog-footer');
        // Capture every initial bound before focus can scroll clipped controls into view.
        const controls = [...footer.querySelectorAll('button')];
        const buttons = controls.map(button => ({ ...bounds(button), label: button.textContent.trim() }));
        const scroll = dialog.querySelector('.manage-modal__scroll');
        const initial = { name: entry.name, theme, viewport: { width: innerWidth, height: innerHeight },
          dialog: bounds(dialog), footer: bounds(footer), buttons,
          scroll: scroll ? { ...bounds(scroll), scrollable: scroll.scrollHeight > scroll.clientHeight } : null,
          bodyNotes: [...dialog.querySelectorAll('.manage-modal__footer-note')].every(note => note.closest('.manage-modal__body') !== null),
          footerFeedback: footer.querySelectorAll('.banner, [role="status"], [role="alert"], .manage-modal__footer-note').length };
        if (entry.undo) {
          const pending = entry.undo.openingId != null;
          const feedback = [...dialog.querySelectorAll(pending ? '[role="status"]' : '[role="alert"]')]
            .find(node => node.textContent.includes(pending ? 'Opening the backup...' : "Couldn't open the backup."));
          initial.undo = { bodyFeedback: !!feedback?.closest('.modal__body, .manage-modal__body'),
            live: pending ? feedback?.getAttribute('aria-live') === 'polite' : feedback?.getAttribute('role') === 'alert',
            disabled: footer.querySelector('[data-undo-id]')?.disabled, busy: footer.querySelector('[data-undo-id]')?.getAttribute('aria-busy'), pending, transitions };
        }
        controls.forEach((button, index) => {
          if (!button.disabled) button.focus();
          Object.assign(buttons[index], { focusable: button.disabled || document.activeElement === button,
            focusOutline: button.disabled || getComputedStyle(button).outlineStyle !== 'none' });
        });
        window.measurements.push(initial);
      }
    }
    root.unmount();
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
  const childHtml = `<!doctype html><style>${css}
    :root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
    </style><div id="root"></div><script>${fixture.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
  const sizes = [[250, 300], [400, 300], [1100, 300], [250, 700], [1100, 800]];
  const fixturePath = join(directory, 'footer.html');
  await writeFile(fixturePath, `<!doctype html><pre id="measurements"></pre><script>
    const results = [];
    for (const [width, height] of ${JSON.stringify(sizes)}) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'border: 0; width: ' + width + 'px; height: ' + height + 'px';
      document.body.append(frame);
      frame.contentDocument.open(); frame.contentDocument.write(${JSON.stringify(childHtml).replaceAll('</script', '<\\/script')}); frame.contentDocument.close();
      results.push(...frame.contentWindow.measurements);
      frame.remove();
    }
    document.getElementById('measurements').textContent = JSON.stringify(results);
    </script>`);
  const { stdout } = await promisify(execFile)(process.env.PACKAGEAWY_CHROMIUM_PATH, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--force-prefers-reduced-motion',
    `--user-data-dir=${join(directory, 'profile')}`, '--dump-dom', pathToFileURL(fixturePath).href,
  ], { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 });
  const dom = new JSDOM(stdout);
  t.after(() => dom.window.close());
  const measurements = JSON.parse(dom.window.document.querySelector('#measurements').textContent);
  assert.equal(measurements.length, cases.length * 6 * sizes.length);
  for (const result of measurements) {
    const label = `${result.name}, ${result.theme}, ${result.viewport.width} x ${result.viewport.height}`;
    assert.ok(sizes.some(([width, height]) => result.viewport.width === width && result.viewport.height === height), label);
    assert.ok(result.dialog.top >= -1 && result.dialog.bottom <= result.viewport.height + 1, `${label}: dialog fits vertically`);
    assert.ok(result.footer.top >= result.dialog.top - 1 && result.footer.bottom <= result.dialog.bottom + 1, `${label}: footer fits in dialog`);
    assert.equal(result.footerFeedback, 0, `${label}: only controls belong in the footer`);
    if (result.scroll && result.viewport.height === 300) {
      assert.ok(result.scroll.height >= 48, `${label}: header, tabs and body have usable scrolling space`);
      assert.equal(result.scroll.scrollable, true, `${label}: overflowing content shares a scroll area`);
    }
    if (result.undo) {
      assert.equal(result.undo.bodyFeedback, true, `${label}: Undo feedback scrolls in the body`);
      assert.equal(result.undo.live, true, `${label}: Undo feedback keeps its live announcement`);
      assert.equal(result.undo.disabled, result.undo.pending, `${label}: pending Undo stays disabled`);
      assert.equal(result.undo.busy, String(result.undo.pending), `${label}: Undo busy state is preserved`);
      assert.equal(result.undo.transitions.length, result.undo.pending ? 1 : 2, `${label}: feedback updates in the same mounted dialog`);
      for (const transition of result.undo.transitions) {
        assert.equal(transition.reducedMotion, true, `${label}: Chromium uses reduced motion for immediate geometry checks`);
        assert.equal(transition.focusKept, true, `${label}: new feedback leaves keyboard focus alone`);
        assert.ok(transition.feedback.top >= transition.body.top - 1 &&
          transition.feedback.top + Math.min(20, transition.feedback.height) <= transition.body.bottom + 1,
        `${label}: newly shown feedback starts inside the scrolling body (${JSON.stringify(transition)})`);
        if (result.viewport.height === 300) assert.ok(transition.scrollTop > 0, `${label}: the body scrolls to reveal feedback`);
      }
    }
    assert.equal(result.bodyNotes, true, `${label}: long notes scroll with the body`);
    for (const button of result.buttons) {
      assert.ok(button.width > 0 && button.height > 0, `${label}: ${button.label} is visible`);
      assert.ok(button.top >= result.footer.top - 1 && button.bottom <= result.footer.bottom + 1, `${label}: ${button.label} fits vertically`);
      assert.ok(button.left >= Math.max(result.dialog.left, 0) - 1 && button.right <= Math.min(result.dialog.right, result.viewport.width) + 1, `${label}: ${button.label} fits horizontally`);
      assert.equal(button.focusable, true, `${label}: ${button.label} accepts keyboard focus`);
      assert.equal(button.focusOutline, true, `${label}: ${button.label} shows focus`);
    }
  }
});
