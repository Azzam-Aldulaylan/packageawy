import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { buildSync } from 'esbuild';

// Run the real adapters with Windows candidate and path rules on every host.
// Keep filesystem methods external so faults still cross their production catches.
const bundle = buildSync({
  stdin: { contents: `
    export { defaultMutationTargetEnvironment } from './src/host/mutationTarget.ts';
    export { createNodeNpmResolverDeps, resolveNpmInvocation } from './src/host/npmResolver.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'process.platform': '"win32"' },
});
const windows = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url), windows, windows.exports);
const { defaultMutationTargetEnvironment, createNodeNpmResolverDeps, resolveNpmInvocation } = windows.exports;

function patch(t, target, method, replacement) {
  const original = target[method];
  target[method] = replacement;
  syncBuiltinESMExports();
  t.after(() => { target[method] = original; syncBuiltinESMExports(); });
}

for (const fault of ['EIO', 'EINVAL', 'UNKNOWN', 'EBUSY', 'ENAMETOOLONG', 'EMFILE', 'ENETUNREACH', 'TypeError']) {
  test(`Windows discovery keeps graceful and strict handling for ${fault}`, t => {
    const error = fault === 'TypeError' ? new TypeError('discovery bug') : Object.assign(new Error(`discovery ${fault}`), { code: fault });
    let directories = 0, canonicalizations = 0, stats = 0;
    patch(t, fs, 'readdirSync', () => { directories++; throw new Error('Windows must not enumerate POSIX managers'); });
    patch(t, fs.realpathSync, 'native', () => { canonicalizations++; throw error; });
    patch(t, fs, 'statSync', () => { stats++; throw error; });
    // Graceful npm existence uses existsSync, then the shared executable probe.
    patch(t, fs, 'existsSync', () => true);
    patch(t, fs, 'accessSync', () => { throw error; });
    for (const strict of [false, true]) {
      const environment = () => defaultMutationTargetEnvironment(strict);
      const npm = () => resolveNpmInvocation({ ...createNodeNpmResolverDeps(process.cwd(), strict),
        pathEnv: 'C:\\Node', homeDir: 'C:\\Users\\fixture' });
      if (strict || fault === 'TypeError') {
        assert.throws(environment, cause => cause === error);
        assert.throws(npm, cause => cause === error);
      } else {
        assert.deepEqual(environment().nodePrefixes, []);
        assert.deepEqual(npm(), { ok: false });
      }
    }
    assert.equal(directories, 0);
    assert.ok(canonicalizations > 0, 'Windows environment discovery must reach the filesystem');
    assert.equal(stats, 1, 'strict Windows npm discovery must stat its candidate');
  });
}
