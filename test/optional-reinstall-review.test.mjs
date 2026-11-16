import { withoutFsync } from './helpers/without-fsync.mjs';
withoutFsync();
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { makeCoordinator, makeProject, review } from './helpers/removal-project.mjs';
import { choices } from './helpers/recovery.mjs';

const failure = fault => fault === 'TypeError' ? new TypeError('reinstall bug') : Object.assign(new Error('reinstall EIO'), { code: 'EIO' });

for (const fault of ['EIO', 'TypeError']) test(`recovery final reinstall journal read ${fault} fences and requires fresh confirmation`, async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  const session = f.coordinator.recovery.session;
  const journal = session.inspection.journal;
  f.state.reinstallChoice = 'Reinstall';
  let injected = false;
  const restored = f.coordinator.recovery.options.restored;
  f.coordinator.recovery.options.restored = async (...args) => {
    const result = await restored(...args);
    assert.equal(result, 'succeeded');
    const read = journal.files.read.bind(journal.files);
    journal.files.read = async candidate => {
      if (!injected) { injected = true; throw failure(fault); }
      return read(candidate);
    };
    return result;
  };
  await f.coordinator.recovery.apply(choices(await session.presentation(), 'restore'));
  assert.equal(injected, true);
  assert.equal(journal.data.outcome, 'unknown');
  assert.throws(() => journal.assertWritable());
  assert.equal(f.coordinator.recovery.session, undefined);
  const folder = path.join(project.root, '.packageawy-recovery');
  assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'journal.json'), 'utf8')).outcome, 'unknown');
  await f.coordinator.recovery.dismiss(true, true);
  assert.ok(await fs.stat(path.join(folder, 'journal.json')));
  assert.ok(f.coordinator.recovery.lock);
  await assert.rejects(session.dismiss(true, true));
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, null);
  assert.equal(f.coordinator.recovery.session, undefined, 'stale confirmation cannot reopen recovery');
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  assert.ok(f.coordinator.recovery.session);
});

// Builtin mocks are scoped to one test and one target. Tests in this file run serially.
import nativeFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { recoveryFixture } from './helpers/recovery.mjs';
import { RecoveryCoordinator } from '../out/host/recovery/coordinator.js';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';
import { offerFrozenReconciliation } from '../out/host/frozenReconciliation.js';

function inject(t, step, fault, journal, platform, runner) {
  let injected = false;
  let prompted = false;
  const fail = () => { injected = true; throw failure(fault); };
  const prompt = platform.showModalWarning.bind(platform);
  platform.showModalWarning = async (...args) => {
    if (step === 'offer') fail();
    const result = await prompt(...args);
    prompted = true;
    return result;
  };
  const read = journal.files.read.bind(journal.files);
  journal.files.read = async candidate => {
    if (!injected && ((step === 'offer-read' && !prompted) || (step === 'precheck' && prompted))) fail();
    return read(candidate);
  };
  if (step === 'initial-target' || step === 'target-revalidation') {
    const readFile = nativeFs.readFile;
    const ancestor = path.join(path.dirname(journal.storage.target.root), 'package.json');
    nativeFs.readFile = async (...args) => {
      if (!injected && args[0] === ancestor && (step === 'initial-target' || prompted)) fail();
      return readFile(...args);
    };
    syncBuiltinESMExports();
    t.after(() => { nativeFs.readFile = readFile; syncBuiltinESMExports(); });
  }
  const prepare = runner.prepareLockfileReconciliation.bind(runner);
  runner.prepareLockfileReconciliation = (...args) => {
    if (step === 'prepare') fail();
    return prepare(...args);
  };
  const runProcess = platform.runProcess.bind(platform);
  platform.runProcess = (...args) => {
    if (step === 'task') fail();
    return runProcess(...args);
  };
  const record = journal.record.bind(journal);
  journal.record = (...args) => {
    if (!injected && ((step === 'task-intent' && args[1] === 'intent') ||
      (step === 'result-recording' && args[1] === 'finished') ||
      (step === 'journal-update' && ['completion', 'recovery-completion'].includes(args[0])))) fail();
    return record(...args);
  };
  return () => assert.equal(injected, true, `injected ${step} ${fault}`);
}

for (const operation of ['recovery', 'cleanup-recovery', 'upgrade', 'removal', 'cleanup', 'transitive']) {
  for (const step of ['offer-read', 'initial-target', 'offer', 'target-revalidation', 'precheck', 'prepare', 'task-intent', 'task', 'result-recording', 'journal-update']) {
    for (const fault of ['EIO', 'TypeError']) test(`${operation} optional reinstall ${step} ${fault} fences unknown and retains data`, async t => {
      let journal, reached, locks, root, coordinator, messages;
      if (operation.endsWith('recovery')) {
        const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}', operation: operation === 'recovery' ? 'upgrade' : 'cleanup' });
        await f.prepare();
        root = f.root;
        locks = new ProjectMutationLocks();
        messages = [];
        const platform = { isWorkspaceTrusted: () => true, showWarningMessage() {},
          async showModalWarning() { return 'Reinstall'; },
          async runProcess() { return { onDidExit(listener) { setImmediate(() => listener(0)); return { dispose() {} }; } }; },
        };
        const runner = new UpgradeExecutionSession(platform, () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' }));
        coordinator = new RecoveryCoordinator({ platform, locks, target: async () => f.target,
          post: message => messages.push(message), removed: async () => {},
          restored: async active => { reached = inject(t, step, fault, active, platform, runner); return offerFrozenReconciliation(active, platform, runner); },
        });
        await coordinator.start(true, null);
        journal = coordinator.session.inspection.journal;
        await coordinator.apply(choices(await coordinator.session.presentation(), 'restore'));
        assert.equal(coordinator.session, undefined);
      } else {
        const f = await rollbackFixture(t, operation);
        root = f.project.root;
        messages = f.messages;
        const reconcile = f.coordinator.reconcileRollback.bind(f.coordinator);
        f.coordinator.reconcileRollback = async (handle, completion) => {
          assert.equal(completion, 'rolled-back');
          journal = handle.journal;
          reached = inject(t, step, fault, journal, f.coordinator.options.platform, f.coordinator.session);
          return reconcile(handle, completion);
        };
        await f.confirm();
        assert.equal(f.coordinator.reservation.held.state, 'unknown', JSON.stringify(messages));
        locks = f.coordinator.mutationLocks;
        coordinator = f.coordinator.recovery;
      }
      reached();
      assert.equal(journal.data.outcome, 'unknown');
      assert.throws(() => journal.assertWritable());
      const folder = path.join(root, '.packageawy-recovery');
      assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'journal.json'), 'utf8')).outcome, 'unknown');
      assert.ok(locks.holderOf(canonicalProjectRoot(root)));
      await coordinator.dismiss(true, true);
      assert.ok(await fs.stat(path.join(folder, 'journal.json')));
      assert.ok(locks.holderOf(canonicalProjectRoot(root)));
    });
  }
}

for (const fault of ['EIO', 'TypeError']) test(`dismissal ${fault} invalidates recovery after successful optional reinstall`, async t => {
  const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}' });
  await f.prepare();
  const locks = new ProjectMutationLocks();
  const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks,
    target: async () => f.target, post() {}, removed: async () => {}, restored: async () => 'succeeded' });
  await coordinator.start(true, null);
  const session = coordinator.session;
  await coordinator.apply(choices(await session.presentation(), 'restore'));
  const journal = session.inspection.journal;
  const list = journal.storage.list.bind(journal.storage);
  let injected = false;
  journal.storage.list = (...args) => {
    if (!injected) { injected = true; throw failure(fault); }
    return list(...args);
  };
  await coordinator.dismiss(true, false);
  assert.equal(injected, true);
  assert.equal(coordinator.session, undefined);
  assert.equal(journal.data.outcome, 'unknown');
  assert.throws(() => journal.assertWritable());
  assert.ok(locks.holderOf(canonicalProjectRoot(f.root)));
  await coordinator.dismiss(true, true);
  await assert.rejects(session.dismiss(true, true));
  assert.ok(await fs.stat(path.join(f.folder, 'backups')));
});

for (const step of ['ownership', 'journal-publication']) for (const fault of ['EIO', 'TypeError']) test(`final recovery reinstall ${step} ${fault} invalidates even after observed success`, async t => {
  const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}' });
  await f.prepare();
  const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks: new ProjectMutationLocks(),
    target: async () => f.target, post() {}, removed: async () => {}, restored: async journal => {
      const target = step === 'ownership' ? journal : journal.storage;
      const method = step === 'ownership' ? 'assertOwner' : 'writeJson';
      const original = target[method].bind(target);
      let injected = false;
      target[method] = (...args) => {
        if (!injected) { injected = true; throw failure(fault); }
        return original(...args);
      };
      return 'succeeded';
    } });
  await coordinator.start(true, null);
  const session = coordinator.session;
  const journal = session.inspection.journal;
  await coordinator.apply(choices(await session.presentation(), 'restore'));
  assert.equal(journal.data.outcome, 'unknown');
  assert.throws(() => journal.assertWritable());
  assert.equal(coordinator.session, undefined);
  await coordinator.dismiss(true, true);
  await assert.rejects(session.dismiss(true, true));
  assert.ok(coordinator.lock);
  assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
});

test('ownership lost after reinstall success still fences when publishing unknown is impossible', async t => {
  const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}' });
  await f.prepare();
  const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks: new ProjectMutationLocks(),
    target: async () => f.target, post() {}, removed: async () => {}, restored: async () => {
      await fs.writeFile(path.join(f.folder, 'owner.json'), '{}');
      return 'succeeded';
    } });
  await coordinator.start(true, null);
  const session = coordinator.session;
  const journal = session.inspection.journal;
  await coordinator.apply(choices(await session.presentation(), 'restore'));
  assert.equal(journal.data.outcome, 'unknown');
  assert.throws(() => journal.assertWritable());
  assert.equal(coordinator.session, undefined);
  await coordinator.dismiss(true, true);
  await assert.rejects(session.dismiss(true, true));
  assert.ok(coordinator.lock);
  assert.ok(await fs.stat(path.join(f.folder, 'backups')));
});
