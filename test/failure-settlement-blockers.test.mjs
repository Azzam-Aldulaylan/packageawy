import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { recoveryFixture } from './helpers/recovery.mjs';
import { blocker } from './helpers/removal-project.mjs';
import { OperationReservation } from '../out/host/operationReservation.js';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';

const execFileAsync = promisify(execFile);

async function preparedOwner(f, hooks) {
  const locks = new ProjectMutationLocks();
  const reservation = new OperationReservation({ locks, reserve: () => true, release() {},
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  const handle = reservation.reserve('change', f.root);
  handle.journal = await f.prepare(hooks);
  handle.state = 'mutating';
  return { handle, locks };
}

for (const pause of ['write-intent', 'adapter-read']) {
  for (const replacementKind of ['present', 'absent', 'delete']) {
    test(`failure fences ${replacementKind} staging paused at ${pause}`, async t => {
      const f = await recoveryFixture(t, { absent: replacementKind === 'absent' });
      const hold = blocker();
      t.after(hold.release);
      const { handle } = await preparedOwner(f, { boundary: async name => {
        if (pause === 'write-intent' && name.startsWith('journal:write:') && name.endsWith(':intent')) await hold.wait();
      } });
      const candidate = replacementKind === 'absent' ? f.lockfile : f.manifest;
      const before = await handle.journal.files.read(candidate);
      if (pause === 'adapter-read') {
        const read = handle.journal.files.read.bind(handle.journal.files);
        let paused = false;
        handle.journal.files.read = async name => {
          const value = await read(name);
          if (!paused) { paused = true; await hold.wait(); }
          return value;
        };
      }
      const writing = handle.journal.adapter().compareAndSwap(candidate, before,
        replacementKind === 'delete' ? { exists: false } : { exists: true, contents: Buffer.from('late write') });
      const rejected = assert.rejects(writing);
      await hold.arrived;
      await handle.fail('internal failure while staging');
      hold.release();
      await rejected;
      assert.equal(handle.state, 'unknown');
      assert.deepEqual(await handle.journal.files.read(candidate), before, 'a fenced write changes no project bytes');
      assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
    });
  }
}

for (const stage of ['displace', 'install']) test(`failure fences rollback rename paused before ${stage}`, async t => {
  const f = await recoveryFixture(t);
  const hold = blocker();
  t.after(hold.release);
  const { handle } = await preparedOwner(f);
  const journal = handle.journal;
  await writeFile(f.manifest, 'changed');
  const before = await journal.files.read(f.manifest);
  await journal.record('rollback', 'intent');
  const safeAbsolute = journal.storage.safeAbsolute.bind(journal.storage);
  let paused = false;
  journal.storage.safeAbsolute = async name => {
    const value = await safeAbsolute(name);
    const match = stage === 'displace' ? /displaced\/[^/]+\.bin$/.test(name) : name === f.manifest && journal.data.files[0].progress === 'displaced';
    if (!paused && match) { paused = true; await hold.wait(); }
    return value;
  };
  const replacing = journal.adapter().compareAndSwap(f.manifest, before, { exists: true, contents: Buffer.from('original') });
  const rejected = assert.rejects(replacing);
  await hold.arrived;
  await handle.fail('internal rollback failure');
  // Displacement may already have happened, but no rename may start after failure.
  const atFailure = await journal.files.read(f.manifest);
  hold.release();
  await rejected;
  assert.deepEqual(await journal.files.read(f.manifest), atFailure);
  assert.equal(handle.state, 'unknown');
});

test('an install-finished expectation TypeError retains the journal and owner as unknown', async t => {
  const f = await recoveryFixture(t);
  const { handle, locks } = await preparedOwner(f);
  const journal = handle.journal;
  const read = journal.files.read.bind(journal.files);
  let injected = false;
  let expectationReads = 0;
  journal.files.read = async candidate => {
    if (!injected && journal.data.step === 'install' && journal.data.phase === 'finished' && ++expectationReads === 2) {
      injected = true;
      throw new TypeError('expectation capture bug');
    }
    return read(candidate);
  };
  const result = await runUpgradeTransaction({ journal, allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(),
    install: { execute: async () => ({ status: 'succeeded' }) },
    verifier: { verify: async () => ({ status: 'passed', checks: [] }) },
  });
  await handle.complete(result.completion);
  assert.equal(injected, true);
  assert.equal(result.completion, 'unknown');
  assert.equal(handle.state, 'unknown');
  assert.equal(locks.tryAcquire(f.root, {}), null);
  assert.equal(JSON.parse(await readFile(`${f.folder}/journal.json`, 'utf8')).outcome, 'unknown');
});

for (const step of ['completion', 'recovery-completion']) test(`${step} expectation errors propagate`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  const error = new TypeError('expectation capture bug');
  journal.files.read = async () => { throw error; };
  await assert.rejects(journal.record(step, 'finished'), error);
});

test('a missing expectation file is captured as absent', async t => {
  const f = await recoveryFixture(t, { absent: true });
  const journal = await f.prepare();
  await journal.record('install', 'finished');
  assert.deepEqual(journal.data.files[1].expected, { kind: 'absent' });
});

for (const context of ['unhandled-rejection', 'uncaught-exception']) {
  for (const scenario of ['admission', 'admission-open']) test(`${context} permanently closes process admission across panels: ${scenario}`, async () => {
    try {
      await execFileAsync(process.execPath, ['test/helpers/sidecar-failure-probe.mjs', context, scenario]);
    } catch (error) {
      assert.fail(error.stdout || error.stderr || error.message);
    }
  });
}
