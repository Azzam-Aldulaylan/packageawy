import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { resolvedTarget } from './helpers/mutation-target.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';
import { panel } from './helpers/dashboard-startup.mjs';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';

withoutFsync();
const codes = ['EINVAL', 'UNKNOWN', 'EBUSY', 'ENAMETOOLONG', 'EMFILE', 'ENETUNREACH'];

for (const packageManager of ['npm', 'pnpm']) {
  for (const code of codes) test(`confirmed remediation refuses ${packageManager} discovery ${code} before staging or dispatch`, async t => {
    const f = await rollbackFixture(t, 'transitive');
    if (packageManager === 'pnpm') {
      const lockfilePath = path.join(f.project.root, 'pnpm-lock.yaml');
      await io.rename(f.project.lockfilePath, lockfilePath);
      f.project.lockfilePath = lockfilePath;
      const read = f.coordinator.projectLoader;
      f.coordinator.projectLoader = async (...args) => ({ ...await read(...args), packageManager,
        lockfileName: 'pnpm-lock.yaml', mutationTarget: resolvedTarget(f.project.root, { packageManager }) });
      f.coordinator.remediationPlans.get('plan').snapshot = await f.coordinator.projectLoader();
    }
    const before = await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file, 'utf8')));
    let preparations = 0, mutations = 0, hits = 0;
    const prepare = f.coordinator.session.prepareLockfileReconciliation.bind(f.coordinator.session);
    f.coordinator.session.prepareLockfileReconciliation = (...args) => { preparations++; return prepare(...args); };
    const reserve = f.coordinator.reserve.bind(f.coordinator);
    f.coordinator.reserve = (...args) => {
      const handle = reserve(...args);
      const begin = handle.beginMutation.bind(handle);
      handle.beginMutation = (...params) => { mutations++; return begin(...params); };
      return handle;
    };
    const error = Object.assign(new Error(`discovery ${code}`), { code });
    // Keep the POSIX directory fault and reach Windows through its candidate stat.
    for (const method of packageManager === 'npm' ? ['readdirSync', 'statSync'] : ['readFileSync']) {
      const original = fs[method];
      fs[method] = (file, ...args) => {
        if (hits === 0 && (packageManager === 'npm' || file === f.project.manifestPath)) { hits++; throw error; }
        return original(file, ...args);
      };
      syncBuiltinESMExports();
      t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
    }

    await f.confirm();

    assert.equal(hits, 1, 'the one-shot fault must reach confirmed discovery');
    assert.equal(preparations, 0, 'discovery must stop before preparing a task');
    assert.equal(mutations, 0, 'discovery must stop before creating a journal or staging files');
    assert.deepEqual(f.requests, []);
    assert.deepEqual(await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file, 'utf8'))), before);
    assert.equal(fs.existsSync(path.join(f.project.root, '.packageawy-recovery')), false);
    assert.equal(f.coordinator.reservation.held, undefined);
    assert.deepEqual(f.messages.filter(message => message.error).map(message => ({ status: message.status, error: message.error })),
      [{ status: 'remediation-error', error: { code: 'Error', message: error.message } }]);
    assert.equal(f.messages.some(message => message.status === 'remediation-applying' || message.status === 'remediation-apply-result'), false);
  });
}

for (const operation of ['removal', 'cleanup', 'upgrade', 'transitive']) {
  for (const probe of ['root key', 'registry key']) {
    for (const code of codes) test(`confirmed ${operation} refuses ${probe} ${code} even after caching the review key`, async t => {
      // restartState describes the whole registry, including retained owners from earlier tests.
      const f = await rollbackFixture(t, operation, { mutationLocks: new ProjectMutationLocks() });
      f.coordinator.currentMutationRootKey();
      const before = await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file, 'utf8')));
      const error = Object.assign(new Error(`confirmation ${probe} ${code}`), { code });
      const original = fs.realpathSync.native;
      let calls = 0, hits = 0, mutations = 0;
      fs.realpathSync.native = (...args) => {
        if (++calls === (probe === 'root key' ? 1 : 2)) { hits++; throw error; }
        return original(...args);
      };
      syncBuiltinESMExports();
      t.after(() => { fs.realpathSync.native = original; syncBuiltinESMExports(); });
      const reserve = f.coordinator.reserve.bind(f.coordinator);
      f.coordinator.reserve = (...args) => {
        const handle = reserve(...args);
        if (handle.ok) {
          const begin = handle.beginMutation.bind(handle);
          handle.beginMutation = (...params) => { mutations++; return begin(...params); };
        }
        return handle;
      };

      await f.confirm();

      assert.equal(hits, 1, 'the one-shot fault must reach confirmed lock admission');
      assert.equal(mutations, 0);
      assert.deepEqual(f.requests, []);
      assert.equal(f.coordinator.reservation.held, undefined);
      assert.equal(f.coordinator.mutationLocks.restartState(), 'idle');
      assert.deepEqual(await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file, 'utf8'))), before);
      const status = operation === 'upgrade' ? 'upgrade-error' : operation === 'transitive' ? 'remediation-error' : 'remove-error';
      assert.deepEqual(f.messages.filter(message => message.error).map(message => ({ status: message.status, error: message.error })),
        [{ status, error: { code: 'Error', message: error.message } }]);
    });
  }
}

for (const code of codes) test(`review reservation keeps graceful lock admission with ${code}`, async t => {
  const f = await rollbackFixture(t, 'removal');
  f.coordinator.canonicalRootCache = undefined;
  const original = fs.realpathSync.native;
  let hits = 0;
  fs.realpathSync.native = () => { hits++; throw Object.assign(new Error(`review ${code}`), { code }); };
  syncBuiltinESMExports();
  t.after(() => { fs.realpathSync.native = original; syncBuiltinESMExports(); });
  const handle = f.coordinator.reserve('read-only review');
  assert.equal(handle.ok, true);
  assert.equal(hits, 2, 'both root and registry canonicalization must use the graceful mode');
  await handle.releaseReadOnly();
  assert.equal(f.coordinator.reservation.held, undefined);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.messages.filter(message => message.error), []);
});

for (const strict of [false, true]) {
  for (const code of codes) test(`controller recreation keeps ${strict ? 'confirmed strict' : 'read-only graceful'} discovery with ${code}`, async t => {
    const s = await panel(t, { early: false });
    // A confirmation arrives after webview delivery is open, even if its controller needs recreating.
    s.current.deliveryReady = true;
    const root = await io.realpath(s.root);
    const error = Object.assign(new Error(`controller discovery ${code}`), { code });
    const original = io.lstat;
    let hits = 0;
    io.lstat = async (file, ...args) => {
      if (hits === 0 && file === path.join(root, 'a', 'npm-shrinkwrap.json')) { hits++; throw error; }
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    t.after(() => { io.lstat = original; syncBuiltinESMExports(); });
    const controller = await s.current.upgradeCoordinator.options.ensureController(strict);
    assert.equal(hits, 1);
    if (strict) {
      assert.equal(controller, undefined, 'confirmation must stop when fallback controller loading fails');
      assert.deepEqual(s.posted.filter(message => message.error).map(message => message.error), [{ code: 'Error', message: error.message }]);
    } else {
      assert.ok(controller, 'read-only controller loading keeps its graceful fallback');
      assert.deepEqual(s.posted.filter(message => message.error), []);
    }
  });
}

for (const operation of ['removal', 'cleanup', 'upgrade']) {
  for (const code of codes) test(`confirmed ${operation} requests strict controller recreation with ${code}`, async t => {
    const f = await rollbackFixture(t, operation);
    const error = Object.assign(new Error(`controller reload ${code}`), { code });
    let hits = 0;
    f.coordinator.options.ensureController = async strict => {
      assert.equal(strict, true);
      hits++;
      throw error;
    };
    await f.confirm();
    assert.equal(hits, 1);
    assert.equal(f.coordinator.reservation.held, undefined);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error), [{ code: 'Error', message: error.message }]);
    assert.equal(fs.existsSync(path.join(f.project.root, '.packageawy-recovery')), false);
  });
}
