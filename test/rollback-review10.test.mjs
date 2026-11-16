import assert from 'node:assert/strict';
import { test } from 'node:test';
import io from 'node:fs/promises';
import path from 'node:path';
import { completedFixture, fault } from './helpers/completed-refresh.mjs';
import { panel, deferred, until } from './helpers/dashboard-startup.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';

withoutFsync();
const denied = () => Object.assign(new Error('discovery EACCES'), { code: 'EACCES' });
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const views = s => s.posted.filter(message => ['loading', 'fatal-error', 'ready', 'empty', 'stale'].includes(message.status));

async function invalidated(t) {
  const f = await completedFixture(t, 'upgrade');
  const old = f.s.current.controller;
  const generation = f.s.current.reloadGeneration;
  const injected = fault(t, f, 'EMFILE');
  await f.confirm();
  injected.reached();
  return { ...f, oldController: old, previousGeneration: generation };
}

test('failed completion refresh discards controller, cache, selection and watchers', async t => {
  const { s, oldController, previousGeneration } = await invalidated(t);
  assert.ok(s.current.reloadGeneration > previousGeneration);
  assert.equal(oldController.disposed, true);
  assert.equal(oldController.options.projectCacheStore.get(oldController.options.cacheKey), undefined);
  assert.equal(s.current.controller, undefined);
  assert.equal(s.current.selectedProject, undefined);
  assert.equal(s.watchers.every(watcher => watcher.disposed), true);
});

function holdScan(t, s) {
  const gate = deferred(), entered = deferred();
  const get = s.current.httpClient.get;
  s.current.httpClient.get = async (...args) => {
    entered.resolve();
    await gate.promise;
    return get(...args);
  };
  t.after(() => gate.resolve());
  return { gate, entered };
}

for (const competing of ['failed', 'held']) test(`superseded full-load scan cannot publish or persist during a ${competing} competing refresh`, async t => {
  const { s, project } = await invalidated(t);
  const held = holdScan(t, s);
  const replay = s.ready();
  await held.entered.promise;
  const older = s.current.controller;
  assert.equal(older.upgradeSource.lockfileText.includes('18.3.0'), true);
  await io.writeFile(project.lockfilePath, (await io.readFile(project.lockfilePath, 'utf8')).replaceAll('18.3.0', '18.4.0'));
  const load = s.current.loadProjectMeasured.bind(s.current);
  const readGate = deferred(), readEntered = deferred();
  t.after(() => readGate.resolve());
  s.current.loadProjectMeasured = async (...args) => {
    readEntered.resolve();
    if (competing === 'failed') throw denied();
    await readGate.promise;
    return load(...args);
  };
  const refresh = s.refresh();
  await readEntered.promise;
  if (competing === 'failed') await refresh;
  const start = s.posted.length;
  held.gate.resolve();
  await replay;
  assert.equal(s.posted.slice(start).some(message => 'data' in message), false, 'supersession is checked before controller publication');
  assert.equal(older.options.projectCacheStore.get(older.options.cacheKey), undefined, 'superseded results cannot repopulate cache');
  s.current.loadProjectMeasured = load;
  readGate.resolve();
  await refresh;
  await s.ready();
  assert.equal(s.snapshots().at(-1).data.rows.find(row => row.name === 'react').current, '18.4.0');
});

for (const retry of ['ready', 'refresh', 'tick']) test(`branch discovery failure after invalidation recovers through ordinary ${retry} discovery and selection`, async t => {
  const { s } = await invalidated(t);
  const find = s.platform.findFiles;
  let attempts = 0;
  s.platform.findFiles = async search => {
    if (search.include === '**/package.json' && ++attempts === 1) throw denied();
    return find(search);
  };
  s.current.onGitHeadChanged();
  await s.current.reconcileAfterGitHeadChange(s.current.branchChangeCoordinator.generation);
  assert.equal(s.current.selectedProject, undefined);
  assert.equal(s.current.controller, undefined);
  assert.equal(views(s).at(-1).error.code, 'BranchReconciliationError');
  const start = s.posted.length;
  if (retry === 'tick') {
    s.current.onBackgroundTick();
    await until(() => s.current.controller?.isEligible());
  } else if (retry === 'ready') await s.ready();
  else await s.refresh();
  assert.equal(attempts, 2);
  assert.equal(s.posted.slice(start).find(message => message.status === 'loading')?.status, 'loading');
  assert.equal(s.snapshots().at(-1).data.rows.find(row => row.name === 'react').current, '18.3.0');
});

test('invalidation discovers changed project topology and asks for a fresh selection', async t => {
  const { s, project } = await invalidated(t);
  const other = path.join(project.root, 'new-project');
  await io.mkdir(other);
  await io.copyFile(project.manifestPath, path.join(other, 'package.json'));
  await io.copyFile(project.lockfilePath, path.join(other, 'package-lock.json'));
  const find = s.platform.findFiles;
  s.platform.findFiles = search => search.include === '**/package.json'
    ? Promise.resolve([project.manifestPath, path.join(other, 'package.json')]) : find(search);
  let picks = 0;
  s.platform.showQuickPick = async items => { picks++; return items[1].value; };
  await s.ready();
  assert.equal(picks, 1);
  assert.equal(s.current.controller.root, other);
  assert.equal(s.current.selectedProject.manifestPath, 'new-project/package.json');
  assert.equal(s.snapshots().at(-1).data.rows.find(row => row.name === 'react').current, '18.3.0');
});

for (const stage of ['discovery', 'disk', 'scan']) test(`persistent ${stage} failure retries once per tick with loading/error and no old rows`, async t => {
  const { s, project } = await invalidated(t);
  const start = s.posted.length;
  const find = s.platform.findFiles;
  let attempts = 0;
  s.platform.findFiles = async search => {
    if (search.include === '**/package.json') {
      attempts++;
      if (stage === 'discovery') throw denied();
    }
    return find(search);
  };
  if (stage === 'disk') await io.rm(project.manifestPath);
  if (stage === 'scan') await io.writeFile(project.lockfilePath, '{');
  for (let tick = 1; tick <= 3; tick++) {
    s.current.onBackgroundTick();
    await until(() => attempts === tick && s.current.pending === undefined);
    await pause();
    assert.equal(attempts, tick);
    assert.equal(s.current.controller, undefined);
    assert.equal(views(s).at(-1).status, 'fatal-error');
  }
  assert.equal(s.posted.slice(start).some(message => 'data' in message), false);
  assert.equal(s.posted.slice(start).filter(message => message.status === 'loading').length >= 3, true);
  s.close();
  const end = s.posted.length;
  s.current.onBackgroundTick();
  await pause();
  assert.equal(attempts, 3);
  assert.equal(s.posted.length, end);
});

for (const stage of ['discovery', 'scan']) test(`dispose during invalidated ${stage} stops all further work and publication`, async t => {
  const { s } = await invalidated(t);
  const gate = deferred(), entered = deferred();
  let held;
  if (stage === 'discovery') {
    const find = s.platform.findFiles;
    s.platform.findFiles = async search => {
      const result = find(search);
      if (search.include === '**/package.json') { entered.resolve(); await gate.promise; }
      return result;
    };
  } else held = holdScan(t, s);
  const replay = s.ready();
  await (held?.entered.promise ?? entered.promise);
  s.close();
  const start = s.posted.length, searches = s.searches.length;
  gate.resolve();
  held?.gate.resolve();
  await replay;
  s.current.onBackgroundTick();
  await pause();
  assert.equal(s.posted.length, start);
  // A completed held discovery can return its result, but cannot start any new searches.
  assert.equal(s.searches.length, searches);
  assert.equal(s.current.controller, undefined);
});

for (const early of [true, false]) test(`normal cached reopen adds no discovery, loading or network work (speculative startup ${early})`, async t => {
  const s = await panel(t, { early });
  s.gate.resolve();
  await s.ready();
  const searches = s.searches.length, requests = s.client.requests.length, controllers = s.controllers.length;
  const start = s.posted.length;
  await s.ready();
  assert.equal(s.searches.length, searches);
  assert.equal(s.client.requests.length, requests);
  assert.equal(s.controllers.length, controllers);
  assert.equal(s.posted.slice(start).some(message => message.status === 'loading'), false);
  assert.equal(s.snapshots().at(-1).status, 'ready');
});
