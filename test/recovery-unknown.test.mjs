import { test } from 'node:test';
import { manualReinstallNote } from '../out/host/manualReinstallCopy.js';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';
import { createRangePreservingInstall } from '../out/host/rangePreservingInstall.js';
import { OperationReservation } from '../out/host/operationReservation.js';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { RpcPlatform } from '../out/host/platform/rpc/rpcPlatform.js';
import { RecoveryCoordinator } from '../out/host/recovery/coordinator.js';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { makeProject, makeCoordinator, review, lockfile } from './helpers/removal-project.mjs';

const invocation = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
const params = { cwd: '/workspace', ignoreScripts: true, packageManager: 'npm' };
function owned(target) {
  const locks = new ProjectMutationLocks();
  const released = [];
  const reservation = new OperationReservation({ locks, reserve: () => true, release: () => released.push('release'),
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  return { locks, released, reservation, handle: reservation.reserve('change', target.root) };
}

for (const mode of ['missing-result', 'launch-rejection', 'subscription-exception', 'session-disposal']) test(`${mode} becomes typed unknown and keeps both locks and the journal`, async t => {
  const f = await recoveryFixture(t);
  const owner = owned(f.target);
  assert.equal(await owner.handle.beginMutation(f.target), true);
  const platform = {
    isWorkspaceTrusted: () => true,
    runProcess: async () => {
      if (mode === 'launch-rejection') { await writeFile(f.lockfile, 'started before rejection'); throw new Error('launch rejected after dispatch'); }
      if (mode === 'session-disposal') { setImmediate(() => session.dispose()); return { onDidExit: () => ({ dispose() {} }) }; }
      return { onDidExit(listener) {
        if (mode === 'subscription-exception') throw new Error('subscription lost after dispatch');
        setImmediate(() => listener(undefined)); return { dispose() {} };
      } };
    },
  };
  const session = new UpgradeExecutionSession(platform, invocation);
  const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: owner.handle.journal.adapter(), journal: owner.handle.journal,
    manifestStage: { path: f.manifest, expectedContents: (await readFile(f.manifest)), contents: Buffer.from('staged manifest') },
    install: { async execute() {
      const outcome = await session.prepareManifestReconciliation(params).execute();
      return outcome.ok ? { status: 'succeeded' } : outcome.status === 'unknown' ? { status: 'unknown', message: outcome.message } : { status: 'failed', code: outcome.code, message: outcome.message };
    } },
  });
  assert.equal(result.completion, 'unknown');
  assert.equal(result.rollback.status, 'not-needed');
  owner.handle.markUnknown('lost result'); await owner.handle.journal.unknown('lost result');
  assert.equal(owner.handle.state, 'unknown');
  assert.equal(owner.locks.holderOf(canonicalProjectRoot(f.root)), owner.handle);
  assert.equal(owner.reservation.isMutationBusy, true);
  assert.equal(await owner.handle.complete('kept'), false);
  assert.equal(await owner.handle.releaseReadOnly(), false);
  assert.equal(await f.read('package.json'), 'staged manifest');
  assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
  assert.deepEqual(owner.released, []);
});

for (const phase of ['install-pass-one', 'install-pass-two', 'verification', 'reconciliation']) test(`unknown during ${phase} stops without rollback or further tasks`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  let calls = 0;
  const unknown = { ok: false, status: 'unknown', code: 'OUTCOME_UNKNOWN', message: 'lost' };
  const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(), journal,
    manifestStage: { path: f.manifest, expectedContents: await readFile(f.manifest), contents: Buffer.from('staged') },
    install: createRangePreservingInstall({ manifestPath: f.manifest, stagedManifest: 'staged', styledManifest: 'styled',
      resolve: async () => { calls++; await writeFile(f.lockfile, 'installed'); return phase === 'install-pass-one' || phase === 'reconciliation' ? unknown : { ok: true }; },
      restyle: async () => { calls++; return phase === 'install-pass-two' ? unknown : { ok: true }; },
    }),
    verifier: { verify: async () => { calls++; return { status: 'unknown', checks: [], message: 'lost' }; } },
  });
  assert.equal(result.completion, 'unknown');
  assert.equal(result.rollback.status, 'not-needed');
  assert.equal(await f.read('package-lock.json'), 'installed');
  assert.equal(calls, phase === 'verification' ? 3 : phase === 'install-pass-two' ? 2 : 1);
});

for (const phase of ['install', 'verification', 'completion-write']) test(`exception after ${phase} dispatch is unknown`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(),
    journal: { record: async (step, state) => { if (phase === 'completion-write' && step === 'install' && state === 'finished') throw new Error('EIO'); await journal.record(step, state); } },
    install: { execute: async () => { await writeFile(f.lockfile, 'installed'); if (phase === 'install') throw new Error('after dispatch'); return { status: 'succeeded' }; } },
    verifier: { verify: async () => { throw new Error('verification result lost'); } },
  });
  assert.equal(result.completion, 'unknown');
  assert.equal(result.rollback.status, 'not-needed');
  assert.equal(await f.read('package-lock.json'), 'installed');
});

test('RPC disconnect and disposal report lost results, including a listener attached after disposal', async () => {
  let close;
  const notifications = new Map();
  const connection = { sendRequest: async () => null, sendNotification() {}, onNotification: (method, listener) => notifications.set(method, listener), onClose(listener) { close = listener; return { dispose() {} }; } };
  const platform = new RpcPlatform(connection, { workspaceFolders: [], isWorkspaceTrusted: true, settings: {}, workspaceState: {}, globalState: {} });
  const session = new UpgradeExecutionSession(platform, invocation);
  const prepared = session.prepareLockfileReconciliation(params);
  const result = prepared.execute();
  await new Promise(resolve => setImmediate(resolve));
  close();
  assert.equal((await result).status, 'unknown');
  assert.equal((await prepared.execute()).code, 'RECONCILIATION_ALREADY_EXECUTED');
  const late = new RpcPlatform(connection, { workspaceFolders: [], isWorkspaceTrusted: true, settings: {}, workspaceState: {}, globalState: {} });
  const running = await late.runProcess({ executable: 'node', args: [], cwd: '/', title: 'test', scope: 'test' });
  late.dispose();
  assert.equal(await new Promise(resolve => running.onDidExit(resolve)), undefined);
});

test('the real coordinator settles missing task results with markUnknown and transfers its handle only after a claim', async t => {
  const project = await makeProject(t);
  const locks = new ProjectMutationLocks();
  const platform = { getSetting: (_key, fallback) => fallback, isWorkspaceTrusted: () => true,
    showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {},
    runProcess: async () => ({ onDidExit(listener) { setImmediate(() => listener(undefined)); return { dispose() {} }; } }),
  };
  const fixture = makeCoordinator(project, { platform, mutationLocks: locks, mutationRoot: () => project.root });
  fixture.coordinator.session.invocationResolver = invocation;
  const analysisId = await review(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  const handle = locks.holderOf(canonicalProjectRoot(project.root));
  assert.equal(handle.state, 'unknown');
  assert.equal(handle.journal.data.outcome, 'unknown');
  assert.notEqual(await readFile(project.manifestPath, 'utf8'), handle.journal.data.files[0].backup.sha256);
  await fixture.coordinator.handleWebviewReady(); fixture.coordinator.disposeWhenIdle();
  await fixture.coordinator.recovery.inspect();
  const initial = fixture.messages.at(-1).recovery;
  await fixture.coordinator.recovery.start(false, initial.claim);
  assert.equal(handle.state, 'unknown');
  await fixture.coordinator.recovery.start(true, initial.claim);
  assert.equal(handle.state, 'transferred');
  assert.equal(await handle.complete('kept'), false);
  await fixture.coordinator.recovery.apply(choices(fixture.messages.at(-1).recovery));
  assert.equal(locks.holderOf(canonicalProjectRoot(project.root)).state, 'recovery');
  await fixture.coordinator.recovery.dismiss(true, false);
  assert.equal(locks.holderOf(canonicalProjectRoot(project.root)), undefined);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true), 'unknown never ran rollback');
});

test('a recovery session started with no local owner holds a process lock until removal, including after reopening', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  const locks = new ProjectMutationLocks();
  const messages = [];
  const options = { platform: { showWarningMessage() {} }, locks, target: async () => f.target, post: message => messages.push(message), removed: async () => {} };
  const first = new RecoveryCoordinator(options);
  await first.start(true, null);
  assert.ok(locks.holderOf(canonicalProjectRoot(f.root)));
  const reopened = new RecoveryCoordinator(options);
  await reopened.start(true, messages.at(-1).recovery.claim);
  await reopened.apply(choices(messages.at(-1).recovery));
  await reopened.dismiss(true, false);
  assert.equal(locks.holderOf(canonicalProjectRoot(f.root)), undefined);
});

test('closing a panel during observable work lets the task finish as known and removes a clean journal', async t => {
  const project = await makeProject(t);
  let closed = false; let finish;
  let arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  const platform = { getSetting: (_key, fallback) => fallback, isWorkspaceTrusted: () => true,
    showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {},
    runProcess: async () => {
      await writeFile(project.lockfilePath, lockfile(false));
      return { onDidExit(listener) { finish = listener; arrived(); return { dispose() {} }; } };
    },
  };
  const fixture = makeCoordinator(project, { platform, isDisposed: () => closed, mutationRoot: () => project.root });
  fixture.coordinator.session.invocationResolver = invocation;
  await fixture.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const analysisId = fixture.messages.findLast(message => message.status === 'remove-analysis').analysis.analysisId;
  const confirming = fixture.coordinator.handleConfirmRemove({ analysisId });
  await started;
  const handle = fixture.coordinator.reservation.held;
  closed = true; fixture.coordinator.disposeWhenIdle();
  finish(0); await confirming;
  assert.equal(handle.state, 'completed');
  assert.equal(handle.result, 'kept');
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('a late successful task event cannot settle an already unknown result', async t => {
  const f = await recoveryFixture(t); const owner = owned(f.target); await owner.handle.beginMutation(f.target);
  let exit;
  const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true,
    runProcess: async () => ({ onDidExit(listener) { exit = listener; setImmediate(() => listener(undefined)); return { dispose() {} }; } }),
  }, invocation);
  const outcome = await session.prepareManifestReconciliation(params).execute();
  assert.equal(outcome.status, 'unknown'); owner.handle.markUnknown('lost');
  exit(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(outcome.status, 'unknown'); assert.equal(owner.handle.state, 'unknown');
  assert.equal(await owner.handle.complete('kept'), false);
  await assert.rejects(f.prepare());
});

test('a transient journal failure after staging cannot become a clean not-started release', async t => {
  const f = await recoveryFixture(t);
  const fs = await import('node:fs/promises');
  let failed = false;
  const journal = await f.prepare({ fs: { ...fs, rename: async (from, to) => {
    if (!failed && to.endsWith('journal.json')) {
      const value = JSON.parse(await fs.readFile(from, 'utf8'));
      if (value.phase === 'finished' && value.step.startsWith('write:')) { failed = true; throw Object.assign(new Error('transient disk error'), { code: 'EIO' }); }
    }
    return fs.rename(from, to);
  } } });
  const owner = owned(f.target);
  // Bind the prepared journal exactly as beginMutation does, with a one-shot
  // filesystem fault that the production bootstrap deliberately cannot inject.
  owner.handle.journal = journal;
  const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(), journal,
    manifestStage: { path: f.manifest, expectedContents: await readFile(f.manifest), contents: Buffer.from('staged') },
    install: { execute: async () => { assert.fail('publication failure must stop before dispatch'); } },
  });
  assert.equal(result.completion, 'unknown');
  assert.equal(await owner.handle.complete(result.completion), false);
  assert.equal(owner.handle.state, 'unknown');
  assert.equal(owner.locks.holderOf(canonicalProjectRoot(f.root)), owner.handle);
  const inspected = await f.inspect();
  assert.equal(inspected.journal.data.phase, 'intent');
  assert.match(inspected.journal.data.step, /^write:/);
  assert.equal(await f.read('package.json'), 'staged');
  await assert.rejects(journal.record('completion', 'finished'));
  await assert.rejects(f.prepare());
});


test('partial recovery preserves its incomplete message and reports the filesystem error separately', async t => {
  const f = await recoveryFixture(t); await f.prepare();
  await writeFile(f.manifest, 'changed manifest'); await writeFile(f.lockfile, 'changed lockfile');
  const fs = await import('node:fs/promises');
  const session = await f.open({ fs: { ...fs, rename: async (from, to) => {
    if (from === f.lockfile) throw Object.assign(new Error('lockfile sharing violation'), { code: 'EPERM' });
    return fs.rename(from, to);
  } } });
  const warnings = []; const messages = [];
  const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage: message => warnings.push(message) }, locks: new ProjectMutationLocks(),
    target: async () => f.target, post: message => messages.push(message), removed: async () => {} });
  coordinator.session = session;
  await coordinator.apply(choices(await session.presentation(), 'restore', true));
  assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
  assert.equal(await f.read('package-lock.json'), 'changed lockfile');
  assert.equal(messages.at(-1).recovery.state, 'incomplete');
  assert.equal(messages.at(-1).recovery.message, `Recovery is incomplete. Saved and displaced files are kept. ${manualReinstallNote('npm')}`);
  assert.deepEqual(warnings, ['lockfile sharing violation']);
});
