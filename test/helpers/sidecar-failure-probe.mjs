import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { makeCoordinator, makeProject, review, blocker } from './removal-project.mjs';
import { canonicalProjectRoot, projectMutationLocks } from '../../out/host/projectMutationLock.js';
import { createUnhandledRejectionHandler } from '../../out/sidecar/unhandledRejection.js';
import { DashboardPanel } from '../../out/host/dashboardPanel.js';
import { RECOVERY_MESSAGES } from '../../out/host/recoveryCopy.js';
import { recoveryFixture } from './recovery.mjs';
import { OperationReservation } from '../../out/host/operationReservation.js';
import { Storage } from '../../out/host/recovery/storage.js';

const [context, scenario] = process.argv.slice(2);
const invocation = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });

if (scenario === 'preparing') test('failure while journal preparation is in flight', async t => {
  const f = await recoveryFixture(t);
  const hold = blocker();
  t.after(hold.release);
  const boundary = Storage.prototype.boundary;
  Storage.prototype.boundary = async function (name) {
    await boundary.call(this, name);
    if (name === 'prepared') await hold.wait();
  };
  t.after(() => { Storage.prototype.boundary = boundary; });
  const reservation = new OperationReservation({ locks: projectMutationLocks, reserve: () => true, release() {},
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  const handle = reservation.reserve('change', f.root);
  const preparing = handle.beginMutation(f.target);
  await hold.arrived;
  assert.equal(handle.journal, undefined);
  const before = await readFile(f.manifest);
  createUnhandledRejectionHandler({ log() {}, reportToPanel: () => false, notify() {} }, context)(new TypeError('preparation failure'));
  const synchronousState = handle.state;
  assert.equal(projectMutationLocks.admissionClosed, true);
  hold.release();
  const granted = await preparing;
  // Exercise the reviewer's successful manifest write if authority leaks.
  if (granted) {
    await handle.journal.adapter().compareAndSwap(f.manifest,
      { exists: true, contents: before }, { exists: true, contents: Buffer.from('late mutation') });
  }
  assert.deepEqual(await readFile(f.manifest), before, 'a process-invalidated preparation cannot write the manifest');
  assert.equal(granted, false, 'a preparation invalidated by process failure cannot grant mutation authority');
  assert.equal(synchronousState, 'unknown', 'pending preparation is invalidated before the handler yields');
  assert.equal(handle.state, 'unknown');
  assert.equal(handle.result, 'unknown');
  assert.equal(await handle.beginMutation(f.target), false);
  assert.equal(handle.transferToRecovery('late-claim'), undefined);
  await assert.rejects(handle.journal.adapter().compareAndSwap(f.manifest,
    { exists: true, contents: before }, { exists: true, contents: Buffer.from('late mutation') }));
  assert.deepEqual(await readFile(f.manifest), before);
  assert.equal(JSON.parse(await readFile(`${f.folder}/journal.json`, 'utf8')).outcome, 'unknown');
  for (const file of handle.journal.data.files) {
    assert.equal((await readFile(`${f.folder}/backups/${file.backup.id}.bin`)).length > 0, true);
  }
  assert.equal(await handle.complete('kept'), false);
  assert.equal(await handle.releaseReadOnly(), false);
  assert.equal(projectMutationLocks.holderOf(canonicalProjectRoot(f.root)), handle);
});

if (scenario === 'detached') test('detached writer', async t => {
  const project = await makeProject(t);
  let closed = false;
  const hold = blocker();
  t.after(() => hold.release());
  const fixture = makeCoordinator(project, { mutationLocks: projectMutationLocks, mutationRoot: () => project.root, isDisposed: () => closed });
  const id = await review(fixture);
  fixture.coordinator.session.invocationResolver = invocation;
  fixture.state.holdInstall = hold.wait;
  const confirming = fixture.coordinator.handleConfirmRemove({ analysisId: id });
  await hold.arrived;
  const handle = fixture.coordinator.reservation.held;
  closed = true;
  fixture.coordinator.disposeWhenIdle();
  const notifications = []; const logs = [];
  let notified;
  const notification = new Promise(resolve => { notified = resolve; });
  const handler = createUnhandledRejectionHandler({ log: line => logs.push(line), reportToPanel: () => false, notify: message => { notifications.push(message); notified(); } }, context);
  handler(new TypeError('internal bug'));
  assert.equal(handle.state, 'unknown', 'the process handler fences before yielding');
  await notification;
  assert.deepEqual(notifications, [RECOVERY_MESSAGES.restartRequired]);
  assert.deepEqual(logs, [`runtime: ${context} failed (TypeError)`]);
  hold.release();
  await confirming;
  assert.equal(handle.state, 'unknown');
  assert.equal(JSON.parse(await readFile(`${project.root}/.packageawy-recovery/journal.json`, 'utf8')).outcome, 'unknown');
  assert.equal(projectMutationLocks.holderOf(canonicalProjectRoot(project.root)), handle);
  assert.equal(fixture.coordinator.isMutationBusy(), true);
  assert.equal(fixture.messages.some(message => message.status === 'remove-result'), false);
  assert.equal(await handle.complete('kept'), false);
  assert.equal(await handle.releaseReadOnly(), false);
  assert.deepEqual(fixture.commands, ['install'], 'no verification or rollback follows a late result');

});

function panel() {
  globalThis.__BUILD_TIME__ = 'test';
  const messages = [];
  let close;
  const store = { get() {}, async update() {} };
  const instance = new DashboardPanel({ workspaceFolders: () => [], getSetting: (_key, fallback) => fallback,
    globalState: store, workspaceState: store, log() {},
    onDidChangeSetting: () => ({ dispose() {} }), watchGitHead: async () => undefined,
  }, { postMessage: message => messages.push(message), onDidReceiveMessage() {},
    onDidDispose: listener => { close = listener; }, reveal() {},
  }, { extensionVersion: 'test', integrationTestMode: false });
  instance.deliveryReady = true;
  return { instance, messages, close };
}

if (scenario.startsWith('admission')) test('fatal error closes admission across panels and restart cancellation', async t => {
  const notifications = [];
  const initial = scenario === 'admission-open' ? panel() : undefined;
  if (initial) { DashboardPanel.current = initial.instance; t.after(initial.close); }
  t.after(() => { DashboardPanel.current = undefined; });
  createUnhandledRejectionHandler({ log() {}, reportToPanel: reason => DashboardPanel.reportRuntimeFailure(context, reason),
    notify: message => notifications.push(message),
  }, context)(new TypeError('process failure'));
  assert.equal(projectMutationLocks.admissionClosed, true, 'admission closes synchronously without a panel');
  assert.equal(projectMutationLocks.tryAcquire('/new-project', {}), null);
  assert.equal(projectMutationLocks.trackPending(), undefined);
  projectMutationLocks.prepareRestart('restart');
  projectMutationLocks.cancelRestart('restart');
  assert.equal(projectMutationLocks.admissionClosed, true, 'restart cancellation cannot reopen a failed process');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /restart/i);
  if (initial) {
    await initial.instance.handle({ type: 'confirm-remove', analysisId: 'review' });
    assert.match(initial.messages.find(message => message.status === 'remove-error').error.message, /restart/i);
    initial.close();
    DashboardPanel.current = undefined;
  }
  for (let lifetime = 0; lifetime < 2; lifetime++) {
    const f = panel();
    t.after(f.close);
    assert.equal(f.instance.upgradeCoordinator.reservation.reserve('new change', `/project-${lifetime}`).ok, false);
    await f.instance.handle({ type: 'confirm-remove', analysisId: 'review' });
    const refusal = f.messages.find(message => message.status === 'remove-error');
    assert.ok(refusal, 'a fresh panel refuses confirmation');
    assert.match(refusal.error.message, /restart/i);
    let scans = 0;
    f.instance.selectedProject = { id: 'project' };
    f.instance.reloadAndScan = async () => { scans++; };
    await f.instance.handle({ type: 'refresh' });
    assert.equal(scans, 1, 'read-only Refresh still runs');
    f.close();
  }
});
