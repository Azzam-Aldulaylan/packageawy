import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { RECOVERY_MESSAGES } from '../out/host/recovery/model.js';
import { RecoverySession } from '../out/host/recovery/session.js';

const failure = code => Object.assign(new Error(code), { code });

test('prepared contains byte-exact backups, modes, absent files, and no project changes', async t => {
  const f = await recoveryFixture(t, { absent: true });
  await fs.chmod(f.manifest, 0o640);
  const journal = await f.prepare();
  assert.equal(journal.data.step, 'prepared');
  assert.equal(journal.data.files[0].backup.mode, 0o640);
  assert.equal((await journal.backupState(journal.data.files[0].backup)).contents.toString(), await f.read('package.json'));
  assert.equal(journal.data.files[1].backup.existed, false);
  assert.equal(await fs.readFile(path.join(f.folder, '.gitignore'), 'utf8'), '*');
  await assert.rejects(f.prepare(), { message: RECOVERY_MESSAGES.blocked });
});

for (const errorCode of ['EPERM', 'ENOTSUP', 'ENOSYS', 'EIO']) test(`hard-link ${errorCode} refuses without fallback`, async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(f.prepare({ fs: { ...fs, link: async () => { throw failure(errorCode); } } }), { message: RECOVERY_MESSAGES.unsupported });
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
  assert.equal((await f.inspect()).view.state, 'uninitialized');
});

test('a link error after create is uncertain and refuses even with our owner contents', async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(f.prepare({ fs: { ...fs, link: async (from, to) => { await fs.link(from, to); throw failure('EEXIST'); } } }), { message: RECOVERY_MESSAGES.unsupported });
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
  await assert.rejects(f.prepare(), { message: RECOVERY_MESSAGES.blocked });
});

for (const [method, errorCode] of [['writeFile', 'ENOSPC'], ['sync', 'EIO'], ['sync', 'ENOSPC']]) test(`${method} ${errorCode} blocks before project writes`, async t => {
  const f = await recoveryFixture(t);
  const fakeFs = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === method && args[1] === 'wx') return async () => { throw failure(errorCode); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  await assert.rejects(f.prepare({ fs: fakeFs }), { code: errorCode });
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
  await assert.rejects(f.prepare(), { message: RECOVERY_MESSAGES.blocked });
});

test('Windows directory sync is unsupported, while file sync is still required', async t => {
  const f = await recoveryFixture(t);
  const calls = [];
  await f.prepare({ platform: 'win32', fs: { ...fs, open: async (...args) => { calls.push(args[1]); return fs.open(...args); } } });
  assert.ok(calls.includes('wx'));
  assert.ok(!calls.includes('r'), 'directory opens are skipped on Windows');
});

test('a sharing violation keeps old journal bytes and never unlinks first', async t => {
  const f = await recoveryFixture(t);
  let fail = false;
  const journal = await f.prepare({ fs: { ...fs, rename: async (from, to) => {
    if (fail && to.endsWith('journal.json')) throw failure('EPERM');
    return fs.rename(from, to);
  } } });
  const before = await fs.readFile(path.join(f.folder, 'journal.json'));
  fail = true;
  await assert.rejects(journal.record('install', 'intent'), { code: 'EPERM' });
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'journal.json')), before);
});

for (const badPath of ['../outside.json', '/tmp/outside.json', 'nested/../../outside.json', 'nested\\outside.json']) test(`malicious backup path ${badPath} is never restored`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  const file = journal.data.files[0];
  file.backup.path = badPath;
  await fs.writeFile(path.join(f.folder, 'backups', `${file.backup.id}.json`), JSON.stringify(file.backup));
  await fs.writeFile(path.join(f.folder, 'journal.json'), JSON.stringify(journal.data));
  const inspected = await f.inspect();
  assert.equal(inspected.view.message, RECOVERY_MESSAGES.unsafe);
  const session = await f.open();
  const review = await session.presentation();
  assert.equal(review.files.some(file => file.path === badPath), false);
  await session.apply(choices(review, 'restore', true));
  assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
});

test('a symlink in any journal component refuses reads and writes', async t => {
  if (process.platform === 'win32') { t.skip('creating symlinks can require elevated Windows privileges'); return; }
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.rename(path.join(f.folder, 'backups'), path.join(f.root, 'saved'));
  await fs.symlink(path.join(f.root, 'saved'), path.join(f.folder, 'backups'));
  const inspected = await f.inspect();
  assert.equal(inspected.view.message, RECOVERY_MESSAGES.unsafe);
  assert.deepEqual(inspected.view.files, []);
  const session = await f.open();
  await session.apply([]);
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
  await assert.rejects(session.dismiss(true, false));
});

test('missing and corrupt journals recover only independently validated backups', async t => {
  for (const corrupt of [false, true]) {
    const f = await recoveryFixture(t);
    await f.prepare();
    if (corrupt) await fs.writeFile(path.join(f.folder, 'journal.json'), '{');
    else await fs.unlink(path.join(f.folder, 'journal.json'));
    await fs.writeFile(f.lockfile, 'changed');
    const inspected = await f.inspect();
    assert.equal(inspected.view.state, 'invalid');
    assert.equal(inspected.view.files.length, 2);
    const session = await f.open();
    await session.apply(choices(await session.presentation(), 'restore', true));
    assert.equal(await f.read('package-lock.json'), 'original lockfile');
  }
});

test('a backup hash mismatch never authorizes restoration', async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  await fs.writeFile(path.join(f.folder, 'backups', `${journal.data.files[0].backup.id}.bin`), 'tampered');
  assert.equal((await f.inspect()).view.message, RECOVERY_MESSAGES.unsafe);
  const session = await f.open();
  const review = await session.presentation();
  assert.equal(review.files.some(file => file.path === 'package.json'), false);
  await session.apply(choices(review, 'restore', true));
  assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
  await assert.rejects(session.dismiss(true, false));
});

test('Keep current also requires stopped confirmation and keeps bytes until dismissal', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.lockfile, 'changed');
  await assert.rejects(RecoverySession.open(f.target, false, null), { message: RECOVERY_MESSAGES.stop });
  const session = await f.open();
  await session.apply(choices(await session.presentation()));
  assert.equal(await f.read('package-lock.json'), 'changed');
  assert.equal((await f.inspect()).view.message, RECOVERY_MESSAGES.completed);
  await assert.rejects(session.dismiss(false, false), { message: RECOVERY_MESSAGES.stop });
  await session.dismiss(true, false);
  assert.equal((await f.inspect()).view.state, 'none');
});

test('deleting a file that did not exist before needs explicit per-file approval', async t => {
  const f = await recoveryFixture(t, { absent: true });
  await f.prepare();
  await fs.writeFile(f.lockfile, 'created by install');
  const session = await f.open();
  const view = await session.presentation();
  await assert.rejects(session.apply(choices(view, 'restore')), { message: RECOVERY_MESSAGES.unsafe });
  assert.equal(await f.read('package-lock.json'), 'created by install');
  await session.apply(choices(view, 'restore', true));
  await assert.rejects(fs.stat(f.lockfile), { code: 'ENOENT' });
  const journal = (await f.inspect()).journal;
  const file = journal.data.files.find(file => !file.backup.existed);
  assert.equal(await fs.readFile(path.join(f.folder, 'displaced', `${file.displacedIds[0]}.bin`), 'utf8'), 'created by install');
});

test('all choices precheck before any write and each file rechecks immediately before its move', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.manifest, 'changed manifest');
  const session = await f.open();
  const view = await session.presentation();
  await fs.writeFile(f.lockfile, 'external edit');
  await assert.rejects(session.apply(choices(view, 'restore', true)), { message: RECOVERY_MESSAGES.incomplete });
  assert.equal(await f.read('package.json'), 'changed manifest', 'a later conflict prevents the first replacement');
  assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
});

test('rename failure preserves current bytes with no copy fallback', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.lockfile, 'changed');
  const session = await f.open({ fs: { ...fs, rename: async (from, to) => {
    if (from === f.lockfile) throw failure('EXDEV');
    return fs.rename(from, to);
  } } });
  const view = await session.presentation();
  await assert.rejects(session.apply(choices(view, 'restore', true)), { code: 'EXDEV' });
  assert.equal(await f.read('package-lock.json'), 'changed');
  assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
});

test('repeated displacement always records a new id and keeps every earlier inode', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.lockfile, 'first');
  const first = await f.open();
  await first.apply(choices(await first.presentation(), 'restore', true));
  await fs.writeFile(f.lockfile, 'second');
  const second = await f.open();
  await second.apply(choices(await second.presentation(), 'restore', true));
  const journal = (await f.inspect()).journal;
  const file = journal.data.files.find(file => file.backup.path === 'package-lock.json');
  assert.equal(new Set(file.displacedIds).size, 2);
  assert.deepEqual(await Promise.all(file.displacedIds.map(id => fs.readFile(path.join(f.folder, 'displaced', `${id}.bin`), 'utf8'))), ['first', 'second']);
});

test('a new claim fences old journal writers and old recoveries, including cleanup', async t => {
  const f = await recoveryFixture(t);
  const original = await f.prepare();
  const first = await f.open();
  await assert.rejects(original.record('install', 'intent'), { message: RECOVERY_MESSAGES.blocked });
  const second = await f.open();
  await assert.rejects(first.apply(choices(await first.presentation())), { message: RECOVERY_MESSAGES.blocked });
  await assert.rejects(first.dismiss(true, true), { message: RECOVERY_MESSAGES.blocked });
  await second.apply(choices(await second.presentation()));
  await second.dismiss(true, false);
});

test('an unrecognized entry prevents deleting even recognized entries', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  const session = await f.open();
  await session.apply(choices(await session.presentation()));
  await fs.writeFile(path.join(f.folder, 'not-packageawy'), 'keep');
  const before = await fs.readdir(path.join(f.folder, 'backups'));
  await assert.rejects(session.dismiss(true, false), { message: RECOVERY_MESSAGES.unrecognized });
  assert.deepEqual(await fs.readdir(path.join(f.folder, 'backups')), before);
});

for (const errorCode of ['EPERM', 'ENOTSUP']) test(`claim hard-link ${errorCode} refuses recovery without replacing project files`, async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.lockfile, 'changed');
  await assert.rejects(f.open({ fs: { ...fs, link: async () => { throw failure(errorCode); } } }), { message: RECOVERY_MESSAGES.unsupported });
  assert.equal(await f.read('package-lock.json'), 'changed');
  assert.equal(await fs.stat(path.join(f.folder, 'claim.json')).catch(() => null), null);
});

test('an uncertain claim publication keeps its complete claim and refuses restoration', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await assert.rejects(f.open({ fs: { ...fs, link: async (from, to) => { await fs.link(from, to); throw failure('EIO'); } } }), { message: RECOVERY_MESSAGES.unsupported });
  assert.equal(typeof JSON.parse(await fs.readFile(path.join(f.folder, 'claim.json'), 'utf8')).token, 'string');
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
});

test('all publications write, sync and close before either exclusive linking or replacement rename', async t => {
  const f = await recoveryFixture(t);
  const operations = [];
  const fakeFs = { ...fs,
    open: async (name, ...args) => {
      const handle = await fs.open(name, ...args);
      return new Proxy(handle, { get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...parameters) => { if (['writeFile', 'sync', 'close'].includes(property)) operations.push([property, name]); return value.apply(target, parameters); };
      } });
    },
    link: async (from, to) => { operations.push(['link', from]); return fs.link(from, to); },
    rename: async (from, to) => { operations.push(['rename', from]); return fs.rename(from, to); },
  };
  await f.prepare({ fs: fakeFs });
  const publications = operations.filter(([operation]) => operation === 'link' || operation === 'rename');
  assert.ok(publications.length >= 6);
  for (const [operation, temporary] of publications) {
    const steps = operations.filter(([, name]) => name === temporary).map(([method]) => method);
    assert.deepEqual(steps, ['writeFile', 'sync', 'close', operation]);
  }
});

test('directory fsync I/O errors refuse bootstrap and keep the exclusive folder', async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(f.prepare({ fs: { ...fs, open: async (name, ...args) => {
    const handle = await fs.open(name, ...args);
    if (args[0] === 'r') handle.sync = async () => { throw failure('EIO'); };
    return handle;
  } } }), { code: 'EIO' });
  assert.equal((await f.inspect()).view.state, 'uninitialized');
  await assert.rejects(f.prepare(), { message: RECOVERY_MESSAGES.blocked });
});

for (const outcome of ['kept', 'rolled-back']) test(`clean ${outcome} removes only its known artifacts and unlocks`, async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  assert.equal(await journal.finish(outcome), true);
  assert.equal((await f.inspect()).view.state, 'none');
  const next = await f.prepare();
  await assert.rejects(journal.finish(outcome), { message: RECOVERY_MESSAGES.blocked });
  assert.equal((await f.inspect()).owner.ownerToken, next.owner.ownerToken);
});

test('an incomplete result and a displaced rollback keep all saved artifacts', async t => {
  for (const displaced of [false, true]) {
    const f = await recoveryFixture(t);
    const journal = await f.prepare();
    if (displaced) {
      await fs.writeFile(f.lockfile, 'installed');
      await journal.record('rollback', 'intent');
      assert.equal(await journal.adapter().compareAndSwap(f.lockfile, { exists: true, contents: Buffer.from('installed') }, { exists: true, contents: Buffer.from('original lockfile') }), 'restored');
    }
    assert.equal(await journal.finish(displaced ? 'rolled-back' : 'incomplete'), false);
    assert.notEqual((await f.inspect()).view.state, 'none');
  }
});

test('a stale confirmed claim cannot rename the next claimant after the ownership check', async t => {
  const f = await recoveryFixture(t);
  await f.prepare(); await f.open();
  const old = (await f.inspect()).view.claim;
  const original = JSON.parse(await fs.readFile(path.join(f.folder, 'claim.json'), 'utf8'));
  const next = { ...original, token: '11111111-1111-4111-8111-111111111111' };
  await assert.rejects(RecoverySession.open(f.target, true, old, { boundary: async name => {
    if (name === 'takeover:created') await fs.writeFile(path.join(f.folder, 'claim.json'), JSON.stringify(next));
  } }), { message: RECOVERY_MESSAGES.blocked });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.folder, 'claim.json'), 'utf8')), next);
  assert.ok((await fs.stat(path.join(f.folder, 'takeover'))).isDirectory());
});

for (const extra of ['data.bin', 'backups/data.bin', 'displaced/data.bin']) test(`uninitialized recovery with ${extra} never deletes data`, async t => {
  const f = await recoveryFixture(t);
  await fs.mkdir(f.folder); await fs.mkdir(path.join(f.folder, 'backups')); await fs.mkdir(path.join(f.folder, 'displaced'));
  await fs.writeFile(path.join(f.folder, extra), 'not disposable');
  assert.equal((await f.inspect()).view.message, RECOVERY_MESSAGES.invalid);
  await assert.rejects(f.open(), { message: RECOVERY_MESSAGES.invalid });
  assert.equal(await fs.readFile(path.join(f.folder, extra), 'utf8'), 'not disposable');
});

test('uninitialized temp files and empty directories are removed only after confirmation', async t => {
  const f = await recoveryFixture(t);
  await fs.mkdir(f.folder); await fs.mkdir(path.join(f.folder, 'backups')); await fs.mkdir(path.join(f.folder, 'displaced'));
  await fs.writeFile(path.join(f.folder, '.gitignore'), '*');
  await fs.writeFile(path.join(f.folder, 'owner.json.tmp-11111111-1111-4111-8111-111111111111'), 'torn bytes');
  const session = await f.open();
  await assert.rejects(session.dismiss(false, true), { message: RECOVERY_MESSAGES.stop });
  await session.dismiss(true, true);
  assert.equal((await f.inspect()).view.state, 'none');
});

test('an edit after the all-file precheck is caught immediately before the later file changes', async t => {
  const f = await recoveryFixture(t); await f.prepare();
  await fs.writeFile(f.manifest, 'installed manifest'); await fs.writeFile(f.lockfile, 'installed lock');
  let edited = false;
  const session = await f.open({ boundary: async name => {
    if (name === 'replacement:installed' && !edited) { edited = true; await fs.writeFile(f.lockfile, 'edit after precheck'); }
  } });
  await assert.rejects(session.apply(choices(await session.presentation(), 'restore', true)), { message: RECOVERY_MESSAGES.incomplete });
  assert.equal(await f.read('package-lock.json'), 'edit after precheck');
  const inspected = await f.inspect();
  assert.equal(inspected.journal.data.outcome, 'recovery-incomplete');
  assert.ok(inspected.journal.data.files[0].displacedIds.length > 0);
});

test('an unknown move expectation is never treated as an unchanged original', async t => {
  const f = await recoveryFixture(t); const journal = await f.prepare();
  const id = '11111111-1111-4111-8111-111111111111';
  const file = journal.data.files[0];
  file.progress = 'displace'; file.move = { id, before: { kind: 'unknown' } }; file.displacedIds.push(id);
  await journal.save();
  assert.equal((await f.inspect()).view.files[0].progress, 'unknown');
  assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
});

test('backup and restore preserve arbitrary bytes and permission bits', async t => {
  const f = await recoveryFixture(t);
  const original = Buffer.from([0, 255, 128, 10, 13, 42]);
  await fs.writeFile(f.lockfile, original); await fs.chmod(f.lockfile, 0o666);
  const journal = await f.prepare();
  assert.deepEqual((await journal.backupState(journal.data.files[1].backup)).contents, original);
  await fs.writeFile(f.lockfile, 'installed');
  const session = await f.open(); await session.apply(choices(await session.presentation(), 'restore', true));
  assert.deepEqual(await fs.readFile(f.lockfile), original);
  assert.equal((await fs.stat(f.lockfile)).mode & 0o777, 0o666);
});

test('restoring unchanged bytes records the choice without displacing an unchanged inode', async t => {
  const f = await recoveryFixture(t); await f.prepare();
  const session = await f.open(); await session.apply(choices(await session.presentation(), 'restore', true));
  assert.deepEqual(await fs.readdir(path.join(f.folder, 'displaced')), []);
  assert.ok((await f.inspect()).journal.data.files.every(file => file.progress === 'restored'));
});

test('an unexpected displacement destination is never overwritten', async t => {
  const f = await recoveryFixture(t); await f.prepare(); await fs.writeFile(f.lockfile, 'installed');
  let savedPath;
  const session = await f.open({ boundary: async name => {
    if (name !== 'published:journal.json' || savedPath) return;
    const data = JSON.parse(await fs.readFile(path.join(f.folder, 'journal.json'), 'utf8'));
    const moving = data.files.find(file => file.progress === 'displace');
    if (moving) { savedPath = path.join(f.folder, 'displaced', `${moving.move.id}.bin`); await fs.writeFile(savedPath, 'earlier saved file'); }
  } });
  await assert.rejects(session.apply(choices(await session.presentation(), 'restore', true)), { message: RECOVERY_MESSAGES.incomplete });
  assert.equal(await fs.readFile(savedPath, 'utf8'), 'earlier saved file');
  assert.equal(await f.read('package-lock.json'), 'installed');
});

test('a sync failure after displacement leaves the inode saved and never installs its replacement', async t => {
  const f = await recoveryFixture(t); await f.prepare(); await fs.writeFile(f.lockfile, 'installed');
  let moved = false;
  const session = await f.open({ fs: { ...fs,
    rename: async (from, to) => { await fs.rename(from, to); if (from === f.lockfile) moved = true; },
    open: async (name, ...args) => {
      const handle = await fs.open(name, ...args);
      if (name === f.root && moved) handle.sync = async () => { throw failure('EIO'); };
      return handle;
    },
  } });
  await assert.rejects(session.apply(choices(await session.presentation(), 'restore', true)), { code: 'EIO' });
  await assert.rejects(fs.stat(f.lockfile), { code: 'ENOENT' });
  const inspected = await f.inspect();
  assert.equal(inspected.view.files[1].progress, 'moved but not restored');
  const file = inspected.journal.data.files[1];
  assert.equal(await fs.readFile(path.join(f.folder, 'displaced', `${file.move.id}.bin`), 'utf8'), 'installed');
});

test('a failed recovery publication requires a fresh confirmed claim before retrying', async t => {
  const f = await recoveryFixture(t); await f.prepare(); await fs.writeFile(f.lockfile, 'installed');
  let failed = false;
  const session = await f.open({ fs: { ...fs, rename: async (from, to) => {
    if (!failed && to.endsWith('journal.json')) {
      const value = JSON.parse(await fs.readFile(from, 'utf8'));
      if (value.files.some(file => file.progress === 'displace')) { failed = true; throw failure('EIO'); }
    }
    return fs.rename(from, to);
  } } });
  await assert.rejects(session.apply(choices(await session.presentation(), 'restore', true)));
  assert.equal((await session.presentation()).canApply, false);
  assert.equal(await f.read('package-lock.json'), 'installed');
  const resumed = await f.open();
  assert.equal((await resumed.presentation()).canApply, true);
  await resumed.apply(choices(await resumed.presentation(), 'restore', true));
  assert.equal(await f.read('package-lock.json'), 'original lockfile');
});

test('a metadata tail finishes only its remaining deletes without publishing new metadata', async t => {
  const f = await recoveryFixture(t); await f.prepare();
  const first = await f.open({ boundary: async name => { if (name === 'removal:7') throw new Error('interrupted after deleting journal'); } });
  await first.apply(choices(await first.presentation()));
  await assert.rejects(first.dismiss(true, false), /interrupted after deleting journal/);
  assert.deepEqual(await fs.readdir(f.folder), ['owner.json']);
  const resumed = await f.open({ fs: { ...fs, open: async (name, ...args) => {
    assert.notEqual(args[0], 'wx', 'a metadata tail cannot recreate its deleted journal');
    return fs.open(name, ...args);
  } } });
  await resumed.dismiss(true, false);
  assert.equal((await f.inspect()).view.state, 'none');
});


test('a real takeover during a pending dismissal publication fences the stale session', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  let pause = false; let reached; let resume;
  const arrived = new Promise(resolve => { reached = resolve; });
  const pending = new Promise(resolve => { resume = resolve; });
  const stale = await f.open({ boundary: async name => {
    if (pause && name === 'synced:journal.json') { pause = false; reached(); await pending; }
  } });
  pause = true;
  const dismissal = stale.dismiss(true, true);
  await arrived;
  const next = await f.open();
  const before = await Promise.all(['owner.json', 'claim.json', 'journal.json'].map(name => fs.readFile(path.join(f.folder, name))));
  const backups = await fs.readdir(path.join(f.folder, 'backups'));
  resume();
  await assert.rejects(dismissal, { message: RECOVERY_MESSAGES.blocked });
  assert.deepEqual(await Promise.all(['owner.json', 'claim.json', 'journal.json'].map(name => fs.readFile(path.join(f.folder, name)))), before);
  assert.deepEqual(await fs.readdir(path.join(f.folder, 'backups')), backups);
  await next.apply(choices(await next.presentation()));
  await next.dismiss(true, false);
  assert.equal((await f.inspect()).view.state, 'none');
});
