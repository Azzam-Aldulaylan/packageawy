/**
 * The coordinator side of the internal error gate: every path rechecks the
 * pause right before the mutation boundary, a change that already started
 * finishes and releases normally, and awaited releases cannot clear a review
 * that replaced the one they release.
 */

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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-runtime-gate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'package.json');
  const lockfilePath = path.join(root, 'package-lock.json');
  await writeFile(manifestPath, MANIFEST);
  await writeFile(lockfilePath, lockfile(true));
  return { root, manifestPath, lockfilePath };
}

/** The real Smart Cleanup removal path against a temporary npm project, with only the package manager faked. */
function makeCoordinator(project, hooks = {}) {
  const messages = [];
  const commands = [];
  const state = { paused: false, holdRead: undefined, holdInstall: undefined };
  const read = async () => {
    if (state.holdRead !== undefined) await state.holdRead();
    return {
      root: project.root,
      manifestText: await readFile(project.manifestPath, 'utf8'),
      lockfileText: await readFile(project.lockfilePath, 'utf8'),
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
    showWarningMessage() {},
    showInformationMessage() {},
    showErrorMessage() {},
    async runProcess(request) {
      const command = request.args.find((arg) => arg === 'install' || arg === 'ci');
      commands.push(command);
      if (command === 'install') {
        if (state.holdInstall !== undefined) await state.holdInstall();
        await writeFile(project.lockfilePath, lockfile(false));
      }
      return { onDidExit: (listener) => { setImmediate(() => listener(0)); return { dispose() {} }; } };
    },
  };
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => {
      assert.ok(isHostToWebviewMessage(message), `invalid host message ${JSON.stringify(message)}`);
      messages.push(message);
    } },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root: project.root,
      upgradeSource: await read(),
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
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
    changesPaused: () => state.paused,
    ...hooks,
  });
  return { coordinator, messages, commands, state };
}

async function review(fixture) {
  await fixture.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'cleanup', removalRequestId: 'impact', packages: ['react'] });
  const posted = fixture.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(posted, 'the removal review was posted');
  return posted.analysis.analysisId;
}

function blocker() {
  let release;
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return { wait: async () => { reached(); await gate; }, arrived, release };
}

test('a review kept from before the failure cannot be confirmed after it', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  fixture.state.paused = true;
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  const refused = fixture.messages.at(-1);
  assert.equal(refused.status, 'remove-error');
  assert.equal(refused.error.code, 'CHANGES_PAUSED');
  assert.deepEqual(fixture.commands, [], 'no package manager ran');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  assert.equal(fixture.coordinator.isBusy(), false, 'the reservation was released');
});

test('a failure that lands while a confirmation is in preflight stops it before writing', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  const hold = blocker();
  fixture.state.holdRead = hold.wait;
  const confirming = fixture.coordinator.handleConfirmRemove({ analysisId });
  await hold.arrived;
  fixture.state.paused = true;
  fixture.state.holdRead = undefined;
  hold.release();
  await confirming;
  assert.equal(fixture.messages.at(-1).error?.code, 'CHANGES_PAUSED');
  assert.deepEqual(fixture.commands, []);
  assert.equal(await readFile(project.manifestPath, 'utf8'), MANIFEST);
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('a change already running finishes and releases normally after a failure elsewhere', async (t) => {
  const project = await makeProject(t);
  const releases = [];
  const fixture = makeCoordinator(project, { onMutationLockReleased: () => releases.push('released') });
  const analysisId = await review(fixture);
  const hold = blocker();
  fixture.state.holdInstall = hold.wait;
  const confirming = fixture.coordinator.handleConfirmRemove({ analysisId });
  await hold.arrived;
  assert.equal(fixture.coordinator.isMutationBusy(), true, 'the install is inside the mutation boundary');
  fixture.state.paused = true;
  hold.release();
  await confirming;
  const result = fixture.messages.findLast((message) => message.status === 'remove-result');
  assert.ok(result, `the removal finished: ${JSON.stringify(fixture.messages.at(-1))}`);
  assert.equal(result.result.outcome, 'verified');
  assert.equal(fixture.coordinator.isBusy(), false, 'the lock was released');
  assert.ok(releases.length > 0, 'the normal post-release callback ran');
});

test('a kept Smart Cleanup restore is refused after the failure without touching files', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  const result = fixture.messages.findLast((message) => message.status === 'remove-result').result;
  assert.equal(result.restoreAvailable, true);
  fixture.state.paused = true;
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  assert.equal(fixture.messages.at(-1).error.code, 'CHANGES_PAUSED');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false), 'nothing was restored');
  assert.deepEqual(fixture.commands, ['install'], 'no reinstall ran');
});

function raceFixture() {
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage() {} },
    httpClient: {},
    etagStore: {},
    ensureController: async () => undefined,
    getSelectedProject: () => undefined,
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
  });
  const pending = [];
  coordinator.releaseReservation = () => new Promise((resolve) => pending.push(resolve));
  return { coordinator, finishRelease: () => pending.splice(0).forEach((resolve) => resolve()) };
}

test('cancelling a review while a new one is stored leaves the new one in place', async () => {
  const { coordinator, finishRelease } = raceFixture();
  const later = Date.now() + 60_000;
  coordinator.analysis = { id: 'old', eligibility: { packageName: 'left-pad' }, expiresAt: later };
  const cancelling = coordinator.handleCancelUpgrade({ analysisId: 'old' });
  assert.equal(coordinator.analysis, undefined, 'cleared before the release is awaited');
  const replacement = { id: 'new', eligibility: { packageName: 'left-pad' }, expiresAt: later };
  coordinator.analysis = replacement;
  finishRelease();
  await cancelling;
  assert.equal(coordinator.analysis, replacement);

  coordinator.removal = { id: 'old-removal', reservationKey: 'react', expiresAt: later };
  const cancellingRemoval = coordinator.handleCancelRemove({ analysisId: 'old-removal' });
  const removalReplacement = { id: 'new-removal', reservationKey: 'react', expiresAt: later };
  coordinator.removal = removalReplacement;
  finishRelease();
  await cancellingRemoval;
  assert.equal(coordinator.removal, removalReplacement);
});

test('reclaiming an expired review while a replacement is stored leaves the replacement in place', async () => {
  const { coordinator, finishRelease } = raceFixture();
  coordinator.analysis = { id: 'expired', eligibility: { packageName: 'left-pad' }, expiresAt: Date.now() - 1 };
  coordinator.removal = { id: 'expired-removal', reservationKey: 'react', expiresAt: Date.now() - 1 };
  const reclaimingAnalysis = coordinator.reclaimExpiredAnalysis();
  const reclaimingRemoval = coordinator.reclaimExpiredRemoval();
  assert.equal(coordinator.analysis, undefined);
  assert.equal(coordinator.removal, undefined);
  const analysis = { id: 'fresh', eligibility: { packageName: 'left-pad' }, expiresAt: Date.now() + 60_000 };
  const removal = { id: 'fresh-removal', reservationKey: 'react', expiresAt: Date.now() + 60_000 };
  coordinator.analysis = analysis;
  coordinator.removal = removal;
  finishRelease();
  await Promise.all([reclaimingAnalysis, reclaimingRemoval]);
  assert.equal(coordinator.analysis, analysis);
  assert.equal(coordinator.removal, removal);
});

test('a failed background release pauses changes through the panel', async () => {
  const reports = [];
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage() {} },
    httpClient: {},
    etagStore: {},
    ensureController: async () => undefined,
    getSelectedProject: () => undefined,
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    reportBackgroundFailure: (context, _error, fence) => reports.push([context, fence]),
  });
  coordinator.releaseReservation = async () => {
    throw new Error('lock state broke');
  };
  coordinator.removal = { id: 'review', reservationKey: 'react', expiresAt: Date.now() + 60_000 };
  coordinator.handleProjectSourceChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, [['reservation-release', true]]);
});
