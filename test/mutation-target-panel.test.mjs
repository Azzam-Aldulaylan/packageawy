/**
 * The dashboard with a real project load: a refused mutation target shows
 * its reason, keeps the dashboard usable for viewing, refuses changes as an
 * expected answer (never the internal-error pause), and the watchers cover
 * every file the target is resolved from.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DashboardPanel } from '../out/host/dashboardPanel.js';
import { OUTSIDE_FOLDER_REASON } from '../out/host/mutationTarget.js';
import { lockfile, panel, until } from './helpers/dashboard-startup.mjs';

test('a workspace member opened as the folder shows the reason and refuses changes without pausing', async (t) => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-member-folder-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }));
  await writeFile(path.join(repo, 'package-lock.json'), lockfile);
  const opened = path.join(repo, 'packages');
  await mkdir(opened, { recursive: true });

  const s = await panel(t, { workspace: opened });
  s.gate.resolve();
  await s.ready();
  await until(() => s.snapshots().length > 0);
  const data = s.snapshots().at(-1).data;
  assert.equal(data.readOnlyReason, OUTSIDE_FOLDER_REASON);
  assert.ok(data.rows.length > 0, 'the dashboard still shows the dependencies');

  await DashboardPanel.dispatchIntegrationTestMessage({ type: 'upgrade', requestId: 'r', package: 'clean-pkg', target: '1.0.1' });
  await until(() => s.posted.some((message) => message.status === 'upgrade-error'));
  const refused = s.posted.find((message) => message.status === 'upgrade-error');
  assert.deepEqual(refused.error, { code: 'CHANGES_UNAVAILABLE', message: OUTSIDE_FOLDER_REASON });
  assert.equal(s.posted.some((message) => message.status === 'runtime-error'), false);
  assert.equal(s.current.runtimeFailed, false, 'an expected refusal never pauses changes');
});

test('watchers cover every file the mutation target is resolved from inside the folder', async (t) => {
  const s = await panel(t, { projects: ['packages/app'], target: 'packages/app' });
  s.gate.resolve();
  await s.ready();
  await until(() => s.snapshots().length > 0);
  const live = s.watchers.filter((watcher) => !watcher.disposed);
  const globsAt = (dir) => live.filter((watcher) => watcher.base === path.join(s.root, dir)).map((watcher) => watcher.glob).join(' ');
  for (const dir of ['', 'packages']) {
    for (const name of ['package.json', '.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.pnpmfile.mjs']) {
      assert.ok(globsAt(dir).includes(name), `${name} is watched at ${dir || 'the folder root'}`);
    }
  }
  for (const name of ['pnpm-workspace.yaml', '.pnpmfile.cjs', '.npmrc', 'package.json']) {
    assert.ok(globsAt('packages/app').includes(name), `${name} is watched in the project`);
  }
});

test('sibling workspace members key the change lock by the workspace root', async (t) => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-lock-root-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }));
  const s = await panel(t, { workspace: repo, projects: ['packages/app', 'packages/lib'], target: 'packages/app' });
  s.gate.resolve();
  await s.ready();
  await until(() => s.snapshots().length > 0);
  assert.equal(s.current.controller.root, path.join(repo, 'packages/app'));
  assert.equal(s.current.upgradeCoordinator.options.mutationRoot(), repo);
});
