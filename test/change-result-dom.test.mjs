import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

const bundle = await build({ stdin: { contents: `export { ChangeResult, UpgradeChangeResult, ChangeResultContext } from './webview/src/components/ChangeResult.tsx';
export { ChangeResultModal, RemovalChangeResultModal } from './webview/src/components/ChangeResultModal.tsx';
export { RemovalResultPanel, RemovalErrorPanel } from './webview/src/components/RemovalProgressPanels.tsx';
export { UndoBackupContext } from './webview/src/components/UndoChangeButton.tsx';
export { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
export { TransitiveFixReview } from './webview/src/components/TransitiveFixReview.tsx';
export { DependencyChangeContext } from './webview/src/components/DependencyChangeStatus.tsx';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic' });
const module = { exports: {} };
vm.runInThisContext(`(function(module,exports,require){${bundle.outputFiles[0].text}\n})`, { filename: join(process.cwd(), 'change-result.fixture.cjs') })(module, module.exports, createRequire(import.meta.url));
const { ManageDependencyModal, TransitiveFixReview, ChangeResult, UpgradeChangeResult, ChangeResultContext, ChangeResultModal, RemovalChangeResultModal, RemovalResultPanel, RemovalErrorPanel, UndoBackupContext, DependencyChangeContext } = module.exports;
const css = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
const undoId = 'a'.repeat(32);
const row = { name: 'chalk', current: '4.1.2', range: '^4.1.2' };
const install = { id: 'install-1', kind: 'install', command: 'npm install', status: 'passed', exitCode: 0 };
const script = (name, status = 'passed', extra = {}) => ({ id: `script-${name}`, kind: 'script', scriptName: name, command: `npm run ${name}`, status, ...(status === 'passed' ? { exitCode: 0 } : {}), ...extra });
const upgrade = checks => ({ undoId, package: 'chalk', refreshId: 'refresh-a', application: 'applied', install: 'succeeded', verification: 'passed', refreshingDerivedData: false, checks,
  changes: [{ packageName: 'chalk', previousVersion: '4.1.2', currentVersion: '5.4.1', requestedVersion: '5.4.1', declaredRange: '^5.4.1', classification: 'prod' }] });
function mount(t, component, options = {}) {
  const dom = new JSDOM('<!doctype html><button id="opener">Open</button><div id="root"></div>');
  const old = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { get() { return this.hidden ? null : this.parentElement; } });
  const styles = dom.window.document.createElement('style'); styles.textContent = css; dom.window.document.head.append(styles);
  const opener = document.querySelector('#opener'); opener.focus();
  const root = createRoot(document.querySelector('#root'));
  let analyzed = 0; const reviewed = []; const revealed = [];
  const wrap = (element, terminals = new Map()) => h(DependencyChangeContext.Provider, { value: { task: 'idle', blocked: options.blocked ?? false, openRecovery() {} } },
    h(ChangeResultContext.Provider, { value: { analyze: () => analyzed++, reveal: id => revealed.push(id), terminals } },
      h(UndoBackupContext.Provider, { value: { entries: options.backup === false ? [] : [{ analysisId: undoId, operation: options.operation ?? 'upgrade', label: 'app' }], disabled: options.blocked ?? false, openingId: options.openingId, error: options.undoError, review: id => reviewed.push(id) } }, element)));
  act(() => root.render(wrap(component)));
  let unmounted = false;
  const unmount = () => { if (!unmounted) { act(() => root.unmount()); unmounted = true; } };
  t.after(() => { unmount(); dom.window.close(); for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { document, dom, opener, revealed, reviewed, unmount, get analyzed() { return analyzed; }, update: (element, terminals) => act(() => root.render(wrap(element, terminals))) };
}
for (const state of ['passed', 'no script', 'not selected', 'warning', 'removal', 'partial', 'unknown']) test(`shared result renders ${state} with honest checks and two backup actions`, t => {
  let element; let expected;
  const checks = [install, script('test'), script('build'), script('lint')];
  if (state === 'no script') { checks[1] = script('test', 'no-script', { reason: 'No test script in package.json.' }); checks[2] = script('build', 'not-run', { reason: 'Not selected.' }); }
  if (state === 'not selected') checks[1] = script('test', 'not-run', { reason: 'Not selected.' });
  if (state === 'unknown') checks[1] = script('test', 'unknown', { message: 'The task result was not observed.' });
  if (state === 'warning' || state === 'partial') { checks[1] = script('test', 'failed', { exitCode: 7, terminalAvailable: true }); checks[2] = script('build', 'not-run', { reason: 'Stopped after an earlier failure.' }); }
  const result = { ...upgrade(checks), verification: state === 'warning' ? 'failed' : ['no script', 'not selected', 'unknown'].includes(state) ? 'not-run' : 'passed' };
  if (state === 'removal') { element = h(RemovalResultPanel, { row, result: { undoId, analysisId: 'remove', packages: ['chalk', 'lodash'], outcome: 'verified', verification: 'passed', rollback: 'not-needed', message: 'Direct entries removed.', checks } }); expected = 'Removal done'; }
  else if (state === 'partial') { element = h(RemovalErrorPanel, { row, error: { code: 'ROLLBACK_CONFLICT', message: 'Newer edits were kept.' }, details: { analysisId: 'remove', packages: ['chalk', 'lodash'], install: 'succeeded', verification: 'failed', rollback: 'conflict', checks } }); expected = 'Removal partly failed'; }
  else { element = h(UpgradeChangeResult, { result, enrichment: state === 'warning' ? { phase: 'failed', refreshId: 'refresh-a', message: 'Security data could not refresh.' } : null }); expected = state === 'warning' ? 'Upgrade done with a warning' : 'Upgrade done'; }
  const dom = mount(t, element, { operation: state === 'removal' || state === 'partial' ? 'removal' : 'upgrade', blocked: state === 'partial' });
  assert.match(dom.document.querySelector('.change-result__banner').textContent, new RegExp(expected));
  const rows = [...dom.document.querySelectorAll('.change-result__check')]; assert.equal(rows.length, 4);
  for (const [index, check] of checks.entries()) { assert.match(rows[index].textContent, new RegExp(check.kind === 'install' ? 'Install' : check.scriptName)); assert.ok(rows[index].querySelector('.status-badge svg')); }
  assert.equal(dom.document.querySelectorAll('details').length, 3);
  const actions = [...dom.document.querySelectorAll('.dialog-footer__standalone-actions button')];
  assert.deepEqual(actions.map(button => button.textContent), state === 'partial' ? ['Analyze project'] : [state === 'removal' ? 'Undo removal' : 'Undo upgrade', 'Analyze project']);
  assert.equal(actions.at(-1).classList.contains('button--secondary'), true);
  assert.equal(actions.at(-1).disabled, state === 'partial');
  if (state !== 'partial') assert.match(dom.document.body.textContent, /Undo restores dependency files\. It does not restore script side effects\./);
  assert.doesNotMatch(dom.document.querySelector('.change-result').textContent, /[\u2013\u2014;]/);
  if (state !== 'partial') { act(() => actions[0].click()); assert.deepEqual(dom.reviewed, [undoId]); act(() => actions[1].click()); assert.equal(dom.analyzed, 1); }
  if (state === 'warning') {
    act(() => dom.document.querySelector('[aria-label="Show terminal for test"]').click()); assert.deepEqual(dom.revealed, ['script-test']);
    dom.update(element, new Map([['script-test', false]])); assert.equal(dom.document.querySelector('[aria-label="Show terminal for test"]'), null); assert.match(dom.document.body.textContent, /Terminal was closed/);
    assert.match(dom.document.body.textContent, /Exit code 7/); assert.match(dom.document.body.textContent, /Analyze project to retry/);
  }
});
test('Undo is absent without the current backup and no Close action is added', t => {
  const dom = mount(t, h(UpgradeChangeResult, { result: upgrade([install]), enrichment: null }), { backup: false });
  assert.deepEqual([...dom.document.querySelectorAll('.dialog-footer__standalone-actions button')].map(button => button.textContent), ['Analyze project']);
  assert.match(dom.document.body.textContent, /No Undo backup is available/);
});
for (const rollback of ['conflict', 'failed']) test(`upgrade shows ${rollback} rollback status and failure details inside the shared dialog`, t => {
  const rollbackMessage = rollback === 'conflict' ? 'Rollback is incomplete because Packageawy saw dependency files change. Check package.json.' : 'Rollback is incomplete. Saved files are kept. Check package.json.';
  const result = { ...upgrade([install, script('test', 'failed', { exitCode: 7 })]), application: 'unconfirmed', verification: 'failed', rollback, rollbackMessage };
  const dom = mount(t, h(ChangeResultModal, { result, enrichment: null, onClose() {} }), { backup: false });
  const fact = [...dom.document.querySelectorAll('dt')].find(node => node.textContent === 'Rollback').nextElementSibling;
  assert.equal(fact.textContent, rollback === 'conflict' ? 'Incomplete: files changed' : 'Incomplete: restore failed');
  assert.equal(fact.closest('details').open, true);
  assert.equal(dom.document.querySelector('.change-result__notice').textContent, rollbackMessage);
  assert.ok(dom.document.querySelector('.change-result__notice svg'));
  assert.equal(dom.document.querySelector('.dialog-footer__panel-actions button').disabled, true);
  assert.match(dom.document.body.textContent, /Backup kept\. Recovery needed\./);
});
test('transitive result uses the matching Undo label and retains security details', t => {
  const dom = mount(t, h(ChangeResult, { flow: 'Transitive fix', headingId: 'fix-result', title: 'Transitive fix done', summary: 'Security checks finished.', packages: [{ name: 'nested', from: '1.0.0', to: '1.0.1' }], undoId, checks: [install], facts: [{ label: 'Security verification', value: 'passed' }] }, h('p', null, 'Still present: advisory-a')), { operation: 'remediation' });
  assert.match(dom.document.body.textContent, /Undo transitive fix/); assert.match(dom.document.body.textContent, /Still present: advisory-a/);
});
test('standalone multi-package result traps disclosures and restores focus', t => {
  const result = upgrade([install, script('test')]); result.changes.push({ ...result.changes[0], packageName: 'another' });
  let closed = 0;
  const dom = mount(t, h(ChangeResultModal, { result, enrichment: null, onClose: () => closed++ }));
  assert.equal(dom.document.activeElement.id, 'upgrade-result-heading');
  assert.equal(dom.document.querySelectorAll('.change-result__package').length, 2);
  const summaries = [...dom.document.querySelectorAll('summary')]; assert.equal(summaries.length, 3);
  summaries[0].focus(); assert.equal(dom.document.activeElement, summaries[0]);
  const last = [...dom.document.querySelectorAll('.dialog-footer__actions button')].at(-1); last.focus();
  dom.document.dispatchEvent(new dom.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(dom.document.activeElement, dom.document.querySelector('.modal__close'));
  dom.document.dispatchEvent(new dom.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); assert.equal(closed, 1);
  dom.unmount(); assert.equal(dom.document.activeElement, dom.opener);
});
test('theme styles use editor variables, focus outlines and right aligned actions', () => {
  assert.match(css, /\.dialog-footer__actions,[\s\S]*?justify-content: flex-end/);
  assert.doesNotMatch(css, /\.dialog-footer__panel-actions > (?:\[role="status"\]|\.banner)/);
  assert.match(css, /\.button:focus-visible[^}]*var\(--vscode-focusBorder/);
  assert.match(css, /\.change-result__rows[^}]*var\(--vscode-contrastBorder/);
});

for (const partial of [false, true]) test(`standalone removal modal preserves ${partial ? 'partial recovery' : 'completed'} result and focus`, t => {
  const outcome = partial ? { error: { code: 'ROLLBACK_CONFLICT', message: 'Newer edits kept.' }, details: { analysisId: 'remove', packages: ['chalk', 'lodash'], install: 'succeeded', verification: 'failed', rollback: 'conflict', checks: [install, script('test', 'failed', { exitCode: 8 })] } }
    : { result: { undoId, analysisId: 'remove', packages: ['chalk', 'lodash'], outcome: 'verified', verification: 'passed', rollback: 'not-needed', message: 'Removed.', checks: [install, script('test')] } };
  const dom = mount(t, h(RemovalChangeResultModal, { outcome, onClose() {} }), { operation: 'removal', blocked: partial });
  assert.equal(dom.document.activeElement.id, partial ? 'removal-error-heading' : 'removal-result-heading');
  assert.equal(dom.document.querySelectorAll('.change-result__package').length, 2);
  assert.equal(dom.document.querySelector('.dialog-footer__panel-actions button:last-child').disabled, partial);
  assert.equal(dom.document.querySelectorAll('.dialog-footer').length, 1);
  dom.unmount(); assert.equal(dom.document.activeElement, dom.opener);
});

test('a manifest staging conflict is a clean removal failure with Analyze available', t => {
  const dom = mount(t, h(RemovalErrorPanel, { row, error: { code: 'MANIFEST_STAGE_FAILED', message: 'The manifest changed before removal could start.' },
    details: { completion: 'not-started', analysisId: 'staging-conflict', packages: ['chalk'], checks: [{ ...install, status: 'not-run', exitCode: undefined, reason: 'Removal did not start.' }], install: 'not-run', verification: 'not-run', rollback: 'not-needed' } }), { backup: false });
  assert.match(dom.document.body.textContent, /Removal did not start/);
  assert.match(dom.document.body.textContent, /No dependency files were changed by this removal/);
  assert.match(dom.document.body.textContent, /Not removed/);
  assert.doesNotMatch(dom.document.body.textContent, /Recovery needed|Recovery required|Removal partly failed/);
  const analyze = dom.document.querySelector('.dialog-footer__standalone-actions button');
  assert.equal(analyze.disabled, false);
  act(() => analyze.click()); assert.equal(dom.analyzed, 1);
});

for (const completion of ['rolled-back', 'incomplete', 'unknown', undefined]) test(`removal failure with ${completion ?? 'legacy'} completion preserves recovery blocking`, t => {
  const restored = completion === 'rolled-back';
  const dom = mount(t, h(RemovalErrorPanel, { row, error: { code: 'CHANGE_FAILED', message: 'Change failed.' },
    details: { completion, analysisId: 'failed-removal', packages: ['chalk'], checks: [install], install: 'failed', verification: 'not-run', rollback: restored ? 'succeeded' : 'conflict' } }), { backup: false });
  assert.equal(dom.document.querySelector('.dialog-footer__standalone-actions button').disabled, !restored);
  assert.match(dom.document.body.textContent, restored ? /Removal rolled back.*Your dependency files were restored/s : /Removal partly failed.*Current dependency files are not confirmed/s);
});

test('a clean removal failure still respects the shared host recovery block', t => {
  const dom = mount(t, h(RemovalErrorPanel, { row, error: { code: 'MANIFEST_STAGE_FAILED', message: 'Staging stopped.' },
    details: { completion: 'not-started', analysisId: 'staging-conflict', packages: ['chalk'], checks: [], install: 'not-run', verification: 'not-run', rollback: 'not-needed' } }), { blocked: true, backup: false });
  assert.equal(dom.document.querySelector('.dialog-footer__standalone-actions button').disabled, true);
});

const fixPlan = { analysisId: 'fix', rootPackage: 'chalk', currentVersion: '4.1.2', packageManager: 'npm',
  files: { manifestPath: join('project', 'package.json'), lockfilePath: join('project', 'package-lock.json') },
  changes: [{ packageName: 'nested', fromVersions: ['1.0.0'], toVersions: ['1.0.1'], affectedPaths: [], targeted: true },
    { packageName: 'added', fromVersions: [], toVersions: ['2.0.0'], affectedPaths: [], targeted: false }] };
const fixResult = { outcome: 'verified', rollback: 'not-needed', verification: 'passed', message: 'Fix finished.', checks: [install], resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [] };
for (const [outcome, rollback, expected] of [
  ['verified', 'not-needed', 'applied'], ['partial', 'not-needed', 'applied'], ['unverified', 'not-needed', 'applied'],
  ['rolled-back', 'succeeded', 'Restored'], ['cancelled', 'succeeded', 'Restored'], ['cancelled', 'not-needed', 'Unchanged'],
  ['recovery-required', 'conflict', 'Current version unknown'], ['recovery-required', 'failed', 'Current version unknown'],
]) test(`the actual transitive adapter renders ${outcome} with ${rollback} versions honestly`, t => {
  const dom = mount(t, h(TransitiveFixReview, { rootPackage: 'chalk', subject: 'nested', dependencyPath: ['chalk', 'nested'],
    state: { phase: 'result', plan: fixPlan, result: { ...fixResult, outcome, rollback } }, disabled: false }));
  const rows = [...dom.document.querySelectorAll('.change-result__package')];
  if (expected === 'applied') {
    assert.ok(rows[0].querySelector('[aria-label="From 1.0.0 to 1.0.1"]'));
    assert.ok(rows[1].querySelector('[aria-label="From not installed to 2.0.0"]'));
  } else {
    for (const row of rows) { assert.match(row.textContent, new RegExp(expected)); assert.equal(row.querySelector('[aria-label^="From "]'), null); }
    assert.doesNotMatch(rows.map(row => row.textContent).join(' '), /1\.0\.1|2\.0\.0/);
    if (expected !== 'Current version unknown') { assert.match(rows[0].textContent, /1\.0\.0/); assert.match(rows[1].textContent, /not installed/); }
    else assert.doesNotMatch(rows[0].textContent, /1\.0\.0/);
  }
});

for (const activeTab of ['overview', 'vulnerabilities']) test(`Manage completion can be dismissed by keyboard and restores ${activeTab}`, t => {
  const fullRow = { ...row, advisories: [], worstSeverity: null, wanted: '5.0.0', latest: '5.0.0', upgradeTo: '5.0.0', upgradeReason: 'update', dev: false, optional: false };
  const props = { row: fullRow, allRows: [fullRow], activeTab, upgradeResult: null, upgradeEnrichment: null,
    upgrade: { active: false }, removal: { active: false, analysis: null, error: null }, removalImpact: { phase: 'idle' },
    hygieneFindings: [], onClose() {}, now: Date.now() };
  let dismissed = 0;
  const element = (remediation) => h(ManageDependencyModal, { ...props, remediation, onDismissRemediation: () => dismissed++ });
  const dom = mount(t, element({ phase: 'result', plan: fixPlan, result: fixResult }));
  const button = dom.document.querySelector('[aria-label="Dismiss fix result"]');
  assert.ok(button); button.focus(); assert.equal(dom.document.activeElement, button);
  act(() => button.click()); assert.equal(dismissed, 1);
  dom.update(element(undefined));
  assert.equal(dom.document.querySelector('#transitive-result-heading'), null);
  assert.ok(dom.document.querySelector(activeTab === 'overview' ? '.overview-panel' : '.manage-panel-empty'));
  assert.equal(dom.document.activeElement.id, `manage-tab-${activeTab}`);
});

for (const operation of ['upgrade', 'removal', 'remediation']) test(`shared ${operation} result keeps pending Undo feedback and both actions`, t => {
  const dom = mount(t, h(ChangeResult, { flow: 'Upgrade', headingId: 'pending-result', title: 'Change done', summary: 'Dependency files updated.', packages: [], checks: [install], undoId, facts: [] }), { operation, openingId: undoId });
  const actions = dom.document.querySelector('.dialog-footer__standalone-actions');
  const buttons = [...actions.querySelectorAll('button')];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].disabled, true, 'pending requests disable Undo even if the caller has not set disabled yet');
  assert.equal(buttons[0].getAttribute('aria-busy'), 'true');
  assert.ok(dom.document.getElementById(buttons[0].getAttribute('aria-describedby')));
  assert.equal(actions.querySelector('[role="status"]'), null);
  const feedback = dom.document.querySelector('.change-result > p[role="status"]');
  assert.equal(feedback.textContent, 'Opening the backup...');
  assert.equal(feedback.getAttribute('aria-live'), 'polite');
  act(() => buttons[0].click());
  assert.deepEqual(dom.reviewed, []);
});
for (const operation of ['upgrade', 'removal', 'remediation']) test(`shared ${operation} result keeps Undo errors inside its dialog`, t => {
  const dom = mount(t, h(ChangeResultModal, { result: upgrade([install]), enrichment: null, onClose() {} }), { operation, undoError: { id: undoId, message: 'The saved files could not be read.' } });
  const dialog = dom.document.querySelector('[role="dialog"]');
  const alert = dialog.querySelector('[role="alert"]');
  assert.equal(alert.textContent, "Couldn't open the backup. The saved files could not be read.");
  assert.ok(alert.querySelector('svg'));
  assert.ok(alert.closest('.modal__body'));
  assert.equal(dialog.querySelector('.dialog-footer [role="alert"]'), null);
  const button = dialog.querySelector('[data-undo-id]');
  assert.equal(button.disabled, false);
  act(() => button.click());
  assert.deepEqual(dom.reviewed, [undoId]);
});
