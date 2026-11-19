import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { prepareJournal } from '../out/host/recovery/journal.js';
import { inspectRecovery } from '../out/host/recovery/inspection.js';
import { makeCoordinator, makeProject } from './helpers/removal-project.mjs';
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../out/host/webviewProtocol.js';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { RECOVERY_MESSAGES } from '../out/host/recoveryCopy.js';

const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: ['webview/src/App.tsx'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
let outgoing;
globalThis.acquireVsCodeApi = () => ({ postMessage: message => outgoing?.push(message) });
const { App } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
delete globalThis.acquireVsCodeApi;

const labels = { cleanup: 'Undo cleanup', removal: 'Undo removal', upgrade: 'Undo upgrade', remediation: 'Undo transitive fix' };
async function journey(t, hostKind = 'vscode', operation = 'cleanup', emptyCleanup = false, deferUndo = false) {
  const project = await makeProject(t);
  const dependencies = { chalk: '^4.1.2', lodash: '^4.17.21', 'is-number': '^7.0.0' };
  const manifest = JSON.stringify({ name: 'undo-fixture', version: '1.0.0', dependencies }, null, 2);
  const lock = deps => JSON.stringify({ name: 'undo-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'undo-fixture', version: '1.0.0', dependencies: deps },
      ...Object.fromEntries(Object.keys(deps).map(name => [`node_modules/${name}`, { version: dependencies[name].slice(1) }])) } }, null, 2);
  await writeFile(project.manifestPath, manifest);
  await writeFile(project.lockfilePath, lock(dependencies));
  const f = makeCoordinator(project, { mutationRoot: () => project.root, mutationLocks: new ProjectMutationLocks() });
  f.coordinator.options.platform.hostKind = hostKind;
  f.coordinator.options.ensureController = async () => ({ root: project.root, upgradeSource: await f.read(),
    validateBulkRemoveRequest: () => ({ ok: true, removals: ['lodash', 'is-number'].map(packageName => ({ packageName, classification: 'prod' })) }) });
  f.coordinator.options.platform.runProcess = async request => {
    f.commands.push(request.args.includes('ci') ? 'ci' : 'install');
    if (request.args.includes('install')) await writeFile(project.lockfilePath, lock({ chalk: dependencies.chalk }));
    return { onDidExit: listener => { setImmediate(() => listener(request.args.includes('ci') ? (f.state.reinstallUnknown ? undefined : f.state.reinstallExitCode ?? 0) : 0)); return { dispose() {} }; } };
  };
  await f.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'cleanup', removalRequestId: 'impact', packages: ['lodash', 'is-number'] });
  const analysisId = f.messages.findLast(message => message.status === 'remove-analysis').analysis.analysisId;
  await f.coordinator.handleConfirmRemove({ analysisId });
  assert.equal(f.messages.findLast(message => message.status === 'remove-result').result.restoreAvailable, true);
  assert.deepEqual(JSON.parse(await readFile(project.manifestPath, 'utf8')).dependencies, { chalk: '^4.1.2' });
  if (operation !== 'cleanup') {
    // The other change types use the same retained journal and coordinator.
    // Their actual mutation paths are covered in retained-change-undo.test.mjs.
    const saved = f.coordinator.cleanupBackups.get(analysisId);
    await writeFile(project.manifestPath, manifest);
    await writeFile(project.lockfilePath, lock(dependencies));
    const journal = await prepareJournal({ ...saved.target, operation });
    await writeFile(project.manifestPath, JSON.stringify({ dependencies: {} }));
    await writeFile(project.lockfilePath, lock({}));
    await journal.finish('kept');
    f.coordinator.cleanupBackups.clear();
    await f.coordinator.recovery.inspect();
  } else if (emptyCleanup) {
    // Reproduce the owner's final empty manifest and lockfile as well.
    await writeFile(project.manifestPath, JSON.stringify({ dependencies: {} }));
    await writeFile(project.lockfilePath, lock({}));
  }
  const dom = new JSDOM('<!doctype html><body><main></main></body>');
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', { get() { return this.parentElement; } });
  const root = createRoot(dom.window.document.querySelector('main'));
  outgoing = [];
  act(() => root.render(createElement(App)));
  const event = message => {
    assert.equal(isHostToWebviewMessage(message), true, JSON.stringify(message));
    act(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })));
  };
  const post = f.coordinator.options.sink.postMessage;
  f.coordinator.options.sink.postMessage = message => { post(message); event(message); };
  event({ status: 'ready', data: { rows: [], generatedAt: 'fixture', availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    project: { id: 'project', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false, extensionVersion: 'test', builtAt: 'test', hygieneFindings: [] } });
  event(f.messages.findLast(message => message.status === 'smart-cleanup-backups'));
  outgoing.length = 0;
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  const click = label => {
    const node = button(label); assert.ok(node, `button ${label} exists`); assert.equal(node.disabled, false, label);
    act(() => { node.focus(); node.click(); });
  };
  const flush = async () => {
    while (outgoing.length) {
      const message = outgoing.shift(); assert.equal(isWebviewToHostMessage(message), true);
      if (message.type === 'restore-smart-cleanup') await f.coordinator.handleRestoreSmartCleanup(message);
      if (message.type === 'inspect-recovery') await f.coordinator.recovery.inspect(message.id);
      if (message.type === 'start-recovery') await f.coordinator.recovery.start(message.stopped, message.claim);
      if (message.type === 'apply-recovery') await f.coordinator.recovery.apply(message.choices);
      if (message.type === 'dismiss-recovery') await f.coordinator.recovery.dismiss(message.stopped, message.discardIncomplete);
    }
  };
  t.after(() => {
    act(() => root.unmount()); dom.window.close(); f.coordinator.disposeWhenIdle(); outgoing = undefined;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  click(labels[operation]);
  if (!deferUndo) await flush();
  return { ...f, project, manifest, lock: lock(dependencies), document: dom.window.document, button, click, flush,
    backup: path.join(project.root, '.packageawy-recovery'),
    async open() { act(() => dom.window.document.querySelector('.recovery input[type="checkbox"]').click()); click('Review backup'); await flush(); },
    async assertRestored() { assert.equal(await readFile(project.manifestPath, 'utf8'), manifest); assert.equal(await readFile(project.lockfilePath, 'utf8'), lock(dependencies)); },
  };
}

for (const hostKind of ['vscode', 'jetbrains']) for (const closure of ['failure', 'restart']) {
  for (const action of ['start', 'restore', 'apply', 'finish', 'discard']) for (const queued of [false, true]) {
    test(`${hostKind} ${closure} refuses ${action} ${queued ? 'while queued' : 'before admission'} and leaves recovery closable`, async t => {
      const f = await journey(t, hostKind);
      if (action !== 'start') await f.open();
      else act(() => f.document.querySelector('.recovery input[type="checkbox"]').click());
      if (action === 'finish') { f.click('Restore all files'); await f.flush(); }
      if (action === 'discard') {
        f.click('Delete backup without restoring');
        act(() => [...f.document.querySelectorAll('input[type="checkbox"]')].find(node => node.parentElement.textContent.includes('I understand')).click());
      }
      const locks = f.coordinator.mutationLocks;
      const session = f.coordinator.recovery.session;
      const lock = f.coordinator.recovery.lock;
      const undo = f.coordinator.recovery.undo;
      const owners = locks.activeOwners();
      const manifest = await readFile(f.project.manifestPath, 'utf8');
      const lockfile = await readFile(f.project.lockfilePath, 'utf8');
      const journal = await readFile(path.join(f.backup, 'journal.json'), 'utf8');
      const commands = [...f.commands];
      const closeAdmission = () => closure === 'failure' ? locks.closeAfterFailure() : locks.prepareRestart('restart-fixture');
      let release;
      if (queued) f.coordinator.recovery.enqueue(() => new Promise(resolve => { release = resolve; }));
      else closeAdmission();
      f.click({ start: 'Review backup', restore: 'Restore all files', apply: 'Apply file choices', finish: 'Finish undo', discard: 'Confirm delete backup' }[action]);
      assert.equal(f.document.querySelector('.recovery').getAttribute('aria-busy'), 'true');
      const pending = f.flush();
      if (queued) {
        await Promise.resolve();
        closeAdmission();
        release();
      }
      await pending;
      assert.equal(f.document.querySelector('.recovery').getAttribute('aria-busy'), 'false');
      assert.equal(f.messages.findLast(message => message.status === 'recovery').recovery.state, 'blocked');
      assert.equal(f.document.querySelector('[role="status"]').textContent, closure === 'failure' ? RECOVERY_MESSAGES.restartRequired : RECOVERY_MESSAGES.restart);
      assert.equal(f.button('Keep the backup for later').disabled, false);
      assert.equal(f.document.activeElement.id, 'recovery-title');
      assert.equal(f.coordinator.recovery.session, session);
      assert.equal(f.coordinator.recovery.lock, lock);
      assert.equal(f.coordinator.recovery.undo, undo);
      assert.deepEqual(locks.activeOwners(), owners);
      assert.equal(await readFile(f.project.manifestPath, 'utf8'), manifest);
      assert.equal(await readFile(f.project.lockfilePath, 'utf8'), lockfile);
      assert.equal(await readFile(path.join(f.backup, 'journal.json'), 'utf8'), journal);
      assert.deepEqual(f.commands, commands);
      f.click('Keep the backup for later'); await f.flush();
      assert.equal(f.document.querySelector('.recovery'), null);
      await access(f.backup);
    });
  }
}

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} Undo cleanup default choices restore the real backup before finishing`, async t => {
  const f = await journey(t, hostKind, 'cleanup', true);
  await f.open();
  const restore = [...f.document.querySelectorAll('input[type="radio"]')].filter(node => node.checked);
  assert.ok(restore.every(node => node.parentElement.textContent === 'Restore backup'), 'Undo defaults restore every backed up file');
  f.click('Apply file choices');
  assert.match(f.document.querySelector('[role="status"]').textContent, /Applying file choices/);
  await f.flush(); await f.assertRestored();
  assert.equal(f.document.querySelector('h1').textContent, 'Dependency files restored');
  assert.match(f.document.body.textContent, /Reinstall was skipped/);
  assert.match(f.document.body.textContent, /package\.json/);
  assert.match(f.document.body.textContent, /package-lock\.json/);
  f.click('Finish undo'); await f.flush();
  await assert.rejects(access(f.backup));
  assert.match(f.document.body.textContent, /Backup deleted/);
  await f.assertRestored();
});

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} Restore all shows restored files and reinstall success before finishing`, async t => {
  const f = await journey(t, hostKind);
  await f.open(); f.state.reinstallChoice = 'Reinstall';
  f.click('Restore all files');
  assert.equal(f.document.querySelector('.recovery').getAttribute('aria-busy'), 'true');
  assert.match(f.document.querySelector('[role="status"]').textContent, /Restoring backed up files/);
  assert.equal(f.button('Keep the backup for later').disabled, true);
  await f.flush(); await f.assertRestored();
  assert.match(f.document.body.textContent, /Reinstall completed/);
  assert.deepEqual(f.commands, ['install', 'ci']);
  const saved = JSON.parse(await readFile(path.join(f.backup, 'journal.json'), 'utf8'));
  assert.equal(saved.recoveryReinstall, 'succeeded', 'the reinstall result survives reopening');
  assert.ok(f.document.querySelector('.recovery__result'));
  assert.equal(f.document.activeElement.id, 'recovery-title');
  f.click('Finish undo');
  assert.match(f.document.querySelector('[role="status"]').textContent, /Deleting the backup/);
  await f.flush(); await f.assertRestored();
  await assert.rejects(access(f.backup));
  assert.match(f.document.body.textContent, /Backup deleted/);
});

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} View backup gives visible read-only contents and keeps the undo point`, async t => {
  const f = await journey(t, hostKind);
  const saved = await readFile(path.join(f.backup, 'journal.json'), 'utf8');
  const details = f.document.querySelector('details');
  act(() => details.querySelector('summary').click());
  assert.equal(details.open, true);
  assert.match(details.textContent, /Viewing the backup does not restore files/);
  assert.match(details.textContent, /chalk/);
  assert.match(details.textContent, /lodash/);
  assert.match(details.textContent, /is-number/);
  assert.equal(f.button('Done, delete the backup'), undefined);
  f.click('Keep the backup for later'); await f.flush();
  assert.equal(f.document.querySelector('.recovery'), null);
  assert.equal(await readFile(path.join(f.backup, 'journal.json'), 'utf8'), saved);
  assert.notEqual(await readFile(f.project.manifestPath, 'utf8'), f.manifest);
  assert.ok(f.button('Undo cleanup'));
});

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} deleting first warns that cleanup stays and requires a separate confirmation`, async t => {
  const f = await journey(t, hostKind);
  assert.equal(f.button('Done, delete the backup'), undefined);
  assert.equal(f.button('Finish undo'), undefined);
  await f.open();
  const current = await readFile(f.project.manifestPath, 'utf8');
  f.click('Delete backup without restoring');
  assert.match(f.document.body.textContent, /The cleanup will stay for files you did not restore. Deleting the backup cannot be undone/);
  assert.equal(f.document.activeElement.textContent, 'Delete this backup?');
  assert.equal(f.button('Confirm delete backup').disabled, true);
  await f.flush(); await access(f.backup);
  f.click('Cancel deletion');
  assert.equal(f.document.activeElement, f.button('Delete backup without restoring'));
  await access(f.backup);
  f.click('Delete backup without restoring');
  act(() => [...f.document.querySelectorAll('input[type="checkbox"]')].find(node => node.parentElement.textContent.includes('I understand')).click());
  f.click('Confirm delete backup');
  assert.match(f.document.querySelector('[role="status"]').textContent, /Deleting the backup without restoring/);
  await f.flush();
  assert.equal(await readFile(f.project.manifestPath, 'utf8'), current);
  await assert.rejects(access(f.backup));
  assert.match(f.document.body.textContent, /Backup deleted/);
});

for (const selection of ['keep', 'mixed']) test(`applying ${selection} choices never enables ordinary deletion of an unrestored backup`, async t => {
  const f = await journey(t);
  await f.open();
  act(() => f.document.querySelector('details > summary').click());
  const fields = [...f.document.querySelectorAll('fieldset')];
  for (const field of selection === 'keep' ? fields : fields.slice(0, 1)) act(() => field.querySelector('input[type="radio"]').click());
  f.click('Apply file choices'); await f.flush();
  assert.equal(f.document.querySelector('h1').textContent, selection === 'keep' ? 'No files restored' : 'Some files restored');
  assert.equal(f.button('Finish undo'), undefined);
  assert.ok(f.button('Delete backup without restoring'));
  await f.coordinator.recovery.dismiss(true, false);
  await access(f.backup);
  assert.match(f.document.querySelector('[role="status"]').textContent, /cannot be undone/);
  assert.ok(f.button('Delete backup without restoring'), 'a host rejection keeps the confirmed session usable');
});

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} a file changed after restore keeps Finish undo refusal focused and recovery usable`, async t => {
  const f = await journey(t, hostKind);
  await f.open(); f.click('Restore all files'); await f.flush();
  const changedManifest = '{"dependencies":{}}';
  await writeFile(f.project.manifestPath, changedManifest);
  f.click('Finish undo');
  assert.equal(f.document.querySelector('.recovery').getAttribute('aria-busy'), 'true');
  await f.flush();
  await access(f.backup);
  assert.equal(await readFile(f.project.manifestPath, 'utf8'), changedManifest);
  assert.equal(f.messages.findLast(message => message.status === 'recovery').recovery.state, 'completed');
  assert.equal(f.document.querySelector('.recovery').getAttribute('aria-busy'), 'false');
  assert.match(f.document.querySelector('[role="status"]').textContent, /Some files do not match the backup/);
  assert.equal(f.document.activeElement.id, 'recovery-title');
  assert.equal(f.button('Finish undo'), undefined);
  for (const label of ['Restore all files', 'Apply file choices', 'Delete backup without restoring', 'Keep the backup for later']) {
    assert.equal(f.button(label)?.disabled, false, `${label} remains usable`);
  }
  f.click('Restore all files'); await f.flush(); await f.assertRestored();
  assert.equal(f.document.activeElement.id, 'recovery-title');
  f.click('Finish undo'); await f.flush();
  await assert.rejects(access(f.backup));
  assert.equal(f.document.querySelector('.recovery'), null);
  assert.match(f.document.body.textContent, /Backup deleted/);
});

for (const hostKind of ['vscode', 'jetbrains']) for (const operation of ['removal', 'upgrade', 'remediation']) {
  for (const action of ['restore', 'discard']) test(`${hostKind} ${labels[operation]} uses the same safe ${action} flow`, async t => {
    const f = await journey(t, hostKind, operation);
    assert.equal(f.document.querySelector('h1').textContent, labels[operation]);
    await f.open();
    if (action === 'restore') {
      f.click('Apply file choices'); await f.flush(); await f.assertRestored();
      assert.equal(f.document.querySelector('h1').textContent, 'Dependency files restored');
      assert.match(f.document.body.textContent, /Reinstall was skipped/);
      f.click('Finish undo'); await f.flush(); await f.assertRestored();
    } else {
      const current = await readFile(f.project.manifestPath, 'utf8');
      f.click('Delete backup without restoring');
      assert.match(f.document.body.textContent, /will stay for files you did not restore. Deleting the backup cannot be undone/);
      assert.equal(f.button('Confirm delete backup').disabled, true);
      act(() => [...f.document.querySelectorAll('input[type="checkbox"]')].find(node => node.parentElement.textContent.includes('I understand')).click());
      f.click('Confirm delete backup'); await f.flush();
      assert.equal(await readFile(f.project.manifestPath, 'utf8'), current);
    }
    await assert.rejects(access(f.backup));
    assert.match(f.document.body.textContent, /Backup deleted/);
  });
}

for (const reinstall of ['failed', 'unknown']) test(`Undo reports ${reinstall} reinstall without claiming success or losing the backup`, async t => {
  const f = await journey(t);
  await f.open(); f.state.reinstallChoice = 'Reinstall';
  f.state.reinstallExitCode = 1; f.state.reinstallUnknown = reinstall === 'unknown';
  f.click('Restore all files'); await f.flush(); await f.assertRestored();
  await access(f.backup);
  if (reinstall === 'failed') {
    assert.match(f.document.body.textContent, /Reinstall failed/);
    assert.ok(f.button('Finish undo'));
  } else {
    assert.equal(f.button('Finish undo'), undefined);
    assert.equal(f.document.querySelector('.recovery__result'), null);
    assert.match(f.document.body.textContent, /may still be running/);
  }
});

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} Keep current choices can be corrected to Restore all with result focus after each apply`, async t => {
  const f = await journey(t, hostKind);
  await f.open();
  act(() => f.document.querySelector('details > summary').click());
  for (const field of f.document.querySelectorAll('fieldset')) act(() => field.querySelector('input[type="radio"]').click());
  f.click('Apply file choices'); await f.flush();
  assert.equal(f.document.querySelector('h1').textContent, 'No files restored');
  assert.equal(f.document.activeElement.id, 'recovery-title');
  assert.ok(f.button('Restore all files'));
  f.click('Restore all files'); await f.flush(); await f.assertRestored();
  assert.equal(f.document.querySelector('h1').textContent, 'Dependency files restored');
  assert.equal(f.document.activeElement.id, 'recovery-title');
  assert.match(f.document.body.textContent, /Reinstall was skipped/);
  assert.equal(f.document.querySelector('.recovery').getAttribute('aria-busy'), 'false');
  f.click('Finish undo'); await f.flush(); await f.assertRestored();
});

for (const hostKind of ['vscode', 'jetbrains']) for (const operation of Object.keys(labels)) {
  test(`${hostKind} ${labels[operation]} keeps restore defaults after Review backup, Keep for later and Start recovery`, async t => {
    const f = await journey(t, hostKind, operation);
    await f.open();
    const session = f.coordinator.recovery.session;
    const binding = f.coordinator.recovery.undo;
    const lock = f.coordinator.recovery.lock;
    f.click('Keep the backup for later'); await f.flush();
    assert.equal(f.document.querySelector('.recovery'), null);
    f.click('Start recovery'); await f.flush();
    assert.equal(f.coordinator.recovery.undo, binding);
    assert.equal(f.coordinator.recovery.session, session);
    assert.equal(f.coordinator.recovery.lock, lock);
    assert.equal(f.coordinator.recovery.undo.operation, operation);
    assert.ok(f.button('Restore all files'));
    assert.equal(f.document.querySelectorAll('input[type="radio"]:checked').length, 2);
    for (const node of f.document.querySelectorAll('input[type="radio"]:checked')) assert.equal(node.parentElement.textContent, 'Restore backup');
    f.click('Apply file choices'); await f.flush(); await f.assertRestored();
    assert.equal(f.document.activeElement.textContent, 'Dependency files restored');
    f.click('Finish undo'); await f.flush(); await f.assertRestored();
    await assert.rejects(access(f.backup));
  });
}

for (const hostKind of ['vscode', 'jetbrains']) for (const operation of Object.keys(labels)) for (const outcome of ['success', 'unavailable']) {
  test(`${hostKind} ${labels[operation]} shows opening feedback while the real host is delayed then clears on ${outcome}`, async t => {
    const f = await journey(t, hostKind, operation, false, true);
    const request = outgoing.find(message => message.type === 'restore-smart-cleanup');
    const saved = f.coordinator.cleanupBackups.get(request.analysisId);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const inspect = f.coordinator.recovery.inspectBackup.bind(f.coordinator.recovery);
    t.mock.method(f.coordinator.recovery, 'inspectBackup', async (...args) => { await gate; return inspect(...args); });
    const pending = f.flush();
    const opener = f.button(labels[operation]);
    assert.equal(opener.disabled, true);
    assert.equal(opener.getAttribute('aria-busy'), 'true');
    assert.match(f.document.querySelector('[role="status"]').textContent, /Opening the backup\.\.\./);
    act(() => { opener.click(); opener.click(); });
    assert.equal(outgoing.filter(message => message.type === 'restore-smart-cleanup').length, 0, 'no duplicate request is queued');
    if (outcome === 'unavailable') {
      const newer = await prepareJournal(saved.target); await newer.finish('kept');
    }
    release(); await pending;
    assert.doesNotMatch(f.document.body.textContent, /Opening the backup\.\.\./);
    if (outcome === 'success') assert.equal(f.document.activeElement.textContent, labels[operation]);
    else {
      assert.equal(f.document.querySelector('.recovery'), null);
      await f.coordinator.recovery.inspect();
      const nextUndo = f.document.querySelector('[data-undo-id]');
      assert.ok(nextUndo, 'discovery offers the replacement transaction');
      assert.notEqual(nextUndo.dataset.undoId, request.analysisId);
      assert.equal(nextUndo.disabled, false, 'the next Undo remains available after failure');
    }
  });
}

test('reopening a completed undo reports the durable reinstall result and original file paths', async t => {
  const f = await journey(t);
  await f.open(); f.click('Restore all files'); await f.flush();
  const target = f.coordinator.recovery.session.inspection.storage.target;
  const inspected = await inspectRecovery(target);
  assert.equal(inspected.view.reinstall, 'skipped');
  assert.deepEqual(inspected.view.files.map(file => file.path), ['package.json', 'package-lock.json']);
  assert.ok(inspected.view.files.every(file => file.progress === 'restored' && file.current === file.backup));
});

for (const reinstall of ['not-run', 'skipped', 'succeeded', 'failed', 'unknown', 'invalid', 42, null]) {
  test(`reinstall protocol validates ${JSON.stringify(reinstall)}`, () => {
    assert.equal(isHostToWebviewMessage({ status: 'recovery', recovery: { state: 'completed', message: '', files: [], claim: null, canApply: false, canDismiss: false, reinstall } }),
      typeof reinstall === 'string' && reinstall !== 'invalid');
  });
}
