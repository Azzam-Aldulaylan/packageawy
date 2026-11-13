/** Smart Cleanup restore point: kept after a successful run, restored on request, refused after a later edit. */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
const { createNodeUpgradeTransactionFileAdapter } = await import('../out/host/nodeUpgradeTransactionFiles.js');
const restorePoint = await import('../out/host/smartCleanupRestorePoint.js');
const { isHostToWebviewMessage, isWebviewToHostMessage } = await import('../out/host/webviewProtocol.js');
import { refusedTarget, resolvedTarget } from './helpers/mutation-target.mjs';

const MANIFEST = `${JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.3.0', react: '^18.0.0' } }, null, 2)}\n`;

function lockfile(includeReact) {
  const dependencies = includeReact ? { 'left-pad': '^1.3.0', react: '^18.0.0' } : { 'left-pad': '^1.3.0' };
  return `${JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture', dependencies },
      'node_modules/left-pad': { version: '1.3.0' },
      ...(includeReact ? { 'node_modules/react': { version: '18.2.0' } } : {}),
    },
  }, null, 2)}\n`;
}

async function makeProject(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-cleanup-restore-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'package.json');
  const lockfilePath = path.join(root, 'package-lock.json');
  await writeFile(manifestPath, MANIFEST);
  await writeFile(lockfilePath, lockfile(true));
  return { root, manifestPath, lockfilePath };
}

function makeCoordinator(project) {
  const messages = [];
  const commands = [];
  const information = [];
  const warnings = [];
  let target;
  const read = async () => {
    const manifestText = await readFile(project.manifestPath, 'utf8');
    const lockfileText = await readFile(project.lockfilePath, 'utf8');
    return {
      root: project.root,
      manifestText,
      lockfileText,
      lockfilePath: project.lockfilePath,
      lockfileName: 'package-lock.json',
      registry: 'https://registry.npmjs.org/',
      resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
      packageManager: 'npm',
      importerId: '.',
      mutationTarget: target ?? resolvedTarget(project.root),
    };
  };
  const platform = {
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => true,
    async updateWorkspaceSetting() {},
    showWarningMessage: (message) => warnings.push(message),
    showInformationMessage: (message) => information.push(message),
    showErrorMessage: (message) => warnings.push(message),
    async runProcess(request) {
      const command = request.args.find((arg) => arg === 'install' || arg === 'ci');
      commands.push({ command, title: request.title });
      // The package manager's part of the cleanup: drop react from the lockfile.
      if (command === 'install') await writeFile(project.lockfilePath, lockfile(false));
      return { onDidExit: (listener) => { setImmediate(() => listener(0)); return { dispose() {} }; } };
    },
  };
  let source;
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => {
      assert.ok(isHostToWebviewMessage(message), `invalid host message ${JSON.stringify(message)}`);
      messages.push(message);
    } },
    httpClient: {},
    etagStore: {},
    ensureController: async () => {
      source = await read();
      return {
        root: project.root,
        upgradeSource: source,
        validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
      };
    },
    getSelectedProject: () => ({
      id: 'project',
      dir: '',
      folder: { id: `file://${project.root}`, name: 'fixture', path: project.root },
    }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    smartCleanupRemovalEvidence: () => ({ isCurrent: () => true }),
    loadProject: read,
  });
  return { coordinator, messages, commands, information, warnings, setTarget: (next) => { target = next; } };
}

async function runCleanup(fixture) {
  await fixture.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'cleanup', removalRequestId: 'impact', packages: ['react'] });
  const review = fixture.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(review, 'the removal review was posted');
  await fixture.coordinator.handleConfirmRemove({ analysisId: review.analysis.analysisId });
  const result = fixture.messages.findLast((message) => message.status === 'remove-result');
  assert.ok(result, `the cleanup finished: ${JSON.stringify(fixture.messages.at(-1))}`);
  return result.result;
}

test('a successful Smart Cleanup keeps its restore point and restore puts both files back', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const result = await runCleanup(fixture);
  assert.equal(result.outcome, 'verified');
  assert.equal(result.restoreAvailable, true);
  // No build or test scripts are configured, so only the dependency files were checked.
  assert.equal(result.verification, 'not-configured');
  assert.match(result.message, /^Removed react\. Dependency files were checked\. No build or test scripts ran\.$/);
  assert.doesNotMatch(result.message, /verification passed/);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
  assert.doesNotMatch(await readFile(project.manifestPath, 'utf8'), /react/);

  // A watcher event for the cleanup's own writes does not drop the restore point.
  fixture.coordinator.handleProjectSourceChanged();
  await new Promise((resolve) => setImmediate(resolve));

  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  const restored = fixture.messages.at(-1);
  assert.equal(restored.status, 'remove-result');
  assert.equal(restored.result.analysisId, result.analysisId);
  assert.equal(restored.result.outcome, 'rolled-back');
  assert.equal(restored.result.rollback, 'succeeded');
  assert.equal(restored.result.message, restorePoint.SMART_CLEANUP_RESTORE_MESSAGES.restored);
  assert.equal(await readFile(project.manifestPath, 'utf8'), MANIFEST);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  assert.deepEqual(fixture.commands.at(-1), { command: 'ci', title: 'Packageawy: Restore dependency files' });
  assert.equal(fixture.coordinator.isBusy(), false, 'the restore released its reservation');

  // Single use: a second request is refused without touching files.
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  assert.equal(fixture.messages.at(-1).error.code, 'RESTORE_UNAVAILABLE');
});

test('restore resolves the mutation target again and refuses without touching files', async (t) => {
  for (const [label, next, code] of [
    ['a refusal', refusedTarget('PNPMFILE', 'This project uses a pnpmfile, which can change where pnpm writes the lockfile. Changes are unavailable.'), 'CHANGES_UNAVAILABLE'],
    ['a moved target', (root) => resolvedTarget(root, { targetRoot: path.dirname(root), importerId: path.basename(root) }), 'RESTORE_UNAVAILABLE'],
  ]) {
    const project = await makeProject(t);
    const fixture = makeCoordinator(project);
    const result = await runCleanup(fixture);
    fixture.setTarget(typeof next === 'function' ? next(project.root) : next);
    await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
    const refused = fixture.messages.at(-1);
    assert.equal(refused.status, 'remove-error', label);
    assert.equal(refused.error.code, code, label);
    if (code === 'CHANGES_UNAVAILABLE') assert.equal(refused.error.message, next.refusal.reason);
    assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false), `${label}: nothing was restored`);
    assert.doesNotMatch(await readFile(project.manifestPath, 'utf8'), /react/);
    assert.equal(fixture.commands.filter((entry) => entry.command === 'ci').length, 0, `${label}: nothing was reinstalled`);
    assert.equal(fixture.coordinator.isBusy(), false);
  }
});

test('restore is refused when the manifest changed after the cleanup', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const result = await runCleanup(fixture);
  const edited = (await readFile(project.manifestPath, 'utf8')).replace('"fixture"', '"fixture-edited"');
  await writeFile(project.manifestPath, edited);
  fixture.coordinator.handleProjectSourceChanged();
  await new Promise((resolve) => setTimeout(resolve, 20));

  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  const refused = fixture.messages.at(-1);
  assert.equal(refused.status, 'remove-error');
  assert.equal(refused.error.code, 'RESTORE_CONFLICT');
  assert.match(refused.error.message, /Newer edits were preserved/);
  assert.equal(await readFile(project.manifestPath, 'utf8'), edited);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
  assert.equal(fixture.commands.filter((entry) => entry.command === 'ci').length, 0, 'nothing was reinstalled');
});

test('the guard also refuses a lockfile edit that arrives without a watcher event', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const result = await runCleanup(fixture);
  await writeFile(project.lockfilePath, `${lockfile(false)}\n`);

  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  assert.equal(fixture.messages.at(-1).error.code, 'RESTORE_CONFLICT');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), `${lockfile(false)}\n`);
  assert.doesNotMatch(await readFile(project.manifestPath, 'utf8'), /react/, 'package.json was not restored on its own');
});

test('a new analysis or a new dependency change drops the restore point', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const result = await runCleanup(fixture);
  fixture.coordinator.discardSmartCleanupRestorePoint();
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  assert.equal(fixture.messages.at(-1).error.code, 'RESTORE_UNAVAILABLE');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));

  const second = makeCoordinator(await makeProject(t));
  const kept = await runCleanup(second);
  await second.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'next', removalRequestId: 'impact', packages: ['react'] });
  await second.coordinator.handleRestoreSmartCleanup({ analysisId: kept.analysisId });
  assert.equal(second.messages.at(-1).error.code, 'RESTORE_UNAVAILABLE');
});

test('a swap that loses a race puts already restored files back', async (t) => {
  const project = await makeProject(t);
  const files = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: project.root,
    allowlistedPaths: [project.manifestPath, project.lockfilePath],
  });
  const before = [
    { path: project.manifestPath, before: await files.read(project.manifestPath) },
    { path: project.lockfilePath, before: await files.read(project.lockfilePath) },
  ];
  await writeFile(project.manifestPath, '{}\n');
  await writeFile(project.lockfilePath, lockfile(false));
  const captured = await restorePoint.captureSmartCleanupRestoreFiles(files, before);
  assert.equal(captured.length, 2);

  const racing = {
    read: (filePath) => files.read(filePath),
    async compareAndSwap(filePath, expected, replacement) {
      if (filePath === project.lockfilePath) await writeFile(project.lockfilePath, 'edited during restore\n');
      return files.compareAndSwap(filePath, expected, replacement);
    },
  };
  const outcome = await restorePoint.restoreSmartCleanupFiles(racing, captured);
  assert.deepEqual(outcome, { status: 'conflict', wrote: true, recovered: true });
  assert.equal(await readFile(project.manifestPath, 'utf8'), '{}\n');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), 'edited during restore\n');
});

test('the protocol accepts only a correlated restore request and a kept-result restore flag', () => {
  assert.equal(isWebviewToHostMessage({ type: 'restore-smart-cleanup', analysisId: 'a1' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'restore-smart-cleanup', analysisId: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'restore-smart-cleanup', analysisId: 'a1', path: '/etc' }), false);
  const result = {
    analysisId: 'a1',
    packages: ['react'],
    outcome: 'verified',
    verification: 'passed',
    rollback: 'not-needed',
    message: 'Done.',
  };
  assert.equal(isHostToWebviewMessage({ status: 'remove-result', result: { ...result, restoreAvailable: true } }), false,
    'the flag is only for Smart Cleanup results');
  assert.equal(isHostToWebviewMessage({ status: 'remove-result', result: { ...result, restoreAvailable: false } }), false);
  assert.equal(isHostToWebviewMessage({ status: 'remove-result', result }), true);
});
