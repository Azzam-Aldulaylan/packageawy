import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/host/resolverVerifier.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'busy-temp-cleanup', setup(plugin) {
    plugin.onResolve({ filter: /^node:fs\/promises$/ }, args => args.namespace === 'busy-cleanup'
      ? { path: args.path, external: true } : { path: args.path, namespace: 'busy-cleanup' });
    plugin.onLoad({ filter: /.*/, namespace: 'busy-cleanup' }, () => ({ contents: `
      export { mkdtemp, readFile, writeFile } from 'node:fs/promises';
      export const rm = async root => {
        globalThis.__resolverCleanupRoots.push(root);
        throw Object.assign(new Error('file is still in use'), { code: 'EBUSY' });
      };
    ` }));
  } }],
});
const { IsolatedResolverVerifier } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('busy isolated temp cleanup quietly preserves resolver results and timeout errors', async t => {
  const roots = globalThis.__resolverCleanupRoots = [];
  t.after(async () => {
    delete globalThis.__resolverCleanupRoots;
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  });
  const requested = { packageName: 'react', currentVersion: '18.0.0', targetVersion: '19.0.0', classification: 'prod' };
  const proposal = { requested, changes: [requested] };
  const timeout = Object.assign(new Error('analysis timed out'), { name: 'TimeoutError' });
  let fail = false;
  const verifier = new IsolatedResolverVerifier({
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: 'unused', prefixArgs: [] },
    manifestText: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    lockfile: { name: 'package-lock.json', text: JSON.stringify({ name: 'fixture', lockfileVersion: 3,
      packages: { '': { dependencies: { react: '^18.0.0' } }, 'node_modules/react': { version: '18.0.0' } } }) },
    registry: 'https://registry.npmjs.org/', policy: { strictPeerDeps: false, legacyPeerDeps: false },
    runner: { async run() {
      if (fail) throw timeout;
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
  });
  assert.equal((await verifier.verify(proposal)).status, 'compatible');
  assert.equal((await verifier.materializeResolvedGraph(proposal)).ok, true);
  assert.equal((await verifier.materializeTransitiveRemediation(['react'])).ok, true);
  fail = true;
  await assert.rejects(verifier.verify(proposal), error => error === timeout);
  assert.deepEqual(await verifier.materializeResolvedGraph(proposal), { ok: false });
  const result = await verifier.materializeTransitiveRemediation(['react']);
  assert.equal(result.code, 'RESOLVER_TIMEOUT');
  assert.equal(result.reason, 'Transitive fix analysis reached its 120 second limit. Project files were not changed.');
  assert.equal(roots.length, 6);
});
