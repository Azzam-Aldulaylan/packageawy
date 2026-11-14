import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { panel, manifest, lockfile } from './helpers/dashboard-startup.mjs';

for (const discovery of ['open-manifest', 'change-project', 'branch']) {
  test(`${discovery} discovery prunes removed roots from the live controller`, async t => {
    const projects = ['a', 'b', 'c', 'd'];
    const s = await panel(t, { projects, early: false });
    s.gate.resolve();
    s.current.requestAutomaticUsageRefresh = () => {};
    await s.ready();
    const c = s.current.controller;
    for (const name of ['b', 'c', 'd', 'a']) {
      await s.current.openManifest(path.join(s.root, name, 'package.json'));
    }
    assert.equal(c.diskReadGenerations.size, 4);
    for (const name of ['b', 'c', 'd']) {
      await rm(path.join(s.root, name), { recursive: true });
      projects.splice(projects.indexOf(name), 1);
      if (discovery === 'open-manifest') await s.current.openManifest(path.join(s.root, 'a/package.json'));
      else if (discovery === 'change-project') await s.current.changeProject();
      else {
        const generation = s.current.branchChangeCoordinator.notify();
        await s.current.reconcileAfterGitHeadChange(generation);
      }
      assert.equal(s.current.controller, c, 'discovery must retain the live controller');
      assert.deepEqual([...c.diskReadGenerations.keys()].sort(), projects.map(p => path.join(s.root, p)).sort());
    }
    assert.equal(c.diskReadGenerations.size, 1);
  });
}

test('removed and rediscovered roots never accept an old in-flight disk-read token', async t => {
  const projects = ['a', 'b'];
  const s = await panel(t, { projects, early: false });
  s.gate.resolve();
  s.current.requestAutomaticUsageRefresh = () => {};
  await s.ready();
  const c = s.current.controller, root = path.join(s.root, 'b');
  const oldToken = c.beginRevalidation(root);
  const oldSnapshot = { ...c.options, root, manifestText: '{ obsolete' };
  await rm(root, { recursive: true });
  projects.pop();
  await s.current.openManifest(path.join(s.root, 'a/package.json'));
  assert.equal(c.diskReadGenerations.has(root), false);
  assert.deepEqual(c.updateProjectSnapshot(oldSnapshot, oldToken), { structurallyCurrent: false });
  assert.deepEqual(c.updateProjectSnapshot(oldSnapshot, 0), { structurallyCurrent: false });

  await mkdir(root);
  await writeFile(path.join(root, 'package.json'), manifest);
  await writeFile(path.join(root, 'package-lock.json'), lockfile);
  projects.push('b');
  await s.current.openManifest(path.join(root, 'package.json'));
  assert.equal(c.root, root);
  assert.notEqual(c.diskReadGenerations.get(root), oldToken);
  assert.deepEqual(c.updateProjectSnapshot(oldSnapshot, oldToken), { structurallyCurrent: false });
  assert.equal(c.upgradeSource.manifestText, manifest);
  assert.equal(c.isEligible(), true);
});

test('removing the initial root revokes token-zero inputs for later scans too', async t => {
  const projects = ['a'];
  const s = await panel(t, { projects, early: false });
  s.gate.resolve();
  s.current.requestAutomaticUsageRefresh = () => {};
  await s.ready();
  const c = s.current.controller;
  assert.equal(c.scanInputsGeneration, 0);
  await rm(path.join(s.root, 'a'), { recursive: true });
  projects.pop();
  await s.current.openManifest(path.join(s.root, 'a/package.json'));
  assert.equal(c.diskReadGenerations.size, 0);
  const start = s.posted.length;
  const cache = c.options.projectCacheStore;
  let writes = 0;
  const set = cache.set.bind(cache);
  cache.set = (...args) => { writes++; set(...args); };
  const outcome = await c.handleRefresh(s.current.sink);
  assert.equal(outcome.status, 'superseded');
  assert.equal(writes, 0);
  assert.deepEqual(s.posted.slice(start).filter(m => 'data' in m && m.status !== 'stale'), []);
  assert.equal(c.isEligible(), false);
});
