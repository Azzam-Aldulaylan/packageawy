import assert from 'node:assert/strict';
import { test } from 'node:test';
import io from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { buildSync } from 'esbuild';

// Run the real adapters with Windows candidate and path rules on every host.
// Keep filesystem methods external so faults still cross their production catches.
const bundle = buildSync({
  stdin: { contents: `
    export { defaultMutationTargetEnvironment } from './src/host/mutationTarget.ts';
    export { createNodeNpmResolverAsyncDeps, resolveNpmInvocationAsync } from './src/host/npmResolverAsync.ts';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'process.platform': '"win32"' },
});
const windows = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url), windows, windows.exports);
const { defaultMutationTargetEnvironment, createNodeNpmResolverAsyncDeps, resolveNpmInvocationAsync } = windows.exports;

function patch(t, target, method, replacement) {
  const original = target[method];
  target[method] = replacement;
  syncBuiltinESMExports();
  t.after(() => { target[method] = original; syncBuiltinESMExports(); });
}

for (const fault of ['EIO', 'EINVAL', 'UNKNOWN', 'EBUSY', 'ENAMETOOLONG', 'EMFILE', 'ENETUNREACH', 'TypeError']) {
  test(`Windows discovery keeps graceful and strict handling for ${fault}`, async t => {
    const error = fault === 'TypeError' ? new TypeError('discovery bug') : Object.assign(new Error(`discovery ${fault}`), { code: fault });
    let directories = 0, canonicalizations = 0, stats = 0;
    patch(t, io, 'readdir', () => { directories++; throw new Error('Windows must not enumerate POSIX managers'); });
    patch(t, io, 'realpath', () => { canonicalizations++; throw error; });
    patch(t, io, 'stat', async () => { stats++; throw error; });
    for (const strict of [false, true]) {
      const environment = () => defaultMutationTargetEnvironment(strict);
      const npm = () => resolveNpmInvocationAsync({ ...createNodeNpmResolverAsyncDeps(process.cwd(), undefined, strict),
        pathEnv: 'C:\\Node', homeDir: 'C:\\Users\\fixture' });
      if (strict || fault === 'TypeError') {
        await assert.rejects(environment(), cause => cause === error);
        await assert.rejects(npm, cause => cause === error);
      } else {
        assert.deepEqual((await environment()).nodePrefixes, []);
        assert.deepEqual(await npm(), { ok: false });
      }
    }
    assert.equal(directories, 0);
    assert.ok(canonicalizations > 0, 'Windows environment discovery must reach the filesystem');
    assert.ok(stats > 0, 'Windows npm discovery must stat its candidates');
  });
}
