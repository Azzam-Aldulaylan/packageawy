import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

// Keep the real coordinator, compatibility planner and isolated resolver. Replace
// only toolchain discovery and the process runner, so the tests never run npm.
const verifierUrl = pathToFileURL(`${process.cwd()}/out/host/resolverVerifier.js`).href;
const bundle = await build({ entryPoints: ['src/host/upgradeAssistantCoordinator.ts'], bundle: true,
  write: false, format: 'esm', platform: 'node',
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(`${process.cwd()}/package.json`)});` },
  plugins: [{ name: 'fake-resolver-process', setup(plugin) {
    plugin.onResolve({ filter: /^\.\/npmResolver\.js$/ }, () => ({ path: 'toolchain', namespace: 'test' }));
    plugin.onResolve({ filter: /^\.\/resolverVerifier\.js$/ }, () => ({ path: 'verifier', namespace: 'test' }));
    plugin.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ loader: 'js', contents: args.path === 'toolchain'
      ? `export const probeLoginShellPath = () => null;
        export const createNodeNpmResolverDeps = () => ({});
        export const resolveNpmInvocation = () => ({ ok: true, invocation: { node: '/fake/node', npmCliJs: '/fake/npm', version: '10.0.0' } });`
      : `export { IsolatedResolverVerifier } from '${verifierUrl}';
        export class NodeResolverProcessRunner { run(...args) { return globalThis.__reviewSecurityRunner.run(...args); } }` }));
    plugin.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
  } }] });
const { UpgradeAssistantCoordinator } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

async function analyze({ coordinated = false, bulk = false, off = false, resolverFails = false, advisoryFails = false, cancelAt, disableAtAdvisory = false } = {}) {
  const messages = [];
  const posts = [];
  const resolvedManifests = [];
  let phase;
  let cancelled;
  let advisorySettingChange;
  const cancel = async signal => {
    cancelled = { signal, resolverStarts: resolvedManifests.length };
    coordinator.handleCancelUpgrade({ analysisId: null });
    // Let the pending operation observe cancellation before returning evidence.
    await new Promise(resolve => setImmediate(resolve));
  };
  const dependencies = { app: '^1.0.0', ...(coordinated || bulk ? { peer: '^1.0.0' } : {}) };
  const packages = { '': { dependencies }, 'node_modules/app': { version: '1.0.0' },
    ...(coordinated || bulk ? { 'node_modules/peer': { version: '1.0.0', ...(coordinated ? { peerDependencies: { app: '^1.0.0' } } : {}) } } : {}) };
  const source = { root: '/fixture', manifestText: JSON.stringify({ dependencies }), lockfileText: JSON.stringify({ lockfileVersion: 3, packages }),
    lockfilePath: '/fixture/package-lock.json', lockfileRoot: '/fixture', lockfileName: 'package-lock.json', importerId: '.',
    registry: 'https://registry.npmjs.org/', resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} },
    peerPolicy: { strictPeerDeps: true, legacyPeerDeps: false }, packageManager: 'npm' };
  const changes = [{ packageName: 'app', currentVersion: '1.0.0', target: bulk ? '3.0.0' : '2.0.0', classification: 'prod' },
    ...(bulk ? [{ packageName: 'peer', currentVersion: '1.0.0', target: '2.0.0', classification: 'prod' }] : [])];
  globalThis.__reviewSecurityRunner = { async run(_, args, cwd, signal) {
    const staged = JSON.parse(await readFile(`${cwd}/package.json`, 'utf8'));
    resolvedManifests.push(staged);
    if (cancelAt === 'resolution' && phase === 'smart-plan') await cancel(signal);
    if (resolverFails) return { exitCode: 1, stdout: '', stderr: 'registry unavailable' };
    if (coordinated && staged.dependencies.peer !== '2.0.0') return { exitCode: 1, stdout: '', stderr: 'ERESOLVE peer dependency' };
    const afterPackages = { '': { dependencies: staged.dependencies } };
    for (const [name, version] of Object.entries(staged.dependencies)) {
      afterPackages[`node_modules/${name}`] = { version: version.replace('^', '') };
    }
    if (args.includes('--package-lock-only')) await writeFile(`${cwd}/package-lock.json`, JSON.stringify({ lockfileVersion: 3, packages: afterPackages }));
    return { exitCode: 0, stdout: '', stderr: '' };
  } };
  const controller = { root: source.root, upgradeSource: source,
    lastResultRows: () => [], // All installed dashboard rows are clean.
    validateBulkUpgradeRequest: () => ({ ok: true, upgrades: changes }) };
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (key, fallback) => key === 'security.publicAdvisoryCheck' ? !off : fallback, findFiles: async () => [] },
    sink: { postMessage: message => { messages.push(message); if (message.phase) phase = message.phase; } },
    httpClient: {
      get: async (url, options) => {
        const name = url.includes('/peer') ? 'peer' : 'app';
        const metadata = version => ({ name, version, exports: './index.js', dependencies: {},
          ...(name === 'peer' && coordinated ? { peerDependencies: { app: version === '1.0.0' ? '^1' : '>=2' } } : {}) });
        const exactVersion = new URL(url).pathname.split('/').at(-1);
        if (phase === 'smart-plan' && name === 'peer' && !cancelled &&
            ((cancelAt === 'candidate-metadata' && exactVersion === 'peer') ||
             (cancelAt === 'target-metadata' && /^\d+\.\d+\.\d+$/.test(exactVersion)))) {
          await cancel(options?.signal);
        }
        if (/^\d+\.\d+\.\d+$/.test(exactVersion)) return { status: 200, headers: {}, body: JSON.stringify(metadata(exactVersion)) };
        return { status: 200, headers: {}, body: JSON.stringify({ name, 'dist-tags': { latest: '3.0.0' },
          versions: { '1.0.0': metadata('1.0.0'), '2.0.0': metadata('2.0.0'), '3.0.0': metadata('3.0.0') } }) };
      },
      post: async (_, body, options) => {
        posts.push(JSON.parse(body));
        if (disableAtAdvisory) {
          off = true;
          advisorySettingChange = { busy: coordinator.isBusy(), signal: options.signal };
          coordinator.handleAdvisorySettingChanged?.();
          advisorySettingChange.abortedImmediately = options.signal.aborted;
        }
        if (advisoryFails) throw new Error('advisories offline');
        const name = coordinated ? 'peer' : 'app';
        return { status: 200, body: JSON.stringify({ [name]: [{ id: 9, severity: 'high', title: 'New version vulnerability',
          vulnerable_versions: '>=2', url: 'https://example.com/advisory' }] }) };
      },
    },
    etagStore: { get: () => undefined, set: () => {} }, ensureController: async () => controller,
    getSelectedProject: () => ({ id: 'fixture', dir: '', folder: { id: 'fixture', name: 'fixture', path: '/fixture' } }),
    isDisposed: () => false, loadProject: async () => source,
    withCompatibilityProgress: async (_, run) => run(new AbortController().signal),
    flushDeferredChanges: async () => {}, reloadFinalState: async () => {},
  });
  const work = bulk
    ? coordinator.handleAnalyzeBulkUpgrade({ requestId: 'review', changes: changes.map(change => ({ package: change.packageName, target: change.target })) })
    : coordinator.handleAnalyzeUpgrade({ requestId: 'review', package: 'app', target: changes[0].target });
  await work;
  if (cancelAt) return { cancelled, messages, resolvedManifests, coordinator };
  const result = messages.findLast(message => message.status === 'upgrade-analysis');
  assert.ok(result, `expected completed review, got ${JSON.stringify(messages.filter(message => message.status === 'upgrade-error'))}`);
  assert.equal(isHostToWebviewMessage(result), true);
  await coordinator.handleCancelUpgrade({ analysisId: result.analysis.analysisId });
  return { result: result.analysis, messages, posts, resolvedManifests, advisorySettingChange };
}

test('a setting change aborts advisory requests while a review is busy and completes its other sections', async () => {
  const { result, advisorySettingChange } = await analyze({ disableAtAdvisory: true });
  assert.equal(advisorySettingChange.busy, true);
  assert.equal(advisorySettingChange.abortedImmediately, true, 'active requests are aborted at the setting event');
  assert.equal(result.security.checkState, 'off');
  assert.equal(result.compatibility.status, 'warning', 'the major-version compatibility review completes');
});

for (const cancelAt of ['candidate-metadata', 'target-metadata', 'resolution']) {
  test(`closing a coordinated review during ${cancelAt} aborts work and starts no further resolvers`, async () => {
    const { cancelled, messages, resolvedManifests, coordinator } = await analyze({ coordinated: true, cancelAt });
    assert.ok(cancelled, 'the cancellation point was reached');
    assert.equal(cancelled.signal?.aborted, true, 'the active metadata request or resolver receives the review abort');
    assert.equal(resolvedManifests.length, cancelled.resolverStarts, 'no resolver starts after closing');
    assert.equal(messages.some(message => message.status === 'upgrade-analysis'), false);
    assert.equal(messages.some(message => message.status === 'upgrade-error'), false);
    assert.equal(coordinator.isBusy(), false, 'cancellation drains work and releases the reservation');
  });
}

test('clean-row coordinator review audits its proposed graph once after compatibility is published', async () => {
  const { result, messages, posts, resolvedManifests } = await analyze();
  assert.equal(posts.length, 1);
  assert.equal(resolvedManifests.length, 1, 'compatibility and security share a resolver run');
  assert.deepEqual(posts[0].app, ['1.0.0', '2.0.0']);
  assert.equal(result.security.introduced[0].resolvedVersion, '2.0.0');
  const compatibility = messages.findIndex(message => message.section?.kind === 'compatibility');
  const security = messages.findIndex(message => message.section?.kind === 'security');
  assert.ok(compatibility >= 0 && security > compatibility);
});

test('coordinator audits the final coordinated proposal including the planner-added dependency', async () => {
  const { result, posts, resolvedManifests } = await analyze({ coordinated: true });
  assert.ok(result.smartPlan);
  assert.equal(result.smartPlan.changes.find(change => change.packageName === 'peer').targetVersion, '2.0.0');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].peer, ['1.0.0', '2.0.0']);
  assert.equal(result.security.introduced[0].flaggedPackage, 'peer');
  assert.equal(resolvedManifests.filter(manifest => manifest.dependencies.peer === '2.0.0').length, 1,
    'the validated coordinated graph is reused by security');
});

test('bulk review audits the substituted executable targets', async () => {
  const { result, posts } = await analyze({ bulk: true });
  assert.deepEqual(posts[0].app, ['1.0.0', '3.0.0']);
  assert.deepEqual(posts[0].peer, ['1.0.0', '2.0.0']);
  assert.equal(result.security.introduced[0].resolvedVersion, '3.0.0');
});

for (const failure of ['resolverFails', 'advisoryFails', 'off']) {
  test(`coordinator ${failure} produces an honest security section`, async () => {
    const { result, posts } = await analyze({ [failure]: true });
    assert.equal(result.security.checkState, failure === 'off' ? 'off' : 'unavailable');
    if (failure !== 'advisoryFails') assert.equal(posts.length, 0);
  });
}
