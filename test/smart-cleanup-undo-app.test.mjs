import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appHarness } from './helpers/app-harness.mjs';
import { makeCoordinator, makeProject } from './helpers/removal-project.mjs';
import { choices } from './helpers/recovery.mjs';
import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { targetFingerprintField } from '../out/host/mutationTarget.js';
import { prepareJournal } from '../out/host/recovery/journal.js';
import { inspectRecovery } from '../out/host/recovery/inspection.js';
import { resolveMutationTarget } from '../out/host/mutationTarget.js';
import { RECOVERY_MESSAGES } from '../out/host/recovery/model.js';
import { RecoverySession } from '../out/host/recovery/session.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ['webview/src/components/SmartCleanupWorkspace.tsx'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { SmartCleanupWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const row = (name, current) => ({ name, current, range: '^1.0.0', wanted: current, latest: current, dev: false, optional: false,
  advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null });
const beforeRows = [row('left-pad', '1.3.0'), row('react', '18.2.0')];
const snapshot = (rows = beforeRows, generatedAt = 'before') => ({ status: 'ready', data: {
  rows, generatedAt, availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  project: { id: 'project', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
  extensionVersion: 'test', builtAt: 'test', hygieneFindings: [],
} });
const workspace = view => view.find('SmartCleanupWorkspace');
const html = view => renderToStaticMarkup(createElement(SmartCleanupWorkspace, workspace(view).props));
const undoSections = view => view.elements().filter(element => element.type === 'section' && element.props.className === 'cleanup-undo');
const undoButton = view => undoSections(view)[0]?.props.children.find(element => element?.type === 'button');

async function completedCleanup(t, hostKind, outcome = 'complete', scripts = {}) {
  const project = await makeProject(t), view = appHarness(t);
  const manifest = JSON.parse(await readFile(project.manifestPath, 'utf8'));
  await writeFile(project.manifestPath, JSON.stringify({ ...manifest, scripts }));
  let f;
  f = makeCoordinator(project, {
    mutationRoot: () => project.root,
    ensureController: async () => ({
      root: project.root, upgradeSource: await f.read(), lastResultSnapshot: () => snapshot().data,
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
    getSmartCleanupDeprecationEvidence: () => ({ deprecatedPackages: [], installedVersions: { 'left-pad': '1.3.0', react: '18.2.0' } }),
    reloadSmartCleanupFinalState: async () => {
      const source = await f.read();
      const fingerprint = computeSourceFingerprint({ ...source, ...targetFingerprintField(source.mutationTarget) });
      const after = snapshot(beforeRows.slice(0, 1), 'after');
      view.event(after);
      return { snapshot: after.data, projectId: 'project', generationAtReadStart: 0, generationAfterRead: 0,
        sourceFingerprint: fingerprint, confirmedSourceFingerprint: fingerprint };
    },
    reloadFinalState: async () => { view.event(snapshot(beforeRows, 'restored')); },
  });
  // Preserve the fixture's real platform adapters and connect its actual sink
  // to App. No test dispatches a restore outcome directly to the reducer.
  f.coordinator.options.platform.hostKind = hostKind;
  const post = f.coordinator.options.sink.postMessage;
  f.coordinator.options.sink.postMessage = message => { post(message); view.event(message); };
  view.event(snapshot());
  view.find('Dashboard').props.onOpenSmartCleanup(); view.render();
  const requestId = view.sent.findLast(m => m.type === 'analyze-smart-cleanup-metadata').requestId;
  view.event({ status: 'cleanup-result', analyzedAt: new Date().toISOString(), cacheExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    findings: [{ packageName: 'react', kind: 'likely-unused', confidence: 'high', severity: 'info', summary: 'No usage found.',
      evidence: { kind: 'likely-unused', reason: 'No usage found.', scannedFileCount: 1, truncated: false } }] });
  const impact = view.sent.findLast(m => m.type === 'analyze-removal-impact');
  view.event({ status: 'removal-impact-result', requestId: impact.requestId, packages: ['react'], generatedAt: new Date().toISOString(),
    assessments: [{ packageName: 'react', usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } }] });
  view.event({ status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } });
  assert.equal(workspace(view).props.state.phase, 'ready');
  workspace(view).props.dispatch({ type: 'show-confirmation' }); view.render();
  workspace(view).props.onPrepareRemoval(['remove-direct:react']); view.render();
  await f.coordinator.handleAnalyzeSmartCleanupRemove(view.sent.findLast(m => m.type === 'smart-cleanup-remove'));
  const analysisId = f.messages.findLast(m => m.status === 'remove-analysis').analysis.analysisId;
  workspace(view).props.onConfirmRemoval(analysisId); view.render();
  if (outcome === 'conflict') {
    f.state.installExitCode = 1;
    f.state.holdInstall = () => writeFile(project.manifestPath, '{"name":"concurrent-edit","dependencies":{"left-pad":"^1.3.0"}}');
  }
  await f.coordinator.handleConfirmRemove(view.sent.findLast(m => m.type === 'confirm-remove'));
  if (outcome === 'conflict') {
    assert.equal(workspace(view).props.state.phase, 'incomplete');
    assert.equal(f.coordinator.cleanupBackups.size, 0, 'failed cleanup has no undo offer');
    return { f, view, project, analysisId };
  }
  assert.equal(workspace(view).props.state.phase, 'complete');
  assert.match(html(view), /Cleanup done/);
  assert.match(html(view), /Undo cleanup/);
  assert.ok(workspace(view).props.state.result.metrics.length > 0);
  return { f, view, project, analysisId };
}

for (const hostKind of ['vscode', 'jetbrains']) for (const scripts of [{}, { build: 'tsc', test: 'node --test' }, { 'check:custom': 'node check.js', dev: 'vite' }]) {
  test(`${hostKind} Smart Cleanup snapshots ${Object.keys(scripts).length ? 'existing unselected' : 'absent'} project scripts through App`, async t => {
    const present = Object.keys(scripts).length > 0;
    const { f, view, project } = await completedCleanup(t, hostKind, 'complete', scripts);
    const result = f.messages.findLast(message => message.status === 'remove-result').result;
    assert.equal(result.verification, 'not-configured');
    assert.equal(result.projectScriptsPresent, present);
    assert.equal(workspace(view).props.state.result.projectScriptsPresent, present);
    assert.deepEqual(f.commands, ['install'], 'unselected scripts never run');
    assert.match(html(view), present ? /No checks selected/ : /No test scripts to run/);
    assert.doesNotMatch(html(view), present ? /No test scripts to run/ : /No checks selected/);
    // A later edit and dashboard refresh cannot rewrite the completed run's snapshot.
    const current = JSON.parse(await readFile(project.manifestPath, 'utf8'));
    await writeFile(project.manifestPath, JSON.stringify({ ...current, scripts: present ? {} : { test: 'node --test' } }));
    view.event(snapshot(beforeRows.slice(0, 1), 'later-edit'));
    assert.equal(workspace(view).props.state.result.projectScriptsPresent, present);
    assert.match(html(view), present ? /No checks selected/ : /No test scripts to run/);
  });
}

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} real restore and deletion messages replace the cleanup outcome through App and survive refresh`, async t => {
  const { f, view, analysisId } = await completedCleanup(t, hostKind);
  // Unrelated project outcomes cannot change this cleanup result.
  const before = workspace(view).props.state;
  view.event({ status: 'smart-cleanup-backup', analysisId: 'other-cleanup', outcome: 'restored' });
  assert.equal(workspace(view).props.state, before);
  workspace(view).props.onRestoreFiles(analysisId); view.render();
  await f.coordinator.handleRestoreSmartCleanup(view.sent.findLast(m => m.type === 'restore-smart-cleanup'));
  const review = view.find('RecoveryScreen');
  assert.ok(review);
  await f.coordinator.recovery.start(true, review.props.recovery.claim);
  await f.coordinator.recovery.apply(choices(view.find('RecoveryScreen').props.recovery, 'restore', true));
  await f.coordinator.recovery.dismiss(true, false);
  const state = workspace(view).props.state;
  assert.equal(state.restore.status, 'restored');
  assert.equal(state.result.metrics.length, 0);
  assert.equal(state.result.resolvedAdvisories.length, 0);
  assert.equal(state.result.introducedAdvisories.length, 0);
  assert.match(html(view), /Dependency files restored/);
  assert.match(html(view), /Restored dependencies/);
  assert.doesNotMatch(html(view), /Cleanup done|Undo cleanup|Removed dependencies|smart-cleanup-metrics|Configured project checks passed/);
  view.event(snapshot(beforeRows, 'another-refresh'));
  assert.equal(workspace(view).props.state.restore.status, 'restored');
  assert.doesNotMatch(html(view), /Cleanup done|Undo cleanup/);
  assert.deepEqual(f.messages.filter(m => m.status === 'smart-cleanup-backup').map(m => m.outcome), ['changed', 'restored', 'resolved']);
});

for (const outcome of ['keep', 'mixed', 'conflict']) test(`real recovery ${outcome} clears undo and avoids stale cleanup claims in App`, async t => {
  const { f, view, project, analysisId } = await completedCleanup(t, 'vscode');
  await f.coordinator.handleRestoreSmartCleanup({ analysisId });
  await f.coordinator.recovery.start(true, view.find('RecoveryScreen').props.recovery.claim);
  const selected = choices(view.find('RecoveryScreen').props.recovery, outcome === 'keep' ? 'keep' : 'restore', true);
  if (outcome === 'mixed') selected[1].action = 'keep';
  if (outcome === 'conflict') await writeFile(project.manifestPath, '{"name":"newer-edit"}');
  await f.coordinator.recovery.apply(selected);
  await f.coordinator.recovery.dismiss(true, true);
  assert.doesNotMatch(html(view), /Undo cleanup/);
  if (outcome === 'keep') {
    assert.match(html(view), /Cleanup done/);
    assert.ok(workspace(view).props.state.result.metrics.length > 0);
  } else {
    assert.equal(workspace(view).props.state.restore.status, 'resolved');
    assert.match(html(view), /Recovery complete/);
    assert.doesNotMatch(html(view), /Cleanup done|Dependency files restored|Removed dependencies|smart-cleanup-metrics/);
  }
});

test('a stale cleanup button is removed when its backup was replaced in another window', async t => {
  const { f, view, analysisId } = await completedCleanup(t, 'vscode');
  const backup = f.coordinator.cleanupBackups.get(analysisId);
  await prepareJournal(backup.target);
  await f.coordinator.handleRestoreSmartCleanup({ analysisId });
  assert.equal(workspace(view).props.state.restore, null);
  assert.doesNotMatch(html(view), /Undo cleanup/);
  assert.equal(view.find('RecoveryScreen'), undefined);
});

for (const hostKind of ['vscode', 'jetbrains']) for (const discovery of ['ordinary discovery', 'original undo request']) {
  test(`${hostKind} reopening reconstructs unchanged cleanup undo through App with ${discovery}`, async t => {
    const first = await completedCleanup(t, hostKind);
    const saved = first.f.coordinator.cleanupBackups.get(first.analysisId);
    const journalPath = path.join(first.project.root, '.packageawy-recovery', 'journal.json');
    const before = await readFile(journalPath, 'utf8');
    assert.equal(JSON.parse(before).cleanupAnalysisId, first.analysisId);
    first.view.unmount(); first.f.coordinator.disposeWhenIdle();
    const view = appHarness(t);
    const reopened = makeCoordinator(first.project, { mutationRoot: () => first.project.root });
    reopened.coordinator.options.platform.hostKind = hostKind;
    reopened.coordinator.options.platform.workspaceFolders = () => [{ id: 'project', name: 'fixture', path: first.project.root }];
    const post = reopened.coordinator.options.sink.postMessage;
    reopened.coordinator.options.sink.postMessage = message => { post(message); view.event(message); };
    view.event(snapshot(beforeRows.slice(0, 1), 'reopened'));
    assert.equal(reopened.coordinator.cleanupBackups.size, 0);
    if (discovery === 'original undo request') {
      await reopened.coordinator.handleRestoreSmartCleanup({ analysisId: first.analysisId });
    } else {
      await reopened.coordinator.recovery.inspect();
      assert.equal(view.find('RecoveryScreen'), undefined);
      assert.equal(view.find('Dashboard').props.actionsDisabled, false);
      assert.equal(view.find('DependencyChangeStatus') !== undefined, true);
      const button = undoButton(view);
      assert.equal(button.props.children, 'Undo cleanup');
      assert.equal(button.props.type, 'button');
      assert.equal(button.props.disabled, false);
      assert.match(renderToStaticMarkup(undoSections(view)[0]), /Cleanup done/);
      assert.equal(view.find('StatusBanner'), undefined);
      button.props.onClick(); view.render();
      assert.deepEqual(JSON.parse(JSON.stringify(view.sent.findLast(m => m.type === 'restore-smart-cleanup'))),
        { type: 'restore-smart-cleanup', analysisId: first.analysisId });
      await reopened.coordinator.handleRestoreSmartCleanup(view.sent.findLast(m => m.type === 'restore-smart-cleanup'));
    }
    const rebound = reopened.coordinator.cleanupBackups.get(first.analysisId);
    assert.equal(rebound.transactionId, saved.transactionId);
    assert.equal(rebound.target.identity, saved.target.identity);
    assert.match(rebound.target.allowlistedPaths[0], /[\\/]package\.json$/);
    assert.equal(view.find('RecoveryScreen').props.recovery.undoReview, true);
    assert.equal(view.find('RecoveryScreen').props.recovery.claim, null);
    view.find('RecoveryScreen').props.close(); view.render();
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
    assert.equal(reopened.coordinator.isBusy(), false);
    assert.equal((await inspectRecovery(rebound.target)).view.state, 'undo-available');
    assert.equal(await readFile(journalPath, 'utf8'), before, 'discovery and explicit review never modify the backup');
    await reopened.coordinator.handleRestoreSmartCleanup({ analysisId: first.analysisId });
    await reopened.coordinator.recovery.start(true, null);
    await reopened.coordinator.recovery.apply(choices(view.find('RecoveryScreen').props.recovery, 'restore', true));
    await reopened.coordinator.recovery.dismiss(true, false);
    assert.equal(view.find('RecoveryScreen'), undefined);
    assert.equal(undoButton(view), undefined);
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
    assert.deepEqual(reopened.messages.filter(m => m.status === 'smart-cleanup-backup').map(m => m.outcome), ['changed', 'restored', 'resolved']);
    assert.equal(reopened.prompts.length, 1, 'the existing reinstall offer remains available');
  });
}

for (const hostKind of ['vscode', 'jetbrains']) test(`${hostKind} a claim link with an uncertain result keeps recovery protection in App`, async t => {
  const { f, view, analysisId } = await completedCleanup(t, hostKind);
  await f.coordinator.handleRestoreSmartCleanup({ analysisId });
  const open = RecoverySession.open, fs = require('node:fs/promises');
  t.mock.method(RecoverySession, 'open', (target, stopped, claim, hooks, transactionId) => open(target, stopped, claim, {
    ...hooks, fs: { ...fs, link: async (...args) => {
      await fs.link(...args);
      throw Object.assign(new Error('claim publication result unknown'), { code: 'EIO' });
    } },
  }, transactionId));
  await f.coordinator.recovery.start(true, null);
  assert.equal(view.find('RecoveryScreen').props.recovery.state, 'blocked');
  assert.notEqual(view.find('RecoveryScreen').props.recovery.claim, null);
  view.find('RecoveryScreen').props.close(); view.render();
  assert.equal(view.find('Dashboard').props.actionsDisabled, true);
  assert.equal(f.coordinator.cleanupBackups.has(analysisId), true);
  assert.equal(f.messages.some(m => m.status === 'smart-cleanup-backup' && m.outcome === 'unavailable'), false);
  const backup = f.coordinator.cleanupBackups.get(analysisId);
  await assert.rejects(prepareJournal(backup.target), { message: RECOVERY_MESSAGES.blocked });
});

for (const hostKind of ['vscode', 'jetbrains']) for (const state of ['legacy', 'claimed', 'corrupt', 'replaced']) {
  test(`${hostKind} reopened discovery validates a ${state} cleanup backup before offering undo`, async t => {
    const first = await completedCleanup(t, hostKind);
    const saved = first.f.coordinator.cleanupBackups.get(first.analysisId);
    const journalPath = path.join(first.project.root, '.packageawy-recovery', 'journal.json');
    if (state === 'legacy') {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      delete journal.cleanupAnalysisId;
      await writeFile(journalPath, JSON.stringify(journal));
    } else if (state === 'claimed') {
      await RecoverySession.open(saved.target, true, null, {}, saved.transactionId);
    } else if (state === 'corrupt') {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      await writeFile(path.join(first.project.root, '.packageawy-recovery', 'backups', `${journal.files[0].backup.id}.bin`), 'corrupt backup');
    } else {
      const newer = await prepareJournal({ ...saved.target, operation: 'upgrade' }); await newer.finish('kept');
    }
    first.view.unmount(); first.f.coordinator.disposeWhenIdle();
    const view = appHarness(t), reopened = makeCoordinator(first.project, { mutationRoot: () => first.project.root });
    reopened.coordinator.options.platform.hostKind = hostKind;
    reopened.coordinator.options.platform.workspaceFolders = () => [{ id: 'project', name: 'fixture', path: first.project.root }];
    const post = reopened.coordinator.options.sink.postMessage;
    reopened.coordinator.options.sink.postMessage = message => { post(message); view.event(message); };
    view.event(snapshot(beforeRows.slice(0, 1), 'reopened'));
    const before = await readFile(journalPath, 'utf8');
    await reopened.coordinator.recovery.inspect();
    assert.equal(view.find('RecoveryScreen'), undefined, 'discovery does not automatically open recovery');
    assert.equal(view.find('Dashboard').props.actionsDisabled, state === 'claimed' || state === 'corrupt');
    assert.equal(await readFile(journalPath, 'utf8'), before);
    if (state === 'legacy') {
      const button = undoButton(view);
      assert.equal(button.props.children, 'Undo cleanup');
      button.props.onClick(); view.render();
      const request = view.sent.findLast(m => m.type === 'restore-smart-cleanup');
      assert.equal(request.analysisId, saved.transactionId);
      await reopened.coordinator.handleRestoreSmartCleanup(request);
      assert.equal(view.find('RecoveryScreen').props.recovery.state, 'undo-available');
      assert.equal(view.find('RecoveryScreen').props.recovery.claim, null);
    } else if (state === 'replaced') {
      const button = undoButton(view);
      assert.equal(button.props.children, 'Undo upgrade');
      const entry = reopened.messages.findLast(m => m.status === 'smart-cleanup-backups').entries[0];
      assert.equal(entry.operation, 'upgrade');
      assert.notEqual(entry.analysisId, first.analysisId);
    } else {
      assert.equal(undoButton(view), undefined);
      assert.deepEqual(reopened.messages.findLast(m => m.status === 'smart-cleanup-backups').entries, []);
    }
  });
}

for (const packageManager of ['npm', 'pnpm']) for (const hostKind of ['vscode', 'jetbrains'])
for (const replacement of ['before review opens', 'after review opens', 'during claim preparation']) {
  test(`${hostKind} stale ${packageManager} member A undo clears in App when member B replaces the shared backup ${replacement}`, async t => {
    const { f, view, project, analysisId } = await completedCleanup(t, hostKind);
    const workspaceRoot = project.root;
    const original = f.coordinator.cleanupBackups.get(analysisId);
    await writeFile(project.manifestPath, JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*'] }));
    const lock = path.join(workspaceRoot, packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml');
    if (packageManager === 'pnpm') {
      await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      await writeFile(lock, 'lockfileVersion: 9\n');
    }
    const targets = [];
    for (const member of ['a', 'b']) {
      const projectDir = path.join(workspaceRoot, 'packages', member);
      await mkdir(projectDir, { recursive: true });
      const manifest = path.join(projectDir, 'package.json');
      await writeFile(manifest, JSON.stringify({ name: member, dependencies: {} }));
      const resolved = await resolveMutationTarget({ projectDir, folderPath: workspaceRoot, packageManager });
      assert.equal(resolved.ok, true);
      targets.push({ ...original.target, identity: resolved.identity, allowlistedPaths: [manifest, lock] });
    }
    // Seed a retained member undo point. Starting new Smart Cleanup runs in
    // shared-lockfile members is analysis-only, but saved undo identities must
    // still be safe if the workspace layout or another window changes.
    const savedA = await prepareJournal(targets[0]); await savedA.finish('kept');
    f.coordinator.cleanupBackups.set(analysisId, { target: targets[0], transactionId: savedA.owner.transactionId });
    const openReview = async () => {
      workspace(view).props.onRestoreFiles(analysisId); view.render();
      await f.coordinator.handleRestoreSmartCleanup(view.sent.findLast(m => m.type === 'restore-smart-cleanup'));
    };
    if (replacement !== 'before review opens') {
      await openReview();
      assert.equal(view.find('RecoveryScreen').props.recovery.state, 'undo-available');
    }
    const targetB = targets[1];
    let newer, before;
    const replace = async () => {
      newer = await prepareJournal(targetB); await newer.finish('kept');
      before = await readFile(path.join(workspaceRoot, '.packageawy-recovery', 'journal.json'), 'utf8');
    };
    if (replacement === 'during claim preparation') {
      const open = RecoverySession.open;
      t.mock.method(RecoverySession, 'open', (target, stopped, claim, hooks, transactionId) => open(target, stopped, claim, {
        ...hooks, platform: 'win32',
        boundary: async name => {
          await hooks.boundary?.(name);
          // A's claim inode is synced, but no claim has been linked. B can
          // replace the backup completely while A waits at this boundary.
          if (name === 'synced:claim.json') await replace();
        },
      }, transactionId));
    } else await replace();
    const warnings = [];
    f.coordinator.options.platform.showWarningMessage = message => warnings.push(message);
    const messageCount = f.messages.length;
    if (replacement !== 'before review opens') {
      const screen = view.find('RecoveryScreen');
      screen.props.send({ type: 'start-recovery', stopped: true, claim: screen.props.recovery.claim });
      const request = view.sent.findLast(m => m.type === 'start-recovery');
      await f.coordinator.recovery.start(request.stopped, request.claim);
    } else await openReview();
    assert.deepEqual(warnings, [RECOVERY_MESSAGES.undoUnavailable]);
    assert.deepEqual(f.messages.findLast(m => m.status === 'smart-cleanup-backup'),
      { status: 'smart-cleanup-backup', analysisId, outcome: 'unavailable' });
    assert.equal(f.coordinator.cleanupBackups.has(analysisId), false);
    assert.equal(workspace(view).props.state.restore, null);
    assert.match(html(view), /Cleanup done/);
    assert.doesNotMatch(html(view), /Undo cleanup/);
    assert.equal(view.find('RecoveryScreen'), undefined);
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
    assert.equal(f.coordinator.recovery.undo, undefined);
    assert.equal(f.coordinator.recovery.session, undefined);
    assert.equal(f.messages.slice(messageCount).some(m => m.status === 'recovery' && m.recovery.state === 'invalid'), false);
    assert.equal(f.coordinator.isBusy(), false);
    const latest = await inspectRecovery(targetB);
    assert.equal(latest.owner.transactionId, newer.owner.transactionId);
    assert.equal(latest.view.state, 'undo-available');
    assert.equal(latest.view.claim, null);
    assert.equal(await readFile(path.join(workspaceRoot, '.packageawy-recovery', 'journal.json'), 'utf8'), before);
  });
}

for (const hostKind of ['vscode', 'jetbrains']) for (const mode of ['keep', 'mixed', 'discard', 'restore']) {
  test(`${hostKind} failed cleanup recovery ${mode} clears obsolete attention through real host messages`, async t => {
    const { f, view, analysisId } = await completedCleanup(t, hostKind, 'conflict');
    assert.equal(workspace(view).props.state.result.analysisId, analysisId);
    await f.coordinator.recovery.inspect();
    const context = view.elements().find(element => element.props?.value?.openRecovery)?.props.value;
    context.openRecovery(); view.render();
    await f.coordinator.recovery.inspect();
    const recovery = view.find('RecoveryScreen');
    assert.ok(recovery);
    await f.coordinator.recovery.start(true, recovery.props.recovery.claim);
    if (mode !== 'discard') {
      const selected = choices(view.find('RecoveryScreen').props.recovery, mode === 'keep' ? 'keep' : 'restore', true);
      if (mode === 'mixed') selected[1].action = 'keep';
      await f.coordinator.recovery.apply(selected);
    }
    await f.coordinator.recovery.dismiss(true, mode !== 'restore');
    assert.equal(view.find('RecoveryScreen'), undefined);
    const state = workspace(view).props.state;
    assert.equal(state.phase, 'complete');
    assert.equal(state.restore.status, mode === 'restore' ? 'restored' : 'resolved');
    assert.match(html(view), mode === 'restore' ? /Dependency files restored/ : /Recovery complete/);
    assert.match(html(view), /Analyze the current project/);
    assert.doesNotMatch(html(view), /actions need attention|action needs attention|Failed actions|manual review|Undo cleanup|Cleanup done/);
    assert.deepEqual(f.messages.findLast(m => m.status === 'smart-cleanup-backup'), { status: 'smart-cleanup-backup', analysisId, outcome: 'resolved' });
    view.event(snapshot(beforeRows, 'after-recovery'));
    assert.equal(workspace(view).props.state.restore.status, mode === 'restore' ? 'restored' : 'resolved');
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
  });
}
