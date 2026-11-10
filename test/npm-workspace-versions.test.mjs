import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { attributeAdvisories } from '../out/core/advisories/attribution.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { buildGraph, directNodes, resolveDependency } from '../out/core/lockfile/parse.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { discoverProjects, loadProject } from '../out/host/projectResolution.js';
import { compareProposedGraphSecurityImpact } from '../out/host/proposedGraphSecurityImpact.js';
import { UsageAnalysisCoordinator } from '../out/host/usage/usageCoordinator.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/npm-member-versions/', import.meta.url));
const fixture = (name) => readFileSync(path.join(fixtureRoot, name), 'utf8');
const lockfileText = fixture('package-lock.json');
const memberManifest = parseManifest(fixture('packages/app/package.json'));
const options = (importerId = 'packages/app', extra = {}) => ({
  root: path.join(fixtureRoot, importerId),
  manifest: memberManifest,
  lockfileText,
  packageManager: 'npm',
  importerId,
  ...extra,
});
const advisory = (id, vulnerableVersions) => ({
  id, severity: 'high', title: 'Fixture advisory',
  url: 'https://example.test/advisory', vulnerableVersions,
});

for (const lockfileVersion of [2, 3]) {
  test(`npm v${lockfileVersion} selects only the member-local direct dependency`, () => {
    const lock = { ...JSON.parse(lockfileText), lockfileVersion };
    // v2's legacy mirror must not override the packages map.
    if (lockfileVersion === 2) lock.dependencies = { foo: { version: '1.0.0' } };
    const graph = buildDependencyGraph(options('packages/app', { lockfileText: JSON.stringify(lock) }));
    assert.deepEqual(directNodes(graph).map(({ path, version }) => [path, version]), [
      ['packages/app/node_modules/foo', '2.0.0'],
    ]);
    assert.equal(graph.nodes.get('node_modules/foo').direct, false);
    assert.equal(graph.nodes.get('node_modules/@ws/app').unresolvable, 'workspace-link');
    assert.equal(graph.nodes.get('node_modules/@ws/app').direct, false);
    assert.equal(graph.nodes.has('packages/app'), false);
  });
}

test('the npm parser accepts the lockfile-relative member path directly', () => {
  const graph = buildGraph({ root: '/repo/packages/app', manifest: memberManifest, lockfileText, memberPath: 'packages/app' });
  assert.equal(directNodes(graph)[0].version, '2.0.0');
});

test('a member without a local copy uses the hoisted root dependency', () => {
  const graph = buildDependencyGraph(options('packages/hoisted', {
    manifest: parseManifest(fixture('packages/hoisted/package.json')),
  }));
  assert.deepEqual(directNodes(graph).map(({ path, version }) => [path, version]), [['node_modules/foo', '1.0.0']]);
});

test('nested members search their own directory, each ancestor, then the lock root', () => {
  const lock = JSON.parse(lockfileText);
  lock.packages['packages/a/b/node_modules/foo'] = { version: '4.0.0' };
  lock.packages['packages/node_modules/foo'] = { version: '2.5.0' };
  for (const [expectedPath, expectedVersion] of [
    ['packages/a/b/node_modules/foo', '4.0.0'],
    ['packages/a/node_modules/foo', '3.0.0'],
    ['packages/node_modules/foo', '2.5.0'],
    ['node_modules/foo', '1.0.0'],
  ]) {
    const graph = buildDependencyGraph(options('packages/a/b', { lockfileText: JSON.stringify(lock) }));
    assert.deepEqual(directNodes(graph).map(({ path, version }) => [path, version]), [[expectedPath, expectedVersion]]);
    delete lock.packages[expectedPath];
  }
});

test('member direct dependencies resolve transitive copies locally, at the member, and at the root', () => {
  const graph = buildDependencyGraph(options());
  const foo = directNodes(graph)[0];
  for (const [name, expectedPath, version] of [
    ['helper', 'packages/app/node_modules/foo/node_modules/helper', '2.0.0'],
    ['member-helper', 'packages/app/node_modules/member-helper', '2.0.0'],
    ['root-helper', 'node_modules/root-helper', '1.0.0'],
  ]) {
    const resolved = resolveDependency(graph, foo.path, name);
    assert.equal(resolved?.path, expectedPath);
    assert.equal(resolved?.version, version);
  }
});

test('advisories and proposed security impact use the chosen member versions', () => {
  const graph = buildDependencyGraph(options());
  const advisories = new Map([
    ['foo', [advisory(1, '1.0.0'), advisory(2, '2.0.0')]],
    ['helper', [advisory(3, '1.0.0'), advisory(4, '2.0.0')]],
  ]);
  const attributed = attributeAdvisories(graph, advisories).get('foo');
  assert.deepEqual(attributed.map(({ advisory, flaggedVersion, path }) => [advisory.id, flaggedVersion, path]), [
    [2, '2.0.0', ['foo']],
    [4, '2.0.0', ['foo', 'helper']],
  ]);
  const snapshot = { graph, advisoriesByName: advisories, advisories: 'complete' };
  const impact = compareProposedGraphSecurityImpact(snapshot, snapshot);
  assert.equal(impact.status, 'complete');
  assert.deepEqual(impact.remaining.map(({ beforeVersions }) => beforeVersions), [['2.0.0'], ['2.0.0']]);
});

test('root projects keep their graph with an omitted, empty, or dot member location', () => {
  const rootOptions = options('.', { manifest: parseManifest(fixture('package.json')) });
  const { importerId, ...withoutImporter } = rootOptions;
  const graph = buildDependencyGraph(withoutImporter);
  assert.deepEqual(buildDependencyGraph(rootOptions), graph);
  assert.deepEqual(buildDependencyGraph({ ...rootOptions, importerId: '' }), graph);
  assert.deepEqual(directNodes(graph).map(({ path, version }) => [path, version]), [['node_modules/foo', '1.0.0']]);
  assert.equal(graph.nodes.get('packages/app/node_modules/foo').direct, false);
  assert.equal(resolveDependency(graph, 'node_modules/foo', 'helper').version, '1.0.0');
});

test('npm v1 keeps its root dependency tree when a member location is supplied', () => {
  const legacy = JSON.stringify({ lockfileVersion: 1, dependencies: {
    foo: { version: '1.0.0', requires: { helper: '^1.0.0' }, dependencies: { helper: { version: '1.0.0' } } },
  } });
  for (const importerId of ['.', 'packages/app']) {
    const graph = buildDependencyGraph(options(importerId, { lockfileText: legacy }));
    assert.equal(directNodes(graph)[0].version, '1.0.0');
    assert.equal(resolveDependency(graph, 'node_modules/foo', 'helper').version, '1.0.0');
  }
});

test('scoped aliases and missing dependency rows belong to the selected member', () => {
  const manifest = parseManifest(JSON.stringify({ dependencies: { '@alias/tool': 'npm:actual-tool@^2.0.0', missing: '^1.0.0' } }));
  const lock = JSON.parse(lockfileText);
  lock.packages['node_modules/@alias/tool'] = { version: '1.0.0' };
  lock.packages['packages/app/node_modules/@alias/tool'] = { version: '2.0.0' };
  const graph = buildDependencyGraph(options('packages/app', { manifest, lockfileText: JSON.stringify(lock) }));
  const [alias, missing] = directNodes(graph);
  assert.equal(alias.path, 'packages/app/node_modules/@alias/tool');
  assert.equal(alias.registryName, 'actual-tool');
  assert.equal(alias.version, '2.0.0');
  assert.equal(graph.nodes.get('node_modules/@alias/tool').registryName, undefined);
  assert.equal(missing.path, 'packages/app/node_modules/missing');
  assert.equal(missing.version, null);
});

test('removal evidence and Smart Cleanup use peer requirements from the member direct copy', async (t) => {
  const lock = JSON.parse(lockfileText);
  lock.packages['node_modules/consumer'] = { version: '1.0.0', peerDependencies: { foo: '^1.0.0' } };
  lock.packages['packages/app/node_modules/consumer'] = { version: '2.0.0', peerDependencies: { foo: '^2.0.0' } };
  const messages = [];
  const root = path.join(fixtureRoot, 'packages/app');
  const controller = {
    root,
    upgradeSource: {
      manifestText: JSON.stringify({ dependencies: { foo: '^2.0.0', consumer: '^2.0.0' } }),
      lockfileText: JSON.stringify(lock), lockfilePath: path.join(fixtureRoot, 'package-lock.json'),
      packageManager: 'npm', importerId: 'packages/app',
    },
    lastResultRows: () => [{ name: 'foo' }, { name: 'consumer' }],
  };
  const selected = {
    id: 'member', dir: 'packages/app', manifestPath: 'packages/app/package.json',
    folder: { id: 'workspace', name: 'workspace', path: fixtureRoot },
  };
  const coordinator = new UsageAnalysisCoordinator({
    platform: {
      findFiles: async () => [],
      withProgress: async (_title, run) => run(
        { report: () => {} },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
      ),
    },
    sink: { postMessage: (message) => messages.push(message) },
    ensureController: async () => controller,
    getSelectedProject: () => selected,
    isDisposed: () => false,
  });
  t.after(() => coordinator.dispose());
  assert.equal(await coordinator.handleAnalyzeCleanup(), true);
  await coordinator.handleAnalyzeRemovalImpact({ requestId: 'member-removal', packages: ['foo'] });
  const result = messages.findLast((message) => message.status === 'removal-impact-result');
  assert.deepEqual(result.assessments[0].assessment, {
    status: 'blocked',
    evidence: [{ kind: 'peer-requirement', summary: 'consumer requires this package as a peer dependency',
      requiredBy: 'consumer', requestedRange: '^2.0.0', optional: false }],
  });
  assert.equal(coordinator.smartCleanupRemovalEvidence('member-removal', ['foo']), null);
});

test('project loading and the row pipeline carry each npm member location', async () => {
  const folder = { id: 'workspace', name: 'workspace', path: fixtureRoot };
  const platform = {
    workspaceFolders: () => [folder],
    findFiles: async ({ include }) => include === '**/package.json'
      ? ['', 'packages/app/', 'packages/hoisted/', 'packages/a/b/'].map((prefix) => path.join(fixtureRoot, prefix, 'package.json'))
      : [path.join(fixtureRoot, 'package-lock.json')],
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => true,
  };
  const candidates = await discoverProjects(platform);
  const json = (value) => ({ status: 200, headers: {}, body: JSON.stringify(value) });
  const httpClient = {
    get: async (url) => json(url.includes('api.github.com') ? [] : url.endsWith('/latest') ? { version: '3.0.0' } : {
      'dist-tags': { latest: '3.0.0' }, versions: { '1.0.0': {}, '2.0.0': {}, '3.0.0': {} },
    }),
    post: async () => json({ foo: [{
      id: 2, severity: 'high', title: 'Member version advisory',
      url: 'https://example.test/advisory', vulnerable_versions: '2.0.0',
    }] }),
  };
  for (const [memberPath, version] of [['', '1.0.0'], ['packages/app', '2.0.0'], ['packages/hoisted', '1.0.0'], ['packages/a/b', '3.0.0']]) {
    const project = await loadProject(platform, candidates.find((candidate) => candidate.dir === memberPath));
    assert.equal(project.importerId, memberPath || '.');
    assert.equal(project.lockfileRoot, path.normalize(fixtureRoot));
    const result = await buildPackageRows({
      ...project, httpClient, etagStore: new MemoryEtagStore(), auditUnavailableWhenOmitted: false,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].current, version);
    assert.deepEqual(result.rows[0].advisories.map(({ flaggedVersion }) => flaggedVersion), version === '2.0.0' ? ['2.0.0'] : []);
  }
});
