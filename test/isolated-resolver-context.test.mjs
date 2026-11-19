import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeCompatibility } from '../out/core/compatibility/preflight.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { planSmartUpgrade } from '../out/core/upgrade/smartPlan.js';
import { npmManifestResolverLimitations } from '../out/host/isolatedResolverContext.js';
import { discoverProjects, loadProject } from '../out/host/projectResolution.js';
import { IsolatedResolverVerifier } from '../out/host/resolverVerifier.js';
import { deriveUpgradeReviewDecision } from '../out/host/upgradeReviewDecision.js';

const change = { packageName: 'react', currentVersion: '18.0.0', targetVersion: '18.1.0', classification: 'prod' };
const proposal = { requested: change, changes: [change] };
const manifest = { dependencies: { react: '18.0.0' } };
const lock = JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: manifest.dependencies }, 'node_modules/react': { version: '18.0.0' },
} });
const policy = { strictPeerDeps: true, legacyPeerDeps: false };
const metadataProvider = { async getPackageVersionMetadata(name, version) {
  return { name, version, dependencies: {}, optionalDependencies: {}, peerDependencies: {}, peerDependenciesMeta: {} };
} };
function options(extra = {}) {
  return {
    packageManager: 'npm', packageManagerVersion: '10.0.0',
    invocation: { executable: process.execPath, prefixArgs: [] },
    manifestText: JSON.stringify(manifest), lockfile: { name: 'package-lock.json', text: lock },
    registry: 'https://registry.npmjs.org/', policy,
    runner: { async run(_invocation, _args, cwd) {
      assert.match(path.join(cwd, 'package.json'), /[\\/]package\.json$/);
      const staged = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
      assert.equal(staged.dependencies.react, change.targetVersion);
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
    ...extra,
  };
}
function graph() {
  return buildDependencyGraph({ root: path.join(tmpdir(), 'review'), manifest: parseManifest(JSON.stringify(manifest)), lockfileText: lock, packageManager: 'npm' });
}

for (const [name, extra] of [
  ['workspace root', { manifestText: JSON.stringify({ ...manifest, workspaces: ['packages/*'] }) }],
  ['workspace root with object workspaces', { manifestText: JSON.stringify({ ...manifest, workspaces: { packages: ['packages/*'] } }) }],
  ['workspace member', { importerId: 'packages/app' }],
  ['Windows workspace member', { importerId: path.win32.relative(path.win32.join('C:', 'repo'), path.win32.join('C:', 'repo', 'packages', 'app')).split(path.win32.sep).join('/') }],
]) {
  test(`npm ${name} success is partial throughout compatibility, verdicts, planning and security`, async () => {
    const verifier = new IsolatedResolverVerifier(options({ retainResolvedGraph: true, ...extra }));
    const result = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: verifier });
    assert.equal(result.resolverVerification.status, 'unknown');
    assert.equal(result.resolverVerification.code, 'RESOLUTION_PARTIAL');
    assert.equal(result.resolverVerification.completeness, 'partial');
    assert.match(result.resolverVerification.explanation, /Checked with this package\.json and the lockfile only\./);
    assert.match(result.resolverVerification.explanation, /Other packages.*workspace were not included.*real install may differ/);
    assert.equal(result.status, 'unknown');
    assert.equal(result.completeness, 'partial');
    const decision = deriveUpgradeReviewDecision({ compatibility: result, projectCompatibility: {
      analyzers: ['runtime-compatibility', 'import-compatibility'].map(analyzerId => ({ analyzerId, status: 'complete' })), findings: [],
    } });
    assert.equal(decision.headline.label, 'Compatibility checks incomplete');
    assert.equal(decision.caution, true);
    assert.match(decision.recommendation, /could not be fully verified/);
    const plan = await planSmartUpgrade({ initialAnalysis: result, graph: graph(), policy, metadataProvider,
      resolverVerifier: verifier, upgradeableDirectDependencies: [], candidateProvider: { async getStableVersionCandidates() { throw new Error('must not search'); } } });
    assert.equal(plan.outcome, 'unknown');
    assert.deepEqual(await verifier.materializeResolvedGraph(proposal), { ok: false });
    assert.deepEqual(await verifier.materializeResolvedGraph({ ...proposal, changes: [] }), { ok: false });
    const remediation = await verifier.materializeTransitiveRemediation(['react']);
    assert.equal(remediation.ok, false);
    assert.equal(remediation.reason, result.resolverVerification.explanation);
  });
}

test('a plain npm project and registry overrides keep their existing complete success', async () => {
  const verifier = new IsolatedResolverVerifier(options({ manifestText: JSON.stringify({ ...manifest, overrides: { other: '1.0.0' }, scripts: { test: 'node test.mjs' } }) }));
  const result = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: verifier });
  assert.equal(result.resolverVerification.status, 'compatible');
  assert.equal(result.resolverVerification.code, 'RESOLVED');
  assert.equal(result.status, 'compatible');
  assert.equal(result.completeness, 'complete');
});

for (const [stderr, status, code] of [['ERESOLVE peer dependency conflict', 'conflict', 'RESOLUTION_CONFLICT'], ['network unavailable', 'unknown', 'RESOLVER_FAILED']]) {
  test(`a partial npm check preserves ${code} and its diagnostic`, async () => {
    const verifier = new IsolatedResolverVerifier(options({ importerId: 'packages/app',
      runner: { async run() { return { exitCode: 1, stdout: '', stderr }; } } }));
    const result = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: verifier });
    assert.equal(result.resolverVerification.status, status);
    assert.equal(result.resolverVerification.code, code);
    assert.ok(result.resolverVerification.explanation.includes(stderr));
    assert.match(result.resolverVerification.explanation, /root package\.json settings.*not included/);
    assert.equal(result.resolverVerification.completeness, 'partial');
    assert.equal(result.status, status);
    assert.equal(result.completeness, 'partial');
  });
}

for (const workspaces of [[], { packages: [] }]) {
  test(`empty npm workspaces ${JSON.stringify(workspaces)} keep complete resolution and usable graphs`, async () => {
    const manifestText = JSON.stringify({ ...manifest, workspaces });
    assert.deepEqual(npmManifestResolverLimitations(manifestText), []);
    const verifier = new IsolatedResolverVerifier(options({ manifestText, retainResolvedGraph: true,
      runner: { async run(_invocation, _args, cwd) {
        const staged = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
        await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
          '': { dependencies: staged.dependencies }, 'node_modules/react': { version: staged.dependencies.react },
        } }));
        return { exitCode: 0, stdout: '', stderr: '' };
      } },
    }));
    const result = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: verifier });
    assert.equal(result.resolverVerification.status, 'compatible');
    assert.equal(result.resolverVerification.code, 'RESOLVED');
    assert.equal(result.status, 'compatible');
    assert.equal(result.completeness, 'complete');
    const resolved = await verifier.materializeResolvedGraph(proposal);
    assert.equal(resolved.ok, true);
    assert.equal([...resolved.graph.nodes.values()].find(node => node.name === 'react').version, change.targetVersion);
    assert.equal((await verifier.materializeResolvedGraph({ ...proposal, changes: [] })).ok, true);
    assert.equal((await verifier.materializeTransitiveRemediation(['react'])).ok, true);
  });
}

for (const spec of ['file:../local', 'file:../local.tgz', 'link:../local', 'workspace:*', 'git+file:../local', '../local', String.raw`..\local`, String.raw`C:\repo\local`, 'vendor.tgz']) {
  test(`npm local source ${spec} is detected without file reads`, async () => {
    const manifestText = JSON.stringify({ ...manifest, optionalDependencies: { local: spec } });
    assert.match(npmManifestResolverLimitations(manifestText).join(' '), /Local dependency files and linked packages/);
    const result = await new IsolatedResolverVerifier(options({ manifestText })).verify(proposal);
    assert.equal(result.code, 'RESOLUTION_PARTIAL');
    const verifier = new IsolatedResolverVerifier(options({ manifestText, retainResolvedGraph: true }));
    assert.deepEqual(await verifier.materializeResolvedGraph(proposal), { ok: false });
    assert.equal((await verifier.materializeTransitiveRemediation(['react'])).ok, false);
  });
}

test('local paths in nested npm overrides are partial and remote sources are unchanged', () => {
  assert.equal(npmManifestResolverLimitations(JSON.stringify({ overrides: { a: { b: 'file:../b' } } })).length, 1);
  assert.deepEqual(npmManifestResolverLimitations(JSON.stringify({ dependencies: { a: 'https://example.test/a.tgz', b: 'git+https://example.test/b.git', c: 'npm:other@1.0.0' } })), []);
});

test('local entries only in the npm lockfile keep complete resolution', async () => {
  // npm prunes unused links and reads bundled packages from their parent, so these need no outside files.
  for (const fields of [
    { packages: { 'node_modules/local': { link: true, resolved: 'packages/local' } } },
    { packages: { 'node_modules/parent/node_modules/bundled': { inBundle: true, resolved: 'file:../bundled' } } },
  ]) {
    const text = JSON.stringify({ lockfileVersion: 3, ...fields });
    const verifier = new IsolatedResolverVerifier(options({ lockfile: { name: 'package-lock.json', text } }));
    assert.equal(verifier.partialCoverage, undefined);
    assert.notEqual((await verifier.verify(proposal)).code, 'RESOLUTION_PARTIAL');
  }
});

test('npm install hooks including patch-package keep complete resolution without enabling scripts', async () => {
  for (const script of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    const verifier = new IsolatedResolverVerifier(options({ manifestText: JSON.stringify({ ...manifest, scripts: { [script]: 'patch-package' } }),
      runner: { async run(_invocation, args) {
        assert.ok(args.includes('--ignore-scripts'));
        return { exitCode: 0, stdout: '', stderr: '' };
      } } }));
    const result = await verifier.verify(proposal);
    assert.equal(result.status, 'compatible');
    assert.equal(result.code, 'RESOLVED');
    assert.deepEqual(npmManifestResolverLimitations(JSON.stringify({ ...manifest, scripts: { [script]: 'patch-package' } })), []);
  }
});

test('a plain npm project with prepare, postinstall and other npmrc settings keeps complete resolution and usable graphs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-npm-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...manifest, scripts: { prepare: 'husky', postinstall: 'patch-package' } }));
  await writeFile(path.join(root, 'package-lock.json'), lock);
  await writeFile(path.join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\nstrict-peer-deps=true\nlegacy-peer-deps=false\nengine-strict=true\ninstall-links=false\nomit[]=optional\nfund=false\n');
  const folder = { id: 'fixture', name: 'fixture', path: root };
  const platform = { workspaceFolders: () => [folder], isWorkspaceTrusted: () => true, getSetting: (_key, fallback) => fallback,
    findFiles: async ({ include }) => include === '**/package.json'
      ? [path.join(root, 'package.json')] : [path.join(root, 'package-lock.json')] };
  const candidates = await discoverProjects(platform);
  const project = await loadProject(platform, candidates[0]);
  assert.equal(project.importerId, '.');
  assert.equal(project.registry, 'https://registry.npmjs.org/');
  assert.deepEqual(project.peerPolicy, { ...policy, sources: { strictPeerDeps: 'project-npmrc', legacyPeerDeps: 'project-npmrc' } });
  const verifier = new IsolatedResolverVerifier(options({
    manifestText: project.manifestText, importerId: project.importerId,
    lockfile: { name: project.lockfileName, text: project.lockfileText },
    registry: project.registry, policy: project.peerPolicy, retainResolvedGraph: true,
    runner: { async run(_invocation, args, cwd) {
      assert.ok(args.includes('--ignore-scripts'));
      const staged = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
      assert.deepEqual(staged.scripts, { prepare: 'husky', postinstall: 'patch-package' });
      await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies: staged.dependencies }, 'node_modules/react': { version: staged.dependencies.react },
      } }));
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
  }));
  const result = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: verifier });
  assert.equal(result.resolverVerification.status, 'compatible');
  assert.equal(result.resolverVerification.code, 'RESOLVED');
  assert.equal(result.resolverVerification.explanation, 'The package manager resolved the proposed dependency set in an isolated temporary project.');
  assert.equal(result.status, 'compatible');
  assert.equal(result.completeness, 'complete');
  assert.equal((await verifier.materializeResolvedGraph(proposal)).ok, true);
  assert.equal((await verifier.materializeResolvedGraph({ ...proposal, changes: [] })).ok, true);
  assert.equal((await verifier.materializeTransitiveRemediation(['react'])).ok, true);
});

test('partial checks without a lockfile accurately describe the staged input', async () => {
  const value = options({ importerId: 'packages/app' });
  delete value.lockfile;
  const result = await new IsolatedResolverVerifier(value).verify(proposal);
  assert.match(result.explanation, /^Checked with this package\.json only\./);
  assert.doesNotMatch(result.explanation, /and the lockfile/);
});

test('a resolver that throws keeps partial coverage, and a plain project stays complete', async () => {
  for (const name of ['TimeoutError', 'Error']) {
    const runner = { async run() { const error = new Error('boom'); error.name = name; throw error; } };
    const partial = new IsolatedResolverVerifier(options({ importerId: 'packages/app', runner }));
    const result = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: partial });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.resolverVerification?.completeness, 'partial');
    assert.equal(result.resolverVerification?.code, name === 'TimeoutError' ? 'RESOLVER_TIMEOUT' : 'RESOLVER_UNAVAILABLE');
    assert.match(result.resolverVerification?.explanation ?? '', /Other packages and root package\.json settings in this workspace were not included\./);

    const plain = new IsolatedResolverVerifier(options({ runner }));
    const plainResult = await analyzeCompatibility({ graph: graph(), proposal, policy, metadataProvider, resolverVerifier: plain });
    assert.equal(plainResult.resolverVerification?.completeness, undefined);
    assert.doesNotMatch(plainResult.resolverVerification?.explanation ?? '', /were not included/);
  }
});
