import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { recoveryFixture, choices, normalizeBoundary } from './helpers/recovery.mjs';
import { RECOVERY_MESSAGES, newId } from '../out/host/recovery/model.js';
import { RecoverySession } from '../out/host/recovery/session.js';

const children = new Set();
afterEach(() => { for (const process of children) process.kill('SIGKILL'); });

function child(target, mode, pauseAt = '', claim = null) {
  const process = fork(new URL('./helpers/recovery-child.mjs', import.meta.url), [JSON.stringify(target), mode, pauseAt, JSON.stringify(claim)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(process);
  process.on('exit', () => children.delete(process));
  let stderr = '';
  process.stderr.on('data', chunk => { stderr += chunk; });
  const boundaries = [];
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = message => { settled = true; resolve(message); };
    const watchdog = setTimeout(() => { process.kill('SIGKILL'); reject(new Error(`child did not reach ${pauseAt}`)); }, 15000);
    process.once('exit', () => clearTimeout(watchdog));
    process.on('message', message => {
      if (message.indexed) boundaries.push(message.indexed);
      if (message.boundary === pauseAt || message.done || message.error) finish(message);
    });
    process.on('error', reject);
    process.on('exit', (code, signal) => { if (!settled || (code && !signal)) reject(new Error(stderr || `child exited before ${pauseAt}`)); });
  });
  return { process, result, boundaries, exit: once(process, 'exit') };
}
async function runChild(target, mode, pauseAt = '', claim = null) {
  const running = child(target, mode, pauseAt, claim);
  const result = await running.result;
  const killed = pauseAt && result.boundary === pauseAt;
  if (killed) assert.equal(running.process.kill('SIGKILL'), true);
  const [, signal] = await running.exit;
  if (killed) assert.equal(signal, 'SIGKILL');
  return result;
}

test('two real Node hosts race for the exclusive mutation folder', async t => {
  const f = await recoveryFixture(t);
  const runs = [child(f.target, 'prepare'), child(f.target, 'prepare')];
  const results = await Promise.all(runs.map(run => run.result));
  await Promise.all(runs.map(run => run.exit));
  assert.equal(results.filter(result => result.done).length, 1);
  assert.equal(results.filter(result => result.error === RECOVERY_MESSAGES.blocked).length, 1);
  assert.equal((await f.inspect()).view.state, 'blocked');
});

test('real child killed at every bootstrap publication boundary reopens blocked without restoring', async t => {
  const boundaries = [
    'folder:created', 'synced:owner.json', 'linked:owner.json', 'published:owner.json',
    'synced:.gitignore', 'published:.gitignore',
    'synced:backups/<id>.bin#1', 'published:backups/<id>.bin#1',
    'synced:backups/<id>.json#1', 'published:backups/<id>.json#1',
    'synced:backups/<id>.bin#2', 'published:backups/<id>.bin#2',
    'synced:backups/<id>.json#2', 'published:backups/<id>.json#2',
    'synced:journal.json', 'published:journal.json', 'prepared',
  ];
  for (const boundary of boundaries) await t.test(boundary, async t => {
    const f = await recoveryFixture(t);
    const result = await runChild(f.target, 'prepare', boundary);
    assert.equal(result.boundary, boundary);
    assert.notEqual((await f.inspect()).view.state, 'none');
    assert.equal(await f.read('package-lock.json'), 'original lockfile');
    assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
    await assert.rejects(f.prepare());
  });
});

// These are protocol requirements, deliberately independent of the emitted
// trace. Removing an adapter or runner boundary must make the suite fail.
const commonTransactionBoundaries = [
  'prepared', 'journal:write:<id>:intent#1', 'journal:write:<id>:finished#1',
  'journal:install:intent', 'journal:install:finished',
  'journal:verification:intent', 'journal:Packageawy: Verify test:intent',
  'journal:Packageawy: Verify test:finished', 'journal:verification:finished',
  'journal:decision:intent', 'journal:decision:finished', 'journal:rollback:intent',
  'displacement:moved#1', 'restore:intent#1', 'replacement:installed#1',
  'journal:rollback:finished', 'journal:completion:finished',
];
const mandatoryBoundaries = {
  upgrade: [...commonTransactionBoundaries,
    'journal:Packageawy: Upgrade a:intent', 'journal:Packageawy: Upgrade a:finished',
    'journal:write:<id>:intent#2', 'journal:write:<id>:finished#2',
    'journal:Packageawy: Upgrade a (keep version ranges):intent', 'journal:Packageawy: Upgrade a (keep version ranges):finished',
    'displacement:moved#2', 'restore:intent#2', 'replacement:installed#2',
  ],
  removal: [...commonTransactionBoundaries,
    'journal:Packageawy: Reconcile cleanup changes:intent', 'journal:Packageawy: Reconcile cleanup changes:finished',
    'displacement:moved#2', 'restore:intent#2', 'replacement:installed#2',
  ],
  remediation: [...commonTransactionBoundaries,
    'journal:Packageawy: Apply transitive security fix:intent', 'journal:Packageawy: Apply transitive security fix:finished',
  ],
  cleanup: [...commonTransactionBoundaries,
    'journal:Packageawy: Reconcile cleanup changes:intent', 'journal:Packageawy: Reconcile cleanup changes:finished',
    'displacement:moved#2', 'restore:intent#2', 'replacement:installed#2',
  ],
};

for (const [flow, boundaries] of Object.entries(mandatoryBoundaries)) test(`${flow}: real crashes at mandatory boundaries preserve saved and displaced bytes`, async t => {
  const baseline = await recoveryFixture(t);
  const trace = child(baseline.target, `transaction:${flow}`);
  assert.equal((await trace.result).done, true);
  await trace.exit;
  for (const boundary of boundaries) {
    const indexed = boundary.includes('#') ? boundary : `${boundary}#1`;
    assert.ok(trace.boundaries.includes(indexed), `missing mandatory ${flow} boundary: ${boundary}`);
  }
  for (const boundary of boundaries) await t.test(boundary, async t => {
    const fixture = await recoveryFixture(t);
    const result = await runChild(fixture.target, `transaction:${flow}`, boundary);
    assert.equal(result.boundary, boundary, result.error);
    const before = await Promise.all(fixture.target.allowlistedPaths.map(file => fs.readFile(file).catch(() => null)));
    const inspected = await fixture.inspect();
    assert.notEqual(inspected.view.state, 'none');
    assert.deepEqual(await Promise.all(fixture.target.allowlistedPaths.map(file => fs.readFile(file).catch(() => null))), before);
    for (const file of inspected.journal.data.files) {
      const saved = await fs.readFile(path.join(fixture.folder, 'backups', `${file.backup.id}.bin`), 'utf8');
      assert.equal(saved, file.backup.path === 'package.json' ? '{"dependencies":{"a":"1.0.0"}}' : 'original lockfile');
      if (file.move && ['displaced', 'restored'].includes(file.progress)) {
        const displaced = await fs.readFile(path.join(fixture.folder, 'displaced', `${file.move.id}.bin`));
        assert.equal(createHash('sha256').update(displaced).digest('hex'), file.move.before.sha256);
      }
    }
    await assert.rejects(fixture.prepare());
  });
});

test('interrupted displacement is shown without automatic replacement, then retry preserves the earlier displaced file', async t => {
  for (const boundary of ['displacement:moved', 'replacement:installed']) await t.test(boundary, async t => {
    const f = await recoveryFixture(t);
    await f.prepare();
    await fs.writeFile(f.manifest, 'outside edit');
    assert.equal((await runChild(f.target, 'restore', boundary)).boundary, boundary);
    const inspected = await f.inspect();
    assert.equal(inspected.view.files[0].progress, boundary === 'displacement:moved' ? 'moved but not restored' : 'restored');
    const before = await fs.readFile(f.manifest).catch(() => null);
    await f.inspect();
    assert.deepEqual(await fs.readFile(f.manifest).catch(() => null), before);
    const session = await f.open();
    await session.apply(choices(await session.presentation(), 'restore', true));
    const journal = (await f.inspect()).journal;
    const id = journal.data.files[0].displacedIds[0];
    assert.equal(await fs.readFile(path.join(f.folder, 'displaced', `${id}.bin`), 'utf8'), 'outside edit');
  });
});

test('competing complete and torn claims are serialized across two processes', async t => {
  for (const torn of [false, true]) await t.test(torn ? 'torn' : 'complete', async t => {
    const f = await recoveryFixture(t);
    await f.prepare();
    if (torn) await fs.writeFile(path.join(f.folder, 'claim.json'), '{"token":');
    else await f.open();
    const confirmed = (await f.inspect()).view.claim;
    const runs = [child(f.target, 'claim', '', confirmed), child(f.target, 'claim', '', confirmed)];
    const results = await Promise.all(runs.map(run => run.result));
    await Promise.all(runs.map(run => run.exit));
    const diagnostics = JSON.stringify(results);
    assert.equal(results.filter(result => result.done).length, 1, diagnostics);
    assert.equal(results.filter(result => result.error).length, 1, diagnostics);
    const claim = JSON.parse(await fs.readFile(path.join(f.folder, 'claim.json'), 'utf8'));
    assert.equal(typeof claim.token, 'string');
    assert.ok((await fs.readdir(f.folder)).some(name => name.endsWith('.abandoned')));
  });
});

test('two processes seeing a leftover takeover directory both stop and leave it untouched', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  const initial = await f.open();
  const confirmed = (await f.inspect()).view.claim;
  assert.equal((await runChild(f.target, 'claim', 'takeover:created', confirmed)).boundary, 'takeover:created');
  const runs = [child(f.target, 'claim', '', confirmed), child(f.target, 'claim', '', confirmed)];
  assert.deepEqual((await Promise.all(runs.map(run => run.result))).map(result => result.error), [RECOVERY_MESSAGES.interruptedTakeover, RECOVERY_MESSAGES.interruptedTakeover]);
  await Promise.all(runs.map(run => run.exit));
  assert.ok((await fs.stat(path.join(f.folder, 'takeover'))).isDirectory());
  await assert.rejects(initial.dismiss(true, true));
});

for (let step = 1; step <= 9; step++) test(`dismissal killed after step ${step} resumes in a new process`, async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.manifest, 'changed');
  const session = await f.open();
  await session.apply(choices(await session.presentation(), 'restore', true));
  // Include a known publication temp and an abandoned claim in the cleanup set.
  await fs.writeFile(path.join(f.folder, `owner.json.tmp-${newId()}`), 'temp');
  assert.equal((await runChild(f.target, 'dismiss', `removal:${step}`)).boundary, `removal:${step}`);
  const view = (await f.inspect()).view;
  if (step === 9) assert.equal(view.state, 'none');
  else {
    assert.notEqual(view.state, 'none');
    if (step === 8) {
      await assert.rejects(RecoverySession.open(f.target, false, view.claim), { message: RECOVERY_MESSAGES.stop });
      assert.equal(view.state, 'uninitialized');
    }
    const resumed = await runChild(f.target, 'dismiss');
    assert.equal(resumed.done, true, resumed.error);
    assert.equal((await f.inspect()).view.state, 'none');
  }
  assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
});

test('empty bootstrap cannot be removed without stopped confirmation, including a live just-created folder', async t => {
  const f = await recoveryFixture(t);
  const running = child(f.target, 'prepare', 'folder:created');
  assert.equal((await running.result).boundary, 'folder:created');
  const inspected = await f.inspect();
  assert.equal(inspected.view.state, 'uninitialized');
  await assert.rejects(f.prepare(), { message: RECOVERY_MESSAGES.blocked });
  await assert.rejects(RecoverySession.open(f.target, false, null), { message: RECOVERY_MESSAGES.stop });
  assert.ok((await fs.stat(f.folder)).isDirectory());
  running.process.kill('SIGKILL'); await running.exit;
  const resumed = await runChild(f.target, 'dismiss');
  assert.equal(resumed.done, true, resumed.error);
});

test('cleanup never opens admission until rmdir, and a late owner cannot remove a new journal', async t => {
  for (const step of [8, 9]) {
    const f = await recoveryFixture(t);
    await f.prepare();
    const running = child(f.target, 'dismiss', `removal:${step}`);
    assert.equal((await running.result).boundary, `removal:${step}`);
    if (step === 8) await assert.rejects(f.prepare(), { message: RECOVERY_MESSAGES.blocked });
    else {
      const next = await f.prepare();
      assert.equal((await f.inspect()).owner.ownerToken, next.owner.ownerToken);
    }
    running.process.kill('SIGKILL'); await running.exit;
  }
});

for (const boundary of ['synced:claim.json', 'linked:claim.json', 'published:claim.json', 'takeover:abandoned']) test(`a real claim crash at ${boundary} leaves only complete publications`, async t => {
  const f = await recoveryFixture(t); await f.prepare();
  const takeover = boundary === 'takeover:abandoned';
  if (takeover) await f.open();
  const confirmed = (await f.inspect()).view.claim;
  assert.equal((await runChild(f.target, 'claim', boundary, confirmed)).boundary, boundary);
  const current = await fs.readFile(path.join(f.folder, 'claim.json'), 'utf8').catch(() => undefined);
  if (current !== undefined) assert.equal(typeof JSON.parse(current).token, 'string');
  const inspected = await f.inspect();
  assert.notEqual(inspected.view.state, 'none');
  if (takeover) assert.equal(inspected.view.message, RECOVERY_MESSAGES.interruptedTakeover);
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
});
