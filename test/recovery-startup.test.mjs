import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rename, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { deferred, panel, until } from './helpers/dashboard-startup.mjs';

const require = createRequire(import.meta.url);

async function orphanJournal(s) {
  const { prepareJournal } = await import('../out/host/recovery/journal.js');
  const root = path.join(s.root, 'orphan'); await mkdir(root);
  const manifest = path.join(root, 'package.json'); const lock = path.join(root, 'package-lock.json');
  await writeFile(manifest, '{}'); await writeFile(lock, 'original');
  await prepareJournal({ workspaceRoot: s.root, root, identity: JSON.stringify(['target', 'npm', await realpath(root), await realpath(lock), '.']),
    allowlistedPaths: [manifest, lock], operation: 'upgrade', hostKind: 'vscode' });
  await rename(manifest, path.join(root, 'manifest-aside'));
}

test('startup leaves recovery I/O unloaded and discovers an orphan after the first paint', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished();
  await s.ready();
  for (const name of ['journal', 'storage', 'inspection', 'targetDiscovery', 'session']) {
    assert.equal(require.cache[require.resolve(`../out/host/recovery/${name}.js`)], undefined, name);
  }
  assert.equal(s.posted.some(m => m.status === 'recovery-entries'), false);
  await orphanJournal(s);
  await s.current.handle({ type: 'rendered', generatedAt: s.snapshots()[0].data.generatedAt });
  await until(() => s.posted.some(m => m.status === 'recovery'));
  assert.deepEqual(s.posted.find(m => m.status === 'recovery-entries').entries.map(e => e.label), ['orphan']);
  assert.equal(s.posted.find(m => m.status === 'recovery').recovery.files.find(f => f.path === 'package.json').current, 'absent');
});

test('an empty project list still discovers an orphan without a table acknowledgment', async t => {
  const s = await panel(t, { projects: [], target: null });
  await orphanJournal(s);
  await s.ready();
  await until(() => s.posted.some(m => m.status === 'recovery'));
  assert.deepEqual(s.snapshots(), []);
  assert.deepEqual(s.posted.find(m => m.status === 'recovery-entries').entries.map(e => e.label), ['orphan']);
});

test('closing before the scheduled recovery inspection prevents discovery', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished(); await s.ready();
  let inspections = 0;
  s.current.upgradeCoordinator.recovery.inspect = async () => { inspections++; };
  await s.current.handle({ type: 'rendered', generatedAt: s.snapshots()[0].data.generatedAt });
  s.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspections, 0);
});

test('a fatal project switch before rendered still discovers an orphan with its manifest displaced', async t => {
  const s = await panel(t, { projects: ['a', 'bad'], invalid: 'bad' });
  s.gate.resolve(); await s.finished(); await s.ready();
  await orphanJournal(s);
  let inspections = 0;
  const inspect = s.current.upgradeCoordinator.recovery.inspect.bind(s.current.upgradeCoordinator.recovery);
  s.current.upgradeCoordinator.recovery.inspect = async () => { inspections++; await inspect(); };
  assert.equal(inspections, 0);
  assert.equal(s.snapshots().length, 1);
  // No rendered message: replacing the table cancels the webview's paint callback.
  await s.current.openManifest(path.join(s.root, 'bad', 'package.json'));
  assert.equal(s.posted.findLast(m => ['loading', 'ready', 'fatal-error'].includes(m.status)).status, 'fatal-error');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspections, 1, 'cancellation releases discovery without waiting for the timer');
  await until(() => s.posted.some(m => m.status === 'recovery'));
  assert.deepEqual(s.posted.find(m => m.status === 'recovery-entries').entries.map(e => e.label), ['orphan']);
  assert.equal(s.posted.find(m => m.status === 'recovery').recovery.files.find(f => f.path === 'package.json').current, 'absent');
});

for (const status of ['loading', 'empty', 'fatal-error']) {
  test(`${status} replacing a snapshot releases recovery discovery once`, async t => {
    const s = await panel(t);
    s.gate.resolve(); await s.finished();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let inspections = 0;
    s.current.upgradeCoordinator.recovery.inspect = async () => { inspections++; };
    await s.ready();
    s.current.sink.postMessage({ status, ...(status === 'fatal-error' ? { error: { code: 'TEST', message: 'failed' } } : {}) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inspections, 1);
    t.mock.timers.tick(2_000);
    await s.current.handle({ type: 'rendered', generatedAt: s.snapshots()[0].data.generatedAt });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inspections, 1, 'timer and late acknowledgment do not repeat discovery');
  });
}

test('missing paint falls back after a bounded wait that replacement snapshots cannot extend', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let inspections = 0;
  s.current.upgradeCoordinator.recovery.inspect = async () => { inspections++; };
  await s.ready();
  t.mock.timers.tick(1_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspections, 0, 'results get time to paint before recovery I/O');
  s.current.sink.postMessage(s.snapshots()[0]);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspections, 1);
  t.mock.timers.tick(10_000);
  await s.current.handle({ type: 'rendered', generatedAt: s.snapshots()[0].data.generatedAt });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspections, 1);
});

test('closing while waiting for paint clears the recovery fallback', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let inspections = 0;
  s.current.upgradeCoordinator.recovery.inspect = async () => { inspections++; };
  await s.ready();
  s.close();
  t.mock.timers.tick(2_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspections, 0);
  assert.equal(s.current.recoveryInspectionTimer, undefined);
});

test('one discovery EIO retries and finds an orphan with its manifest displaced without a new ready', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished(); await s.ready();
  await orphanJournal(s);
  const fs = require('node:fs/promises');
  const opendir = fs.opendir;
  let failures = 0;
  t.mock.method(fs, 'opendir', async (root, ...args) => {
    if (root === s.root && failures === 0) {
      failures++;
      throw Object.assign(new Error('transient discovery failure'), { code: 'EIO' });
    }
    return opendir(root, ...args);
  });
  await s.current.handle({ type: 'rendered', generatedAt: s.snapshots()[0].data.generatedAt });
  await until(() => s.posted.some(m => m.status === 'recovery-entries'));
  assert.equal(failures, 1, 'the real directory walk encounters one EIO, then the fault clears');
  assert.deepEqual(s.posted.find(m => m.status === 'recovery-entries').entries.map(e => e.label), ['orphan']);
  await until(() => s.posted.some(m => m.status === 'recovery'));
  assert.equal(s.posted.find(m => m.status === 'recovery').recovery.files.find(f => f.path === 'package.json').current, 'absent');
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const rendered = s => s.current.handle({ type: 'rendered', generatedAt: s.snapshots()[0].data.generatedAt });

for (const trigger of ['snapshot', 'rendered', 'Refresh', 'Retry discovery']) {
  test(`${trigger} retries failed discovery after the automatic attempt budget is exhausted`, async t => {
    const s = await panel(t);
    s.gate.resolve(); await s.finished();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    s.current.upgradeCoordinator.recovery.inspect = async () => {
      attempts++;
      if (attempts <= 3) throw Object.assign(new Error('discovery failed'), { code: 'EIO' });
    };
    await s.ready(); await rendered(s); await turn();
    assert.equal(attempts, 1);
    t.mock.timers.tick(249); await turn(); assert.equal(attempts, 1);
    t.mock.timers.tick(1); await turn(); assert.equal(attempts, 2);
    t.mock.timers.tick(499); await turn(); assert.equal(attempts, 2);
    t.mock.timers.tick(1); await turn(); assert.equal(attempts, 3);
    const error = s.posted.findLast(m => m.status === 'recovery');
    assert.equal(error.recovery.state, 'discovery-error');
    assert.match(error.recovery.message, /Retry discovery or use Refresh/);
    assert.equal(s.current.runtimeFailed, false, 'discovery errors do not pause dashboard operations');
    t.mock.timers.tick(60_000); await turn(); assert.equal(attempts, 3, 'automatic retries stop');
    if (trigger === 'snapshot') s.current.sink.postMessage(s.snapshots()[0]);
    if (trigger === 'rendered') await rendered(s);
    if (trigger === 'Refresh') await s.refresh();
    if (trigger === 'Retry discovery') await s.current.handle({ type: 'inspect-recovery' });
    await turn(); assert.equal(attempts, 4);
    assert.equal(s.current.recoveryInspectionPending, false);
    t.mock.timers.tick(60_000); await turn(); assert.equal(attempts, 4);
  });
}

test('rendered, snapshots and Refresh retry before the backoff without concurrent discovery', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred(); let attempts = 0;
  s.current.upgradeCoordinator.recovery.inspect = async () => {
    attempts++;
    if (attempts === 1) throw new Error('discovery failed');
    await gate.promise;
  };
  t.after(() => gate.resolve());
  await s.ready(); await rendered(s); await turn();
  s.current.sink.postMessage(s.snapshots()[0]);
  await turn(); assert.equal(attempts, 2, 'snapshot retries without waiting for paint or backoff');
  await rendered(s); await s.refresh(); await s.current.handle({ type: 'inspect-recovery' });
  t.mock.timers.tick(60_000); await turn();
  assert.equal(attempts, 2, 'in-flight discovery coalesces further retry triggers');
  gate.resolve(); await turn();
  assert.equal(attempts, 2);
});

for (const phase of ['backoff', 'in flight']) {
  test(`closing during discovery ${phase} leaves no retry or error delivery`, async t => {
    const s = await panel(t);
    s.gate.resolve(); await s.finished();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred(); let attempts = 0;
    s.current.upgradeCoordinator.recovery.inspect = async () => {
      attempts++;
      if (phase === 'in flight') await gate.promise;
      throw new Error('discovery failed');
    };
    await s.ready(); await rendered(s); await turn();
    s.close(); gate.resolve(); await turn();
    t.mock.timers.tick(60_000); await turn();
    assert.equal(attempts, 1);
    assert.equal(s.current.recoveryInspectionTimer, undefined);
    assert.equal(s.current.recoveryInspectionImmediate, undefined);
    assert.equal(s.posted.some(m => m.status === 'recovery'), false);
  });
}

test('successful discovery clears its error even when there are no recovery targets', async t => {
  const s = await panel(t, { projects: [], target: null });
  s.current.upgradeCoordinator.recovery.reportDiscoveryFailure();
  await s.ready();
  s.current.upgradeCoordinator.recovery.reportDiscoveryFailure();
  await until(() => s.posted.findLast(m => m.status === 'recovery')?.recovery.state === 'none');
});
