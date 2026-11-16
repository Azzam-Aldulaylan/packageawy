import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { recoveryFixture } from './helpers/recovery.mjs';
import { blocker } from './helpers/removal-project.mjs';
import { OperationReservation, settleProcessFailure } from '../out/host/operationReservation.js';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { Storage } from '../out/host/recovery/storage.js';
import { RecoveryLock } from '../out/host/recoveryLock.js';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';
import { RecoveryError } from '../out/host/recovery/model.js';
import { RecoveryCoordinator } from '../out/host/recovery/coordinator.js';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';

const execFileAsync = promisify(execFile);

for (const deletion of ['journal.json', 'backup']) test(`failure during cleanup path resolution preserves ${deletion}`, async t => {
  const f = await recoveryFixture(t);
  const hold = blocker();
  t.after(hold.release);
  let armed = false;
  const journal = await f.prepare({ boundary: async name => {
    if (name === (deletion === 'backup' ? 'removal:1' : 'removal:6')) armed = true;
  } });
  const locks = new ProjectMutationLocks();
  const reservation = new OperationReservation({ locks, reserve: () => true, release() {},
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  const handle = reservation.reserve('change', f.root);
  handle.journal = journal;
  handle.state = 'mutating';
  const at = journal.storage.at.bind(journal.storage);
  let paused = false;
  journal.storage.at = async relative => {
    const resolved = await at(relative);
    if (armed && !paused && (deletion === 'backup' ? relative.startsWith('backups/') : relative === deletion)) {
      paused = true;
      await hold.wait();
    }
    return resolved;
  };
  const completing = handle.complete('kept');
  await hold.arrived;
  await handle.fail('failure while cleanup resolves its deletion path');
  const backups = deletion === 'backup' ? await readdir(`${f.folder}/backups`) : [];
  assert.equal(JSON.parse(await readFile(`${f.folder}/journal.json`, 'utf8')).outcome, 'unknown');
  hold.release();
  assert.equal(await completing, false);
  assert.equal(handle.state, 'unknown');
  assert.equal(JSON.parse(await readFile(`${f.folder}/journal.json`, 'utf8')).outcome, 'unknown');
  if (deletion === 'backup') assert.deepEqual(await readdir(`${f.folder}/backups`), backups);
  assert.equal(locks.holderOf(handle.lockKey), handle);
});

for (const context of ['unhandled-rejection', 'uncaught-exception']) test(`${context} invalidates preparation at the durable prepared boundary`, async () => {
  try {
    await execFileAsync(process.execPath, ['--test-reporter=tap', 'test/helpers/sidecar-failure-probe.mjs', context, 'preparing'],
      { env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  } catch (error) {
    assert.fail(error.stdout || error.stderr || error.message);
  }
});

test('settlement invalidates a pending preparation before any persistence or delivery', async t => {
  const f = await recoveryFixture(t);
  const hold = blocker();
  t.after(hold.release);
  const boundary = Storage.prototype.boundary;
  Storage.prototype.boundary = async function (name) {
    await boundary.call(this, name);
    if (name === 'prepared') await hold.wait();
  };
  t.after(() => { Storage.prototype.boundary = boundary; });
  const locks = new ProjectMutationLocks();
  const reservation = new OperationReservation({ locks, reserve: () => true, release() {},
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  const handle = reservation.reserve('change', f.root);
  const preparing = handle.beginMutation(f.target);
  await hold.arrived;
  const settling = settleProcessFailure(locks, 'pending failure');
  assert.equal(handle.state, 'unknown');
  assert.equal(handle.transferToRecovery('too-early'), undefined, 'pending preparations cannot transfer mutation authority');
  hold.release();
  assert.equal(await preparing, false, 'handle invalidation works independently of admission closure');
  assert.equal(await settling, true);
  assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
});

test('a fenced publication cannot overwrite the unknown journal after resolving its destination', async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  const hold = blocker();
  t.after(hold.release);
  const at = journal.storage.at.bind(journal.storage);
  let armed = false;
  let paused = false;
  journal.storage.hooks.boundary = async name => { if (name === 'synced:journal.json') armed = true; };
  journal.storage.at = async relative => {
    const resolved = await at(relative);
    if (armed && !paused && relative === 'journal.json') { paused = true; await hold.wait(); }
    return resolved;
  };
  const writing = assert.rejects(journal.record('late-result', 'intent'));
  await hold.arrived;
  await journal.unknown('failure during publication');
  hold.release();
  await writing;
  assert.equal(journal.storage.publicationFailed, false, 'a local refusal is not uncertain I/O');
  assert.equal(JSON.parse(await readFile(`${f.folder}/journal.json`, 'utf8')).outcome, 'unknown');
});

for (const method of ['rmdir', 'removeFolder']) test(`fencing during path resolution stops ${method}`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  const storage = journal.storage;
  const hold = blocker();
  t.after(hold.release);
  const safeAbsolute = storage.safeAbsolute.bind(storage);
  storage.safeAbsolute = async candidate => {
    const resolved = await safeAbsolute(candidate);
    await hold.wait();
    return resolved;
  };
  const deleting = storage[method]('displaced');
  const rejected = assert.rejects(deleting, RecoveryError);
  await hold.arrived;
  journal.fence();
  hold.release();
  await rejected;
  assert.deepEqual(await readdir(`${f.folder}/displaced`), []);
});

test('a prepared process dispatch rechecks its journal after task-state delivery', async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  let starts = 0;
  const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true,
    runProcess: async () => { starts++; return { onDidExit(done) { queueMicrotask(() => done(0)); return { dispose() {} }; } }; },
  }, () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' }));
  session.journal = journal;
  session.observeTaskState(state => { if (state === 'running') journal.fence(); });
  const prepared = await session.prepareManifestReconciliation({ cwd: f.root, ignoreScripts: true, packageManager: 'npm' });
  assert.equal((await prepared.execute()).status, 'unknown');
  assert.equal(starts, 0);
});

test('a recovery lock cannot grant a new claimant authority after process failure', () => {
  const locks = new ProjectMutationLocks();
  const lock = new RecoveryLock(locks, '/project', 'old');
  const key = locks.tryAcquire('/project', lock);
  locks.closeAfterFailure();
  assert.equal(lock.transferToRecovery('new'), undefined);
  assert.equal(locks.transfer(key, lock, {}), false);
});

test('recovery queued before failure cannot obtain mutation authority after target resolution', async t => {
  const f = await recoveryFixture(t);
  const locks = new ProjectMutationLocks();
  const hold = blocker();
  t.after(hold.release);
  let applies = 0;
  const recovery = new RecoveryCoordinator({ locks, platform: { showWarningMessage() {} },
    target: async () => { await hold.wait(); return f.target; }, post() {}, removed: async () => {} });
  recovery.session = { apply: async () => { applies++; }, presentation: async () => ({ state: 'open' }) };
  const applying = recovery.apply([]);
  await hold.arrived;
  locks.closeAfterFailure();
  hold.release();
  await applying;
  assert.equal(applies, 0);
});

test('process failure invalidates an open recovery session at its filesystem boundary', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  const locks = new ProjectMutationLocks();
  const recovery = new RecoveryCoordinator({ locks, platform: { showWarningMessage() {} },
    target: async () => f.target, post() {}, removed: async () => {} });
  await recovery.start(true, null);
  const journal = recovery.session.inspection.journal;
  const hold = blocker();
  t.after(hold.release);
  const safeAbsolute = journal.storage.safeAbsolute.bind(journal.storage);
  let paused = false;
  journal.storage.safeAbsolute = async candidate => {
    const resolved = await safeAbsolute(candidate);
    if (!paused && candidate.endsWith('.bin')) { paused = true; await hold.wait(); }
    return resolved;
  };
  const before = await journal.files.read(f.manifest);
  const replacing = assert.rejects(journal.replace(journal.data.files[0], before, { exists: false }), RecoveryError);
  await hold.arrived;
  locks.closeAfterFailure();
  hold.release();
  await replacing;
  assert.deepEqual(await journal.files.read(f.manifest), before);
});

for (const phase of ['install', 'verification']) test(`transaction fences ${phase} dispatch after recording intent`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  journal.storage.hooks.boundary = async name => {
    if (name === `journal:${phase}:intent`) journal.fence();
  };
  let installs = 0;
  let verifies = 0;
  const result = await runUpgradeTransaction({ journal, files: journal.adapter(), allowlistedPaths: f.target.allowlistedPaths,
    install: { execute: async () => { installs++; return { status: 'succeeded' }; } },
    verifier: { verify: async () => { verifies++; return { status: 'passed', checks: [] }; } },
  });
  assert.equal(result.completion, 'unknown');
  assert.equal(installs, phase === 'install' ? 0 : 1);
  assert.equal(verifies, 0);
});
