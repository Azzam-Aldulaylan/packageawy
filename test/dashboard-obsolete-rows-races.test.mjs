import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { panel, deferred, until, json } from './helpers/dashboard-startup.mjs';

const manifest = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { react: '^18.0.0' } });
const lock = version => JSON.stringify({ name: 'app', lockfileVersion: 3, packages: {
  '': { name: 'app', version: '1.0.0', dependencies: { react: '^18.0.0' } },
  'node_modules/react': { version },
} });

async function setup(t, early = false, version = '18.3.0') {
  // Startup must wait until this fixture has replaced the dependency files.
  const discovery = deferred();
  const s = await panel(t, { early, discover: () => discovery.promise });
  await writeFile(path.join(s.root, 'a/package.json'), manifest);
  await writeFile(path.join(s.root, 'a/package-lock.json'), lock(version));
  let gate = { promise: Promise.resolve() };
  let requests = 0;
  s.current.httpClient.get = async () => { requests++; await gate.promise; return json({ name: 'react', version: '18.5.0' }); };
  s.current.httpClient.post = async () => { await gate.promise; return json({}); };
  s.current.auditRunner.run = async () => { await gate.promise; return { stdout: '{"vulnerabilities":{}}', exitCode: 0 }; };
  s.current.requestAutomaticUsageRefresh = () => {};
  discovery.resolve();
  t.after(() => discovery.resolve());
  return { s, hold() { gate = deferred(); t.after(() => gate.resolve()); return gate; }, requests: () => requests };
}

test('successful held reload publishes disk 1.0.2 as ready and eligible after an old-options ready scan', async t => {
  const f = await setup(t, false, '1.0.0'), s = f.s;
  await s.ready();
  await writeFile(path.join(s.root, 'a/package-lock.json'), lock('1.0.2'));
  const reloadGate = deferred(), entered = deferred();
  t.after(() => reloadGate.resolve());
  const load = s.current.loadProjectMeasured.bind(s.current);
  s.current.loadProjectMeasured = async (...args) => { entered.resolve(); await reloadGate.promise; return load(...args); };
  const c = s.current.controller;
  const refresh = s.refresh(); await entered.promise;
  const networkGate = f.hold(), before = f.requests(), start = s.posted.length;
  c.options.ttlMinutesProvider = () => 0;
  const ready = s.ready(); await until(() => f.requests() > before);
  reloadGate.resolve();
  await until(() => c.options.lockfileText.includes('1.0.2'));
  networkGate.resolve(); await Promise.all([refresh, ready]);
  assert.ok(s.posted.slice(start).some(m => m.status === 'ready' && m.data.rows[0].current === '1.0.2'));
  assert.equal(c.options.projectCacheStore.get(c.options.cacheKey).rows[0].current, '1.0.2');
  assert.equal(c.isEligible(), true);
});

async function verify(s, start, c, cachedAtStart) {
  assert.deepEqual(s.posted.slice(start).filter(m => 'data' in m && m.status !== 'stale'), [], 'obsolete scans never publish ready rows');
  assert.equal(c.options.projectCacheStore.get(c.options.cacheKey)?.generatedAt, cachedAtStart, 'obsolete scans never repopulate the cache');
  assert.equal(c.isEligible(), false);
  assert.equal(JSON.parse(await readFile(path.join(s.root, 'a/package-lock.json'), 'utf8')).packages['node_modules/react'].version, '18.4.0');
  if (s.current.controller !== c) return;
  // A later ready cannot replay a poisoned cache entry either.
  const replayStart = s.posted.length;
  c.options.ttlMinutesProvider = () => 30;
  await s.ready();
  assert.deepEqual(s.posted.slice(replayStart).filter(m => 'data' in m && m.status !== 'stale'), []);
  assert.equal(c.options.projectCacheStore.get(c.options.cacheKey)?.generatedAt, cachedAtStart);
}

test('old-options scan during a newer held refresh cannot publish or cache after the reload fails', async t => {
  const f = await setup(t), s = f.s;
  await s.ready();
  await writeFile(path.join(s.root, 'a/package-lock.json'), lock('18.4.0'));
  const reloadGate = deferred(), entered = deferred();
  t.after(() => reloadGate.resolve());
  s.current.loadProjectMeasured = async () => { entered.resolve(); await reloadGate.promise; throw Object.assign(new Error('held EACCES'), { code: 'EACCES' }); };
  const c = s.current.controller;
  const cachedAtStart = c.options.projectCacheStore.get(c.options.cacheKey)?.generatedAt;
  const refresh = s.refresh(); await entered.promise;
  const networkGate = f.hold(), before = f.requests(), start = s.posted.length;
  s.current.controller.options.ttlMinutesProvider = () => 0;
  const ready = s.ready(); await until(() => f.requests() > before);
  reloadGate.resolve(); await refresh;
  assert.ok(s.posted.slice(start).some(m => m.status === 'fatal-error' && m.error.message === 'held EACCES'));
  networkGate.resolve(); await ready;
  await verify(s, start, c, cachedAtStart);
});

for (const early of [false, true]) {
  test(`held ${early ? 'speculative startup' : 'full-load structural'} scan cannot publish or cache after failed watcher reload`, async t => {
    const f = await setup(t, early), s = f.s, gate = f.hold();
    const ready = s.ready(); await until(() => f.requests() > 0);
    const c = s.current.controller, start = s.posted.length;
    await writeFile(path.join(s.root, 'a/package-lock.json'), lock('18.4.0'));
    let failures = 0;
    s.current.loadProjectMeasured = async () => { failures++; throw Object.assign(new Error('reload EACCES'), { code: 'EACCES' }); };
    const watcher = s.watchers.find(w => !w.disposed && w.glob.includes('package-lock.json'));
    assert.ok(watcher);
    watcher.listener(path.join(s.root, 'a/package-lock.json'));
    await s.current.fileChangeCoordinator.flush();
    assert.equal(failures, 1);
    assert.equal(s.current.controller, c);
    gate.resolve(); await ready; await s.finished();
    await verify(s, start, c, undefined);
  });
}

test('old-project watcher during a held switch cannot strand the new project in loading', async t => {
  const s = await panel(t, { projects: ['a', 'b'], early: false });
  s.gate.resolve();
  s.current.requestAutomaticUsageRefresh = () => {};
  await s.ready();
  const c = s.current.controller;
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let targetReads = 0;
  const load = s.current.loadProjectMeasured.bind(s.current);
  s.current.loadProjectMeasured = async (...args) => {
    if (args[0].dir === 'b') { targetReads++; entered.resolve(); await release.promise; }
    return load(...args);
  };
  const start = s.posted.length;
  const switching = s.current.openManifest(path.join(s.root, 'b/package.json'));
  await entered.promise;
  const watcher = s.watchers.find(w => !w.disposed && w.base === path.join(s.root, 'a') && w.glob.includes('package-lock.json'));
  assert.ok(watcher);
  watcher.listener(path.join(s.root, 'a/package-lock.json'));
  release.resolve();
  await switching;
  // The switch itself must finish all required work. No extra read or ready
  // event is supplied by the test to rescue a stranded controller.
  assert.equal(targetReads, 1, 'an old-project watcher must not supersede the target read');
  assert.equal(s.current.selectedProject.dir, 'b');
  assert.equal(c.root, path.join(s.root, 'b'));
  assert.equal(s.current.fileChangeCoordinator.hasPending, false);
  assert.equal(s.current.fileChangeCoordinator.hasDeferred, false);
  assert.equal(s.posted.slice(start).filter(m => m.status === 'loading' || 'data' in m).at(-1)?.status, 'ready');
  assert.equal(s.snapshots().at(-1).data.project.manifestPath, 'b/package.json');
  assert.equal(c.isEligible(), true);
});

test('a newer read of the switch target requires an accepted reread before committing selection', async t => {
  const s = await panel(t, { projects: ['a', 'b'], early: false });
  s.gate.resolve();
  s.current.requestAutomaticUsageRefresh = () => {};
  await s.ready();
  const c = s.current.controller;
  const first = deferred(), second = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  t.after(() => { releaseFirst.resolve(); releaseSecond.resolve(); });
  const load = s.current.loadProjectMeasured.bind(s.current);
  let reads = 0;
  s.current.loadProjectMeasured = async (...args) => {
    assert.equal(args[0].dir, 'b');
    reads++;
    if (reads === 1) { first.resolve(); await releaseFirst.promise; }
    else { second.resolve(); await releaseSecond.promise; }
    return load(...args);
  };
  const switching = s.current.openManifest(path.join(s.root, 'b/package.json'));
  await first.promise;
  // Unlike A's watcher, a genuinely newer disk read of B supersedes this
  // snapshot. Starting that read alone need not have queued a B watcher.
  c.beginRevalidation(path.join(s.root, 'b'));
  releaseFirst.resolve();
  await until(() => reads === 2);
  await second.promise;
  assert.equal(s.current.selectedProject.dir, 'a');
  assert.equal(c.root, path.join(s.root, 'a'));
  assert.ok(s.watchers.some(w => !w.disposed && w.base === path.join(s.root, 'a') && w.glob.includes('package-lock.json')));
  releaseSecond.resolve();
  await switching;
  assert.equal(reads, 2);
  assert.equal(s.current.selectedProject.dir, 'b');
  assert.equal(c.root, path.join(s.root, 'b'));
  assert.equal(s.current.shownDashboardStatus, 'ready');
  assert.equal(c.isEligible(), true);
  assert.equal(s.current.fileChangeCoordinator.hasPending, false);
});
