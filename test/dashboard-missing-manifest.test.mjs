import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dashboardError, isMissingManifest } from '../out/host/dashboardError.js';
import { describeRejection, describeBulkRejection, describeBulkRemoveRejection } from '../out/core/upgrade/validate.js';
import { MISSING_MANIFEST_MESSAGE, PROJECT_UNAVAILABLE_MESSAGE } from '../out/core/upgrade/projectLoadCopy.js';
import { panel, manifest, lockfile, deferred } from './helpers/dashboard-startup.mjs';

for (const filename of [path.join('project', 'package.json'), path.win32.join('C:\\', 'Users', 'owner', 'project', 'package.json'), path.posix.join(path.posix.sep, 'Users', 'owner', 'project', 'package.json')]) {
  test(`missing manifest copy hides the path: ${filename}`, () => {
    const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${filename}'`), { code: 'ENOENT', path: filename });
    assert.equal(isMissingManifest(error), true);
    assert.deepEqual(dashboardError(error), { code: 'MISSING_MANIFEST', message: MISSING_MANIFEST_MESSAGE });
  });
}

test('other runtime errors never expose paths or raw content in dashboard banners', () => {
  for (const error of [Object.assign(new Error(path.join(path.sep, 'Users', 'owner', '.npmrc')), { code: 'EACCES' }), new Error(path.win32.join('C:\\', 'Users', 'owner', 'secret')), path.join(path.sep, 'home', 'owner', 'project'), { message: path.join(path.sep, 'private', 'secret') }]) {
    assert.equal(dashboardError(error).message, PROJECT_UNAVAILABLE_MESSAGE);
  }
  assert.equal(isMissingManifest({ code: 'ENOENT', path: path.join('package.json', 'other') }), false);
  assert.doesNotMatch(dashboardError(new SyntaxError(`${path.join(path.sep, 'Users', 'owner', 'package.json')}: private content`)).message, /owner|private content/);
});

for (const watcher of [false, true]) {
  test(`deleted manifest settles failed ${watcher ? 'watcher' : 'manual'} refresh and blocks Analyze until recovery`, async t => {
    const s = await panel(t);
    s.gate.resolve();
    await s.finished();
    await s.ready();
    const controller = s.current.controller;
    const request = { package: 'clean-pkg', target: '1.0.1' };
    const logs = [];
    s.platform.log = line => logs.push(line);
    await rm(path.join(s.root, 'a', 'package.json'));
    if (watcher) await s.current.reloadAfterFileChange(new Set(['manifest']), s.current.reloadGeneration);
    else await s.refresh();
    assert.equal(s.posted.at(-1).status, 'fatal-error');
    assert.equal(s.posted.at(-1).error.message, MISSING_MANIFEST_MESSAGE);
    assert.ok(logs.some(line => line.includes('ENOENT') && line.includes(s.root)), 'full local error stays in the log');
    assert.equal(controller.isEligible(), false);
    assert.deepEqual(controller.validateUpgradeRequest(request), { ok: false, reason: 'missing-manifest' });
    assert.equal(describeBulkRejection(controller.validateBulkUpgradeRequest([request])).message, MISSING_MANIFEST_MESSAGE);
    assert.equal(describeBulkRemoveRejection(controller.validateBulkRemoveRequest([{ package: 'clean-pkg' }])).message, MISSING_MANIFEST_MESSAGE);
    await s.current.upgradeCoordinator.handleAnalyzeUpgrade({ type: 'upgrade', requestId: 'deleted-manifest', ...request });
    assert.equal(s.posted.at(-1).error.message, MISSING_MANIFEST_MESSAGE);
    await writeFile(path.join(s.root, 'a', 'package.json'), manifest);
    await s.refresh();
    assert.equal(controller.isEligible(), true);
    assert.notEqual(controller.validateUpgradeRequest(request).reason, 'missing-manifest');
  });
}

for (const watcher of [false, true]) {
  for (const replay of ['ready', 'timer']) {
    test(`settled ${watcher ? 'watcher' : 'manual'} missing manifest survives ${replay} until a successful disk read`, async t => {
      const s = await panel(t, { ttl: 0 });
      s.gate.resolve(); await s.finished(); await s.ready();
      const c = s.current.controller;
      const manifestPath = path.join(s.root, 'a', 'package.json');
      await rm(manifestPath);
      if (watcher) await s.current.reloadAfterFileChange(new Set(['manifest']), s.current.reloadGeneration);
      else await s.refresh();
      const failure = { status: 'fatal-error', error: { code: 'MISSING_MANIFEST', message: MISSING_MANIFEST_MESSAGE } };
      assert.deepEqual(s.posted.at(-1), failure);
      const requests = s.client.requests.length;
      const start = s.posted.length;
      if (replay === 'ready') {
        await s.ready();
        assert.deepEqual(s.posted.slice(start).filter(message => message.status === 'fatal-error'), [failure]);
      } else {
        s.current.onBackgroundTick();
        assert.equal(c.needsBackgroundRefresh(), false, 'a timer cannot recover failed disk inputs');
        assert.deepEqual(await c.refreshInBackground(s.current.sink, 'time'), { status: 'failed', error: failure.error });
      }
      assert.deepEqual(s.posted.slice(start).filter(message => ['stale', 'loading', 'scan-progress'].includes(message.status)), []);
      assert.deepEqual(s.posted.at(-1), failure);
      assert.equal(s.current.shownDashboardStatus, 'fatal-error');
      assert.equal(s.client.requests.length, requests, 'no network scan uses the retained disk inputs');
      assert.equal(c.scanRunning(), false);
      assert.equal(c.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason, 'missing-manifest');
      const retainedRows = c.lastResultEvidence();
      assert.deepEqual(await c.handleRefresh(s.current.sink), { status: 'failed', error: failure.error });
      assert.deepEqual(c.lastResultEvidence(), retainedRows, 'a scan without a new disk read retains recovery evidence');

      // Restoring the file alone does not confirm it. Hold the next disk read
      // to exercise ready and timer replays during recovery as well.
      await writeFile(manifestPath, manifest);
      const entered = deferred(), release = deferred();
      t.after(() => release.resolve());
      const load = s.current.loadProjectMeasured.bind(s.current);
      s.current.loadProjectMeasured = async (...args) => {
        entered.resolve(); await release.promise; return load(...args);
      };
      const recovery = s.refresh();
      await entered.promise;
      await s.ready();
      assert.deepEqual(s.posted.at(-1), failure, 'only a completed disk read clears the error');
      assert.deepEqual(await c.refreshInBackground(s.current.sink, 'time'), { status: 'failed', error: failure.error });
      assert.equal(c.isEligible(), false);
      release.resolve(); await recovery;
      assert.equal(c.isEligible(), true);
      assert.equal(s.current.shownDashboardStatus, 'ready');
      assert.equal(c.needsBackgroundRefresh(), true, 'timed scans resume after disk recovery');
      await s.ready();
      assert.equal(s.current.shownDashboardStatus, 'ready');
    });
  }
}

for (const lockfileName of ['package-lock.json', 'npm-shrinkwrap.json']) {
  test(`unsupported ${lockfileName} uses an accurate npm lockfile banner`, async t => {
    const s = await panel(t, { early: false });
    s.gate.resolve();
    await writeFile(path.join(s.root, 'a', lockfileName), lockfile.replace('"lockfileVersion":3', '"lockfileVersion":99'));
    await s.ready();
    assert.equal(s.controllers.at(-1).upgradeSource.lockfileName, lockfileName);
    assert.deepEqual(s.posted.at(-1), { status: 'fatal-error', error: {
      code: 'UnsupportedLockfileError',
      message: 'Unsupported npm lockfile version. Supported versions are 1, 2 and 3.',
    } });
  });
}

test('superseded failed disk reads cannot override a newer read or restore eligibility', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished(); await s.ready();
  const c = s.current.controller;
  const oldToken = c.beginRevalidation();
  c.beginRevalidation();
  c.settleProjectLoadFailure({ code: 'ENOENT', path: path.join(s.root, 'a', 'package.json') }, path.join(s.root, 'a'), oldToken);
  assert.equal(c.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason, 'revalidating');
  assert.equal(c.isEligible(), false);
});

test('settled unreadable project rejects changes without asking users to wait indefinitely', () => {
  assert.equal(describeRejection('project-unavailable').message, PROJECT_UNAVAILABLE_MESSAGE);
});

test('diagnostic logging keeps full details locally and cannot break the plain error', () => {
  const logs = [];
  const cause = new Error(`open ${path.join(path.sep, 'Users', 'owner', 'project', 'package.json')}`);
  dashboardError(cause, line => logs.push(line));
  assert.ok(logs[0].includes(cause.message));
  assert.equal(dashboardError(cause, () => { throw new Error('log failed'); }).message, PROJECT_UNAVAILABLE_MESSAGE);
});

test('an invalid manifest settles as unreadable and a successful Refresh recovers', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished(); await s.ready();
  await writeFile(path.join(s.root, 'a', 'package.json'), '{');
  await s.refresh();
  assert.equal(s.posted.at(-1).error.code, 'SyntaxError');
  const failure = s.posted.at(-1);
  await s.ready();
  assert.deepEqual(s.posted.at(-1), failure, 'ready preserves the precise settled format error');
  assert.deepEqual(await s.current.controller.refreshInBackground(s.current.sink, 'time'), { status: 'failed', error: failure.error });
  const result = s.current.controller.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' });
  assert.equal(result.reason, 'project-unavailable');
  assert.equal(s.current.controller.isEligible(), false);
  await writeFile(path.join(s.root, 'a', 'package.json'), manifest);
  await s.refresh();
  assert.equal(s.current.controller.isEligible(), true);
});

for (const watcher of [false, true]) {
  test(`a superseded ${watcher ? 'watcher' : 'manual'} load failure cannot replace a newer pending refresh`, async t => {
    const s = await panel(t);
    s.gate.resolve(); await s.finished(); await s.ready();
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const c = s.current.controller;
    s.current.loadProjectMeasured = async () => {
      entered.resolve(); await release.promise;
      throw Object.assign(new Error('held missing manifest'), { code: 'ENOENT', path: path.join(s.root, 'a', 'package.json') });
    };
    const pending = watcher
      ? s.current.reloadAfterFileChange(new Set(['manifest']), s.current.reloadGeneration)
      : s.refresh();
    await entered.promise;
    c.beginRevalidation();
    const start = s.posted.length;
    release.resolve(); await pending;
    assert.equal(c.isEligible(), false);
    assert.equal(c.validateUpgradeRequest({ package: 'clean-pkg', target: '1.0.1' }).reason, 'revalidating');
    assert.deepEqual(s.posted.slice(start).filter(message => message.status === 'fatal-error'), []);
  });
}
