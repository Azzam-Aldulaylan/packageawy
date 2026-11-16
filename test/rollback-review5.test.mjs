import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';

withoutFsync();

for (const operation of ['removal', 'cleanup', 'upgrade', 'transitive']) {
  for (const fault of ['TypeError', 'ENOENT']) test(`${operation} restoreGuard reload ${fault} uses the correct settlement`, async t => {
    const f = await rollbackFixture(t, operation);
    f.state.reinstallChoice = 'Skip';
    let injected = false;
    f.state.holdRead = async () => {
      const journal = f.coordinator.reservation.held?.journal;
      if (!injected && journal?.data.step === 'rollback') {
        injected = true;
        throw fault === 'TypeError' ? new TypeError('reload bug') : Object.assign(new Error('manifest absent'), { code: 'ENOENT' });
      }
    };
    await f.confirm();
    assert.equal(injected, true);
    const handle = f.coordinator.reservation.held;
    if (fault === 'TypeError') {
      assert.equal(handle.state, 'unknown');
      assert.equal(handle.journal.data.outcome, 'unknown');
      assert.throws(() => handle.journal.assertWritable());
      assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error.code), ['OUTCOME_UNKNOWN']);
      assert.equal(f.messages.some(message => message.status.endsWith('-result')), false);
    } else {
      assert.equal(handle.state, 'retained');
      assert.equal(handle.journal.data.outcome, 'rolled-back');
      assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
    }
  });
}

for (const operation of ['removal', 'cleanup', 'upgrade', 'transitive', 'recovery', 'cleanup-recovery']) {
  for (const phase of ['displacement', 'replacement']) test(`${operation} ${phase} rename TypeError fences unknown`, async t => {
    let journal, injected = false, run, root;
    const inject = active => {
      journal = active;
      const original = journal.storage.fs;
      journal.storage.fs = { ...original, async rename(source, destination) {
        const restoring = journal.data.step === 'rollback' || operation.endsWith('recovery');
        const dependencyFile = path.join(root, operation === 'transitive' ? 'package-lock.json' : 'package.json');
        const isRestore = phase === 'displacement' ? source === dependencyFile
          : source.includes('restore.tmp-') && destination === dependencyFile;
        if (!injected && restoring && isRestore) { injected = true; throw new TypeError(`${phase} bug`); }
        return original.rename(source, destination);
      } };
    };
    let holder;
    if (operation.endsWith('recovery')) {
      const f = await recoveryFixture(t, { operation: operation.startsWith('cleanup') ? 'cleanup' : 'upgrade' });
      root = f.root;
      await f.prepare();
      await fs.writeFile(f.manifest, 'installed manifest');
      const session = await f.open();
      const selected = choices(await session.presentation(), 'restore');
      inject(session.inspection.journal);
      run = () => assert.rejects(session.apply(selected), error => error.code === 'OUTCOME_UNKNOWN');
      holder = () => assert.equal(session.outcomeUnknown, true);
    } else {
      const f = await rollbackFixture(t, operation);
      root = f.project.root;
      const reserve = f.coordinator.reserve.bind(f.coordinator);
      f.coordinator.reserve = label => {
        const handle = reserve(label);
        const begin = handle.beginMutation.bind(handle);
        handle.beginMutation = async target => { const ok = await begin(target); inject(handle.journal); return ok; };
        return handle;
      };
      run = f.confirm;
      holder = () => {
        assert.equal(f.coordinator.reservation.held.state, 'unknown');
        assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error.code), ['OUTCOME_UNKNOWN']);
      };
    }
    await run();
    assert.equal(injected, true);
    holder();
    assert.equal(journal.data.outcome, 'unknown');
    assert.throws(() => journal.assertWritable());
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.packageawy-recovery/journal.json'), 'utf8')).outcome, 'unknown');
  });
}

test('temporary descriptor close TypeError reaches unknown settlement', async t => {
  const f = await rollbackFixture(t, 'removal');
  const native = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const io = native.default;
  const open = io.open;
  let injected = false;
  io.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).includes('.packageawy-') && String(file).endsWith('.tmp')) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (!injected) { injected = true; throw new TypeError('close bug'); }
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { io.open = open; syncBuiltinESMExports(); });
  await f.confirm();
  assert.equal(injected, true);
  const handle = f.coordinator.reservation.held;
  assert.equal(handle.state, 'unknown');
  assert.equal(handle.journal.data.outcome, 'unknown');
  assert.throws(() => handle.journal.assertWritable());
  assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error.code), ['OUTCOME_UNKNOWN']);
});
