import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import io from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { panel, until } from './helpers/dashboard-startup.mjs';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';
import { RestoreFileError } from '../out/host/upgradeTransaction.js';
import { loadProject } from '../out/host/projectResolution.js';
import { resolveMutationTarget } from '../out/host/mutationTarget.js';
import { lockKey, authorizedRelation } from '../out/host/pathIdentity.js';
import { createNodeNpmResolverDeps, rethrowUnexpectedResolverError } from '../out/host/npmResolver.js';
import { createNodeNpmResolverAsyncDeps, resolveNpmInvocationAsync } from '../out/host/npmResolverAsync.js';
import { ResolvedNpmAuditRunner } from '../out/host/npmAuditRunner.js';
import { resolvePnpmInvocation } from '../out/host/pnpmResolver.js';

withoutFsync();
const codes = ['EINVAL', 'UNKNOWN', 'EBUSY', 'ENAMETOOLONG', 'EMFILE', 'ENETUNREACH'];
const failure = code => Object.assign(new Error(`filesystem ${code}`), { code });
function patch(t, target, name, replacement) {
  const original = target[name];
  target[name] = replacement(original);
  syncBuiltinESMExports();
  t.after(() => { target[name] = original; syncBuiltinESMExports(); });
}
const environment = root => ({ env: {}, homeDir: path.join(root, 'home'), platform: 'linux', nodePrefixes: [] });

for (const code of codes) {
  for (const source of ['optional npmrc', 'mutation target', 'npm discovery', 'lock key']) {
    test(`dashboard loads and refreshes through real ${source} wiring with ${code}`, async t => {
      const error = failure(code);
      let hits = 0;
      if (source === 'optional npmrc') patch(t, io, 'readFile', original => async (file, ...args) => {
        if (String(file).endsWith('/.npmrc')) { hits++; throw error; }
        return original(file, ...args);
      });
      if (source === 'mutation target') patch(t, io, 'lstat', original => async (file, ...args) => {
        if (String(file).endsWith('/npm-shrinkwrap.json')) { hits++; throw error; }
        return original(file, ...args);
      });
      if (source === 'npm discovery') {
        for (const name of ['accessSync', 'readdirSync']) patch(t, fs, name, () => () => { hits++; throw error; });
      }
      if (source === 'lock key') patch(t, fs.realpathSync, 'native', () => () => { hits++; throw error; });
      const s = await panel(t, { early: false });
      if (source === 'npm discovery') {
        // Keep the production async discovery and audit runner. Only its final subprocess is fake.
        const runner = new ResolvedNpmAuditRunner({ platform: 'linux',
          resolve: (cwd, signal) => resolveNpmInvocationAsync(createNodeNpmResolverAsyncDeps(cwd, signal)),
          createRunner: () => ({ run: s.client.run }),
        });
        s.current.auditRunner.run = runner.run.bind(runner);
      }
      s.gate.resolve();
      await s.ready();
      await until(() => s.snapshots().length > 0);
      if (source === 'mutation target') assert.equal(s.current.controller.upgradeSource.mutationTarget.ok, false);
      if (source === 'lock key') s.current.upgradeCoordinator.canonicalRootCache = undefined;
      // An uncached busy check is part of the production refresh admission path.
      await s.refresh();
      assert.ok(s.snapshots().length >= 2);
      if (source === 'npm discovery') assert.ok(s.client.requests.filter(request => request.kind === 'audit').length >= 2,
        'graceful discovery must reach the POSIX audit fallback on load and refresh');
      assert.ok(hits >= 2, 'the filesystem fault must be reached during load and refresh');
      assert.equal(s.current.runtimeFailed, false);
      assert.equal(s.current.backgroundStopped, false);
      assert.equal(s.posted.some(message => message.status === 'runtime-error' || message.status === 'fatal-error'), false);
      assert.ok(s.snapshots().at(-1).data.rows.length > 0);
    });
  }

  test(`pnpm config reads refuse gracefully by default and propagate in strict mode with ${code}`, async t => {
    const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}' });
    await io.rename(f.lockfile, path.join(f.root, 'pnpm-lock.yaml'));
    await io.writeFile(path.join(f.root, 'pnpm-workspace.yaml'), 'packages: []');
    const error = failure(code);
    patch(t, io, 'readFile', original => async (file, ...args) => {
      if (file === path.join(f.root, '.npmrc')) throw error;
      return original(file, ...args);
    });
    const input = { projectDir: f.root, folderPath: f.root, packageManager: 'pnpm', environment: environment(f.root) };
    assert.equal((await resolveMutationTarget(input)).ok, false);
    await assert.rejects(resolveMutationTarget({ ...input, throwOnUnexpectedError: true }), cause => cause === error);
  });

  test(`npm discovery preserves graceful and strict modes for every probe with ${code}`, t => {
    for (const step of ['isExecutable', 'listDir', 'resolveRealNodePath', 'resolveGlobalNpmRoot', 'probeVersion', 'probeLoginShellNode']) {
      const method = step === 'isExecutable' ? 'accessSync' : step === 'listDir' ? 'readdirSync' : 'execFileSync';
      const target = method === 'execFileSync' ? childProcess : fs;
      const original = target[method];
      const originalExists = fs.existsSync, originalStat = fs.statSync;
      // Plain errno objects also get the read-only fallback.
      const error = { code };
      target[method] = () => { throw error; };
      fs.existsSync = () => true;
      fs.statSync = () => ({});
      syncBuiltinESMExports();
      try {
        const graceful = createNodeNpmResolverDeps(process.cwd());
        const strict = createNodeNpmResolverDeps(process.cwd(), true);
        const expected = step === 'isExecutable' ? false : step === 'listDir' ? [] : undefined;
        assert.deepEqual(graceful[step]('/installation/node', '/installation/npm-cli.js'), expected);
        assert.throws(() => strict[step]('/installation/node', '/installation/npm-cli.js'), cause => cause === error);
      } finally {
        target[method] = original;
        fs.existsSync = originalExists;
        fs.statSync = originalStat;
        syncBuiltinESMExports();
      }
    }
    assert.doesNotThrow(() => rethrowUnexpectedResolverError({ code }, false));
    assert.throws(() => rethrowUnexpectedResolverError({ code }, true));
    for (const strict of [false, true]) {
      const deps = { platform: 'linux', cwd: '/project', pathEnv: '/installation', exists: () => true,
        probe: () => '10.0.0', realpath: () => { throw { code }; }, throwOnUnexpectedError: strict };
      if (strict) assert.throws(() => resolvePnpmInvocation(null, deps));
      else assert.equal(resolvePnpmInvocation(null, deps), null);
    }
  });

  test(`path identity preserves fallback only in graceful mode with ${code}`, async t => {
    const error = failure(code);
    patch(t, fs.realpathSync, 'native', () => () => { throw error; });
    assert.equal(lockKey('/project'), path.resolve('/project').toLowerCase());
    assert.throws(() => lockKey('/project', true), cause => cause === error);
    const system = { path, realpath: async () => { throw error; } };
    assert.equal(await authorizedRelation('/project', '/project/file', system), 'unresolved');
    await assert.rejects(authorizedRelation('/project', '/project/file', system, true), cause => cause === error);
  });

  for (const operation of ['removal', 'cleanup', 'upgrade', 'transitive']) {
    test(`${operation} real rollback project loader fences ${code} in optional npmrc`, async t => {
      const f = await rollbackFixture(t, operation);
      const original = f.coordinator.projectLoader;
      let hits = 0;
      f.coordinator.options.platform.findFiles = async () => [f.project.lockfilePath];
      f.coordinator.projectLoader = async (selected, strict) => {
        if (f.coordinator.reservation.held?.journal?.data.step !== 'rollback') return original(selected, strict);
        assert.equal(strict, true, 'restore guard must opt into strict loading');
        return loadProject(f.coordinator.options.platform, { ...selected, manifestPath: 'package.json' }, undefined, environment(f.project.root), strict);
      };
      patch(t, io, 'readFile', originalRead => async (file, ...args) => {
        if (file === path.join(f.project.root, '.npmrc')) { hits++; throw failure(code); }
        return originalRead(file, ...args);
      });
      await f.confirm();
      assert.ok(hits > 0);
      const handle = f.coordinator.reservation.held;
      assert.equal(handle.state, 'unknown');
      assert.equal(handle.journal.data.outcome, 'unknown');
      assert.throws(() => handle.journal.assertWritable());
      assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error.code), ['OUTCOME_UNKNOWN']);
    });
  }
}

for (const code of ['EISDIR', 'ENOTDIR', 'EROFS']) {
  for (const phase of ['displacement', 'replacement']) test(`restore ${phase} rename ${code} stays retryable`, async t => {
    const f = await recoveryFixture(t);
    const journal = await f.prepare();
    await io.writeFile(f.manifest, 'installed manifest');
    const native = journal.storage.fs;
    let hit = false;
    journal.storage.fs = { ...native, async rename(source, destination) {
      const restoring = phase === 'displacement' ? source === f.manifest
        : source.includes('restore.tmp-') && destination === f.manifest;
      if (restoring) { hit = true; throw failure(code); }
      return native.rename(source, destination);
    } };
    // Exercise the real recovery session boundary using the injected storage.
    const session = await f.open();
    session.inspection.journal.storage.fs = journal.storage.fs;
    await assert.rejects(session.apply(choices(await session.presentation(), 'restore')), error => error instanceof RestoreFileError && error.code === code);
    assert.equal(hit, true);
    assert.equal(session.outcomeUnknown, false);
    assert.equal(session.inspection.journal.data.outcome, 'recovery-incomplete');
    session.inspection.journal.storage.fs = native;
    await session.apply(choices(await session.presentation(), 'restore', true));
    assert.equal(session.inspection.journal.data.outcome, 'completed');
    assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
  });
}

for (const code of codes) {
  for (const source of ['directory', 'ancestor manifest', 'lockfile']) test(`target ${source} has graceful and strict modes with ${code}`, async t => {
    const f = await recoveryFixture(t);
    const error = failure(code);
    const method = source === 'ancestor manifest' ? 'readFile' : 'lstat';
    const file = source === 'directory' ? f.root : source === 'ancestor manifest'
      ? path.join(path.dirname(f.root), 'package.json') : f.lockfile;
    let hits = 0;
    patch(t, io, method, original => async (candidate, ...args) => {
      if (candidate === file) { hits++; throw error; }
      return original(candidate, ...args);
    });
    const input = { projectDir: f.root, folderPath: f.root, packageManager: 'npm', environment: environment(f.root) };
    assert.equal((await resolveMutationTarget(input)).ok, false);
    await assert.rejects(resolveMutationTarget({ ...input, throwOnUnexpectedError: true }), cause => cause === error);
    assert.equal(hits, 2);
  });

  test(`dashboard controller and panel refresh boundaries keep their mode with ${code}`, async t => {
    const s = await panel(t, { early: false });
    s.gate.resolve();
    await s.ready();
    await until(() => s.snapshots().length > 0);
    const error = failure(code);
    const controller = s.current.controller;
    const store = controller.options.projectCacheStore;
    const original = store.set;
    store.set = () => { throw error; };
    try {
      await s.current.handle({ type: 'refresh' });
      assert.equal(s.current.runtimeFailed, false);
      assert.equal((await controller.refreshInBackground(s.current.sink)).status, 'failed');
      await assert.rejects(controller.handleRefresh(s.current.sink, true), cause => cause === error);
      await assert.rejects(s.current.upgradeCoordinator.options.reloadFinalState(), cause => cause === error);
    } finally { store.set = original; }
    await s.refresh();
    assert.equal(s.current.runtimeFailed, false);
    // The panel's own load catch also has a graceful default for mandatory file errors.
    patch(t, io, 'readFile', originalRead => async (file, ...args) => {
      if (file === path.join(s.root, 'a/package.json')) throw error;
      return originalRead(file, ...args);
    });
    await s.current.handle({ type: 'refresh' });
    assert.equal(s.current.runtimeFailed, false);
    assert.ok(s.posted.some(message => message.status === 'fatal-error' && message.error.code === 'Error'));
    await assert.rejects(s.current.upgradeCoordinator.options.reloadFinalState(), cause => cause === error);
  });
}

for (const ErrorType of [TypeError, RangeError, ReferenceError, SyntaxError]) test(`non-errno ${ErrorType.name} remains a code failure in both resolver modes`, async t => {
  const error = new ErrorType('code failure');
  for (const strict of [false, true]) {
    assert.throws(() => rethrowUnexpectedResolverError(error, strict), cause => cause === error);
    const system = { path, realpath: async () => { throw error; } };
    await assert.rejects(authorizedRelation('/project', '/project/file', system, strict), cause => cause === error);
  }
  patch(t, fs.realpathSync, 'native', () => () => { throw error; });
  assert.throws(() => lockKey('/project'), cause => cause === error);
});

for (const code of codes) {
  for (const source of ['lock key', 'npm discovery']) test(`mutation entry point preserves strict ${source} handling with ${code}`, async t => {
    const f = await rollbackFixture(t, 'removal');
    const error = failure(code);
    const before = [await io.readFile(f.project.manifestPath, 'utf8'), await io.readFile(f.project.lockfilePath, 'utf8')];
    let hits = 0;
    if (source === 'lock key') patch(t, fs.realpathSync, 'native', () => () => { hits++; throw error; });
    else {
      f.coordinator.session.invocationResolver = undefined;
      patch(t, fs, 'readdirSync', () => () => { hits++; throw error; });
    }
    await f.confirm();
    assert.ok(hits > 0);
    assert.equal(f.coordinator.reservation.held, undefined, 'a refusal before mutation releases the read-only reservation');
    assert.deepEqual(f.commands, []);
    assert.deepEqual([await io.readFile(f.project.manifestPath, 'utf8'), await io.readFile(f.project.lockfilePath, 'utf8')], before);
    assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error), [{ code: 'Error', message: error.message }]);
    assert.equal(f.messages.some(message => message.status === 'remove-result'), false);
  });
}
