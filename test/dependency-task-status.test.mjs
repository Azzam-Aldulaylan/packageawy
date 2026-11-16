import test from 'node:test';
import assert from 'node:assert/strict';
import { UpgradeExecutionSession, STILL_RUNNING_THRESHOLD_MS } from '../out/host/upgradeRunner.js';
import { makeProject, makeCoordinator, review } from './helpers/removal-project.mjs';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';

const invocation = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

for (const result of [0, 1, undefined, 'dispose', 'reject']) {
  test(`Still running is status only and clears on ${String(result)}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const states = [];
    let exit; let reject;
    const started = new Promise((resolve, fail) => {
      reject = fail;
      if (result !== 'reject') resolve({ onDidExit(listener) { exit = listener; return { dispose() {} }; } });
    });
    const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true, runProcess: () => started }, invocation, state => states.push(state));
    let finished = false;
    const pending = (await session.prepareManifestReconciliation({ cwd: '/workspace', ignoreScripts: true, packageManager: 'npm' })).execute().then(value => { finished = true; return value; });
    await flush();
    t.mock.timers.tick(STILL_RUNNING_THRESHOLD_MS - 1);
    assert.deepEqual(states, ['running']);
    t.mock.timers.tick(1);
    assert.deepEqual(states, ['running', 'still-running']);
    t.mock.timers.tick(120_000);
    assert.equal(finished, false, 'the status timer cannot complete or roll back a writer');
    if (result === 'dispose') session.dispose();
    else if (result === 'reject') reject(new Error('ambiguous launch failure'));
    else exit(result);
    const outcome = await pending;
    assert.deepEqual(states, ['running', 'still-running', 'idle']);
    assert.equal(outcome.ok, result === 0);
    if (result !== 0 && result !== 1) assert.equal(outcome.status, 'unknown');
    t.mock.timers.tick(STILL_RUNNING_THRESHOLD_MS * 2);
    assert.equal(states.at(-1), 'idle');
  });
}

test('fast completion cancels Still running before its threshold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = [];
  const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true, runProcess: async () => ({
    onDidExit(listener) { listener(0); return { dispose() {} }; },
  }) }, invocation, state => states.push(state));
  await (await session.prepareManifestReconciliation({ cwd: '/workspace', ignoreScripts: true, packageManager: 'npm' })).execute();
  t.mock.timers.tick(STILL_RUNNING_THRESHOLD_MS);
  assert.deepEqual(states, ['running', 'idle']);
});

test('coordinator forwards the task state through the validated webview protocol', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationLocks: new ProjectMutationLocks() });
  f.coordinator.session.invocationResolver = invocation;
  const id = await review(f);
  await f.coordinator.handleConfirmRemove({ analysisId: id });
  assert.deepEqual(f.messages.filter(m => m.status === 'dependency-task').map(m => m.state), ['running', 'idle']);
});

test('a reopened panel observes Still running from its detached coordinator and clears on completion', async t => {
  const project = await makeProject(t); const locks = new ProjectMutationLocks();
  let exit; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const platform = { getSetting: (_key, fallback) => fallback, isWorkspaceTrusted: () => true,
    showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {},
    runProcess: async () => ({ onDidExit(listener) { exit = listener; started(); return { dispose() {} }; } }),
  };
  let closed = false;
  const first = makeCoordinator(project, { platform, mutationLocks: locks, mutationRoot: () => closed ? undefined : project.root, isDisposed: () => closed });
  first.coordinator.session.invocationResolver = invocation;
  const id = await review(first);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = first.coordinator.handleConfirmRemove({ analysisId: id });
  await ready;
  closed = true;
  const reopened = makeCoordinator(project, { mutationLocks: locks, mutationRoot: () => project.root });
  await reopened.coordinator.recovery.inspect();
  assert.equal(reopened.messages.findLast(m => m.status === 'dependency-task').state, 'running');
  // Advance the original timer only. A newly opened panel does not restart the wait.
  t.mock.timers.tick(STILL_RUNNING_THRESHOLD_MS);
  assert.equal(reopened.messages.findLast(m => m.status === 'dependency-task').state, 'still-running');
  exit(0); await pending;
  assert.equal(reopened.messages.findLast(m => m.status === 'dependency-task').state, 'idle');
  await reopened.coordinator.recovery.inspect();
  assert.equal(reopened.messages.findLast(m => m.status === 'recovery').recovery.state, 'completed');
});

test('a task-status presentation error cannot prevent a writer from finishing', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationLocks: new ProjectMutationLocks() });
  f.coordinator.session.invocationResolver = invocation;
  const post = f.coordinator.options.sink.postMessage;
  f.coordinator.options.sink.postMessage = message => {
    if (message.status === 'dependency-task') throw new Error('view closed during task');
    post(message);
  };
  const id = await review(f);
  await f.coordinator.handleConfirmRemove({ analysisId: id });
  assert.deepEqual(f.commands, ['install']);
  assert.ok(f.messages.find(message => message.status === 'remove-result'));
  assert.ok(f.logs.find(line => line === 'runtime: webview-message failed (Error)'));
});
