import assert from 'node:assert/strict';
import { test } from 'node:test';
import nativeFs from 'node:fs/promises';
import syncFs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { recoveryFixture } from './helpers/recovery.mjs';
import { resolveMutationTarget, defaultMutationTargetEnvironment } from '../out/host/mutationTarget.js';
import { createNodeNpmResolverDeps } from '../out/host/npmResolver.js';
import { resolvePnpmInvocation, resolveInstalledPnpmInvocation } from '../out/host/pnpmResolver.js';

const failure = fault => fault === 'TypeError' ? new TypeError('resolver bug') : Object.assign(new Error('resolver EIO'), { code: 'EIO' });

function patch(t, target, method, replace) {
  const original = target[method];
  target[method] = replace(original);
  syncBuiltinESMExports();
  t.after(() => { target[method] = original; syncBuiltinESMExports(); });
}

for (const fault of ['EIO', 'TypeError']) {
  for (const source of ['directory', 'npm ancestor', 'shrinkwrap', 'npm lockfile', 'pnpm misnamed workspace', 'pnpm workspace', 'pnpm lockfile', 'pnpmfile', 'pnpm manifest', 'pnpm npmrc', 'pnpm redirected npmrc', 'pnpm global yaml']) {
    test(`strict reinstall target ${source} propagates ${fault}`, async t => {
      const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}' });
      const manager = source.startsWith('pnpm') ? 'pnpm' : 'npm';
      const environment = { env: {}, homeDir: path.join(f.root, 'home'), platform: 'linux', nodePrefixes: [] };
      if (manager === 'pnpm') {
        await nativeFs.rename(f.lockfile, path.join(f.root, 'pnpm-lock.yaml'));
        // Stop membership discovery at this workspace so tests never inspect host pnpm settings.
        await nativeFs.writeFile(path.join(f.root, 'pnpm-workspace.yaml'), 'packages: []');
      }
      const redirected = path.join(f.root, 'redirected.npmrc');
      if (source === 'pnpm redirected npmrc') await nativeFs.writeFile(path.join(f.root, '.npmrc'), `userconfig=${redirected}\n`);
      const candidates = {
        directory: ['lstat', f.root],
        'npm ancestor': ['readFile', path.join(path.dirname(f.root), 'package.json')],
        shrinkwrap: ['lstat', path.join(f.root, 'npm-shrinkwrap.json')],
        'npm lockfile': ['lstat', f.lockfile],
        'pnpm misnamed workspace': ['lstat', path.join(f.root, 'pnpm-workspace.yml')],
        'pnpm workspace': ['readFile', path.join(f.root, 'pnpm-workspace.yaml')],
        'pnpm lockfile': ['lstat', path.join(f.root, 'pnpm-lock.yaml')],
        pnpmfile: ['readFile', path.join(f.root, '.pnpmfile.cjs')],
        'pnpm manifest': ['readFile', f.manifest],
        'pnpm npmrc': ['readFile', path.join(f.root, '.npmrc')],
        'pnpm redirected npmrc': ['readFile', redirected],
        'pnpm global yaml': ['readFile', path.join(environment.homeDir, '.config/pnpm/config.yaml')],
      };
      const [method, candidate] = candidates[source];
      let injected = false;
      const error = failure(fault);
      patch(t, nativeFs, method, original => async (...args) => {
        if (args[0] === candidate) { injected = true; throw error; }
        return original(...args);
      });
      await assert.rejects(resolveMutationTarget({ projectDir: f.root, folderPath: f.root, packageManager: manager,
        environment, throwOnUnexpectedError: true }), cause => cause === error);
      assert.equal(injected, true);
    });
  }

  for (const step of ['exists', 'isExecutable', 'listDir', 'resolveRealNodePath', 'resolveGlobalNpmRoot', 'probeVersion', 'probeLoginShellNode']) {
    test(`strict npm discovery ${step} propagates ${fault}`, t => {
      const error = failure(fault);
      const deps = createNodeNpmResolverDeps(process.cwd(), true);
      const method = step === 'exists' ? 'statSync' : step === 'isExecutable' ? 'accessSync' : step === 'listDir' ? 'readdirSync' : 'execFileSync';
      patch(t, method === 'execFileSync' ? childProcess : syncFs, method, () => () => { throw error; });
      if (step === 'resolveGlobalNpmRoot') {
        patch(t, syncFs, 'statSync', () => () => ({ isFile: () => true }));
      }
      assert.throws(() => deps[step]('/installation/node', '/installation/npm-cli.js'), cause => cause === error);
    });
  }

  for (const phase of ['safe path', 'real entry point']) test(`strict pnpm discovery ${phase} propagates ${fault}`, t => {
    const error = failure(fault);
    let seen = false;
    assert.throws(() => resolvePnpmInvocation(null, { platform: 'linux', cwd: '/project', pathEnv: '/installation',
      throwOnUnexpectedError: true, exists: () => true, probe: () => '10.0.0',
      realpath(candidate) {
        if (phase === 'safe path' || (candidate === '/installation/pnpm' && seen)) throw error;
        if (candidate === '/installation/pnpm') seen = true;
        return candidate;
      },
    }), cause => cause === error);
  });

  for (const phase of ['manifest', 'probe']) test(`strict installed pnpm ${phase} propagates ${fault}`, t => {
    const error = failure(fault);
    patch(t, syncFs, 'statSync', () => () => ({ isFile: () => true }));
    patch(t, syncFs, 'readFileSync', original => (...args) => {
      if (args[0] === path.join(process.cwd(), 'package.json')) {
        if (phase === 'manifest') throw error;
        return '{}';
      }
      return original(...args);
    });
    patch(t, syncFs, 'realpathSync', () => candidate => candidate);
    patch(t, syncFs, 'accessSync', () => () => {});
    patch(t, childProcess, 'execFileSync', () => () => { throw error; });
    assert.throws(() => resolveInstalledPnpmInvocation({ node: '/installation/node', npmCliJs: '/installation/lib/node_modules/npm/bin/npm-cli.js' }, process.cwd(), true), cause => cause === error);
  });

  test(`strict target environment discovery propagates ${fault}`, t => {
    const error = failure(fault);
    let hits = 0;
    // Every host canonicalizes candidates. Only POSIX enumerates nvm/fnm directories.
    patch(t, syncFs.realpathSync, 'native', () => () => { hits++; throw error; });
    assert.throws(() => defaultMutationTargetEnvironment(true), cause => cause === error);
    assert.equal(hits, 1);
  });

  test(`strict POSIX target environment directory discovery propagates ${fault}`, {
    skip: process.platform === 'win32' && 'Windows candidates do not enumerate POSIX version managers',
  }, t => {
    const error = failure(fault);
    patch(t, syncFs, 'readdirSync', () => () => { throw error; });
    assert.throws(() => defaultMutationTargetEnvironment(true), cause => cause === error);
  });
}
