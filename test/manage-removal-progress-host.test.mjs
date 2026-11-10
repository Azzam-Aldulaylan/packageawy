/** A removal confirmed from the Manage dialog: real progress phases, and the dialog shows the result instead of a notification. */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
const { isHostToWebviewMessage } = await import('../out/host/webviewProtocol.js');

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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-manage-removal-')));
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
  return { coordinator, messages, commands, information, warnings };
}

async function removeReact(fixture, confirm) {
  await fixture.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const review = fixture.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(review, `the removal review was posted: ${JSON.stringify(fixture.messages.at(-1))}`);
  await fixture.coordinator.handleConfirmRemove({ analysisId: review.analysis.analysisId, ...confirm });
  const result = fixture.messages.findLast((message) => message.status === 'remove-result');
  assert.ok(result, `the removal finished: ${JSON.stringify(fixture.messages.at(-1))}`);
  return { analysisId: review.analysis.analysisId, result: result.result };
}

test('a removal posts each phase it enters, in order, for its own review', async (t) => {
  const fixture = makeCoordinator(await makeProject(t));
  const { analysisId, result } = await removeReact(fixture, { resultInDialog: true });
  const progress = fixture.messages.filter((message) => message.status === 'remove-progress');
  assert.deepEqual(progress.map((message) => message.phase), ['installing', 'verifying', 'refreshing']);
  assert.ok(progress.every((message) => message.analysisId === analysisId));
  assert.equal(result.outcome, 'verified');
  const resultIndex = fixture.messages.findIndex((message) => message.status === 'remove-result');
  assert.ok(fixture.messages.findIndex((message) => message.status === 'remove-progress') < resultIndex);
});

test('a removal shown in the Manage dialog skips the notification', async (t) => {
  const fixture = makeCoordinator(await makeProject(t));
  await removeReact(fixture, { resultInDialog: true });
  assert.deepEqual(fixture.information, []);
  assert.deepEqual(fixture.warnings, []);
});

test('a removal started elsewhere still shows the notification', async (t) => {
  const fixture = makeCoordinator(await makeProject(t));
  await removeReact(fixture, {});
  assert.equal(fixture.information.length, 1);
  assert.match(fixture.information[0], /^Removed react\./);
});
