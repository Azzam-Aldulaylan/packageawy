import assert from 'node:assert/strict';
import test from 'node:test';
import { auditUpgradeReview } from '../out/host/upgradeReviewSecurity.js';
import { summarizeUpgradeSecurity, requiresSecurityAcknowledgement } from '../out/host/upgradeSecuritySummary.js';
import { deriveUpgradeReviewDecision } from '../out/host/upgradeReviewDecision.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

// A project whose unrelated packages carry known vulnerabilities, plus a clean
// upgrade target. Each entry is [lockfile path, version, dependencies].
function npmGraph(dependencies, entries) {
  const manifest = { dependencies };
  const packages = { '': manifest };
  for (const [key, version, deps, extra] of entries) {
    packages[key] = { version, ...(deps === undefined ? {} : { dependencies: deps }), ...(extra ?? {}) };
  }
  return buildDependencyGraph({ root: '/fixture', manifest: parseManifest(JSON.stringify(manifest)),
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages }), packageManager: 'npm' });
}

const unrelated = [
  ['node_modules/express', '4.17.0', { lodash: '4.17.20' }],
  ['node_modules/lodash', '4.17.20'],
  ['node_modules/minimist', '1.2.0'],
];
const project = (target, extra = []) => npmGraph(
  { 'date-fns': target, express: '4.17.0', minimist: '1.2.0' },
  [['node_modules/date-fns', target], ...unrelated, ...extra]
);

let nextId = 1;
const advisory = (range, severity = 'high', title = 'Fixture vulnerability') => {
  const id = nextId++;
  return { id, url: `https://github.com/advisories/GHSA-0000-0000-${String(id).padStart(4, '0')}`, title, severity, vulnerable_versions: range };
};
const unrelatedAdvisories = () => ({
  lodash: [advisory('<4.17.21', 'critical', 'Prototype pollution'), advisory('<4.17.21', 'high', 'Command injection')],
  minimist: [advisory('<1.2.6', 'critical', 'Prototype pollution')],
});

async function audit(before, after, response, proposal) {
  const security = await auditUpgradeReview({ before, after, proposal, signal: new AbortController().signal, enabled: () => true,
    client: { post: async () => ({ status: 200, body: JSON.stringify(response) }) } });
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-partial', requestId: 'review', package: 'date-fns', section: { kind: 'security', security } }), true);
  return security;
}
const change = (packageName, currentVersion, targetVersion) => ({ packageName, currentVersion, targetVersion, classification: 'prod' });
const single = (packageName, currentVersion, targetVersion) => {
  const entry = change(packageName, currentVersion, targetVersion);
  return { requested: entry, changes: [entry] };
};
const decisionFor = (security) => deriveUpgradeReviewDecision({
  compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
  projectCompatibility: { identity: { packageName: 'date-fns', currentVersion: '3.6.0', targetVersion: '4.4.0' },
    analyzers: [{ analyzerId: 'runtime-compatibility', status: 'complete' }, { analyzerId: 'import-compatibility', status: 'complete' }], findings: [] },
  security,
});

test('a clean target in a project with unrelated vulnerabilities reports none for this upgrade', async () => {
  const security = await audit(project('3.6.0'), project('4.4.0'), unrelatedAdvisories(), single('date-fns', '3.6.0', '4.4.0'));
  assert.equal(security.checkState, 'complete');
  assert.equal(security.status, 'not-applicable');
  assert.deepEqual(security.remaining, []);
  assert.deepEqual(security.introduced, []);
  assert.deepEqual(security.resolvedAdvisories, []);
  assert.deepEqual(security.contexts ?? [], []);
  assert.equal(security.unaffectedElsewhereCount, 3);
  const summary = summarizeUpgradeSecurity(security);
  assert.equal(summary.beforeCount, 0);
  assert.equal(summary.confirmedRemainingCount, 0);
  assert.equal(summary.afterLabel, '0');
  assert.equal(requiresSecurityAcknowledgement(security), false);
  const decision = decisionFor(security);
  assert.equal(decision.caution, false);
  assert.equal(decision.headline.className, 'compatible');
  assert.doesNotMatch(decision.recommendation, /remain/);
  assert.match(decision.recommendation, /No known vulnerabilities/);
});

test('the target\'s own unchanged vulnerability remains while unrelated ones stay out of the count', async () => {
  const response = { ...unrelatedAdvisories(), 'date-fns': [advisory('*', 'moderate', 'Target issue')] };
  const security = await audit(project('3.6.0'), project('4.4.0'), response, single('date-fns', '3.6.0', '4.4.0'));
  assert.equal(security.status, 'remains');
  assert.deepEqual(security.remaining.map((entry) => entry.flaggedPackage), ['date-fns']);
  assert.deepEqual(security.contexts.map((entry) => entry.flaggedPackage), ['date-fns']);
  assert.equal(security.unaffectedElsewhereCount, 3);
  assert.equal(summarizeUpgradeSecurity(security).beforeCount, 1);
  assert.match(decisionFor(security).recommendation, /1 known vulnerability remains/);
});

test('an unchanged vulnerable dependency of the target remains in scope', async () => {
  const before = project('3.6.0', [['node_modules/helper', '1.0.0']]);
  const after = project('4.4.0', [['node_modules/helper', '1.0.0']]);
  // date-fns depends on helper in both graphs.
  for (const graph of [before, after]) {
    const target = graph.nodes.get('node_modules/date-fns');
    target.deps.push('helper');
    target.edges.push({ name: 'helper', kind: 'runtime', targetNodeId: 'node_modules/helper' });
  }
  const response = { ...unrelatedAdvisories(), helper: [advisory('*', 'low', 'Helper issue')] };
  const security = await audit(before, after, response, single('date-fns', '3.6.0', '4.4.0'));
  assert.deepEqual(security.remaining.map((entry) => entry.flaggedPackage), ['helper']);
  assert.deepEqual(security.remaining[0].path, ['date-fns', 'helper']);
  assert.equal(security.unaffectedElsewhereCount, 3);
});

test('a vulnerable package reached both through the target and elsewhere is in scope', async () => {
  const shared = (target) => npmGraph({ 'date-fns': target, express: '4.17.0', minimist: '1.2.0' }, [
    ['node_modules/date-fns', target, { lodash: '4.17.20' }], ...unrelated,
  ]);
  const security = await audit(shared('3.6.0'), shared('4.4.0'), unrelatedAdvisories(), single('date-fns', '3.6.0', '4.4.0'));
  assert.deepEqual(security.remaining.map((entry) => entry.flaggedPackage).sort(), ['lodash', 'lodash']);
  assert.equal(security.unaffectedElsewhereCount, 1);
});

test('fixes and additions outside the target stay project-wide', async () => {
  const before = project('3.6.0');
  const after = project('4.4.0', [['node_modules/fresh', '1.0.0']]);
  after.nodes.get('node_modules/lodash').version = '4.17.21';
  const target = after.nodes.get('node_modules/date-fns');
  target.deps.push('fresh');
  target.edges.push({ name: 'fresh', kind: 'runtime', targetNodeId: 'node_modules/fresh' });
  const response = { ...unrelatedAdvisories(), fresh: [advisory('*', 'critical', 'New issue')] };
  const security = await audit(before, after, response, single('date-fns', '3.6.0', '4.4.0'));
  assert.equal(security.resolvedAdvisories.length, 2);
  assert.deepEqual(security.introduced.map((entry) => entry.flaggedPackage), ['fresh']);
  assert.deepEqual(security.remaining, []);
  assert.equal(security.unaffectedElsewhereCount, 1);
  assert.equal(requiresSecurityAcknowledgement(security), true);
});

test('bulk and coordinated proposals scope remaining findings to every changed target', async () => {
  const graphFor = (target, minimist) => npmGraph({ 'date-fns': target, express: '4.17.0', minimist }, [
    ['node_modules/date-fns', target], ...unrelated.slice(0, 2), ['node_modules/minimist', minimist],
  ]);
  const bulk = { requested: change('date-fns', '3.6.0', '4.4.0'),
    changes: [change('date-fns', '3.6.0', '4.4.0'), change('minimist', '1.2.0', '1.2.5')] };
  const security = await audit(graphFor('3.6.0', '1.2.0'), graphFor('4.4.0', '1.2.5'), unrelatedAdvisories(), bulk);
  assert.deepEqual(security.remaining.map((entry) => entry.flaggedPackage), ['minimist']);
  assert.equal(security.unaffectedElsewhereCount, 2);
});

test('an aliased target is matched by its installed name', async () => {
  const aliased = (target) => npmGraph({ dates: `npm:date-fns@${target}`, express: '4.17.0', minimist: '1.2.0' }, [
    ['node_modules/dates', target, undefined, { name: 'date-fns' }], ...unrelated,
  ]);
  const response = { ...unrelatedAdvisories(), 'date-fns': [advisory('*', 'moderate', 'Target issue')] };
  const security = await audit(aliased('3.6.0'), aliased('4.4.0'), response, single('dates', '3.6.0', '4.4.0'));
  assert.deepEqual(security.remaining.map((entry) => entry.flaggedPackage), ['date-fns']);
  assert.deepEqual(security.remaining[0].path, ['dates']);
  assert.equal(security.unaffectedElsewhereCount, 3);
});

test('pnpm reviews apply the same scope', async () => {
  const pnpm = (target) => buildDependencyGraph({ root: '/fixture',
    manifest: parseManifest(JSON.stringify({ dependencies: { 'date-fns': target, minimist: '1.2.0' } })),
    lockfileText: `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      date-fns:
        specifier: ${target}
        version: ${target}
      minimist:
        specifier: 1.2.0
        version: 1.2.0
packages:
  date-fns@${target}: {}
  minimist@1.2.0: {}
snapshots:
  date-fns@${target}: {}
  minimist@1.2.0: {}
`, packageManager: 'pnpm' });
  const security = await audit(pnpm('3.6.0'), pnpm('4.4.0'), unrelatedAdvisories(), single('date-fns', '3.6.0', '4.4.0'));
  assert.equal(security.status, 'not-applicable');
  assert.deepEqual(security.remaining, []);
  assert.equal(security.unaffectedElsewhereCount, 1);
});

test('remaining evidence shows the copy reached through the upgrade, not an unrelated copy', async () => {
  const graphFor = (app) => npmGraph({ app, aaa: '1.0.0' }, [
    ['node_modules/aaa', '1.0.0', { helper: '1.0.0' }],
    ['node_modules/helper', '1.0.0'],
    ['node_modules/app', app, { helper: '2.0.0' }],
    ['node_modules/app/node_modules/helper', '2.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0'), graphFor('2.0.0'), response, single('app', '1.0.0', '2.0.0'));
  assert.equal(security.remaining.length, 1);
  assert.deepEqual(security.remaining[0].path, ['app', 'helper']);
  assert.equal(security.remaining[0].resolvedVersion, '2.0.0');
  assert.equal(security.contexts[0].flaggedVersion, '2.0.0');
});

test('an npm dependency also declared as a peer keeps its dependency edge', async () => {
  const graphFor = (app) => npmGraph({ app, helper: '1.0.0' }, [
    ['node_modules/app', app, { helper: '1.0.0' }, { peerDependencies: { helper: '^1.0.0' } }],
    ['node_modules/helper', '1.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0'), graphFor('2.0.0'), response, single('app', '1.0.0', '2.0.0'));
  assert.deepEqual(security.remaining.map((entry) => entry.path), [['app', 'helper']]);
});

test('Before evidence for a remaining finding lists only the paths through the upgrade', async () => {
  const graphFor = (app) => npmGraph({ app, aaa: '1.0.0' }, [
    ['node_modules/aaa', '1.0.0', { helper: '1.0.0' }],
    ['node_modules/helper', '1.0.0'],
    ['node_modules/app', app, { helper: '1.0.0' }],
    ['node_modules/app/node_modules/helper', '1.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0'), graphFor('2.0.0'), response, single('app', '1.0.0', '2.0.0'));
  assert.deepEqual(security.remaining.map((entry) => entry.path), [['app', 'helper']]);
  assert.equal(security.contexts.length, 1);
  assert.deepEqual(security.contexts[0].primaryPath.nodes.map((node) => node.packageName), ['app', 'helper']);
  assert.deepEqual(security.contexts[0].paths.map((path) => path.nodes.map((node) => node.packageName)), [['app', 'helper']]);
  assert.deepEqual(security.contexts[0].directRoots.map((root) => root.packageName), ['app']);
});

test('a finding first reached through the target after the upgrade has no unrelated Before evidence', async () => {
  const graphFor = (app) => npmGraph({ app, other: '1.0.0' }, [
    ['node_modules/app', app, app === '2.0.0' ? { helper: '1.0.0' } : undefined],
    ['node_modules/other', '1.0.0', { helper: '1.0.0' }],
    ['node_modules/helper', '1.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0'), graphFor('2.0.0'), response, single('app', '1.0.0', '2.0.0'));
  assert.deepEqual(security.remaining.map((entry) => entry.path), [['app', 'helper']]);
  assert.deepEqual(security.contexts, []);
});

const pnpmPeerProject = (plugin) => buildDependencyGraph({ root: '/fixture',
  manifest: parseManifest(JSON.stringify({ dependencies: { plugin, framework: '1.0.0' } })),
  lockfileText: `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      plugin:
        specifier: ${plugin}
        version: ${plugin}(framework@1.0.0)
      framework:
        specifier: 1.0.0
        version: 1.0.0
packages:
  plugin@${plugin}:
    peerDependencies:
      framework: ^1.0.0
  framework@1.0.0: {}
snapshots:
  plugin@${plugin}(framework@1.0.0):
    dependencies:
      framework: 1.0.0
  framework@1.0.0: {}
`, packageManager: 'pnpm' });

test('changes outside the targets do not bring unrelated findings into scope', async () => {
  // The resolved plan also moves express to a new body-parser, which still uses the vulnerable lodash.
  const graphFor = (target, parserVersion) => npmGraph({ 'date-fns': target, express: '4.17.0', minimist: '1.2.0' }, [
    ['node_modules/date-fns', target],
    ['node_modules/express', '4.17.0', { 'body-parser': parserVersion }],
    ['node_modules/body-parser', parserVersion, { lodash: '4.17.20' }],
    ['node_modules/lodash', '4.17.20'],
    ['node_modules/minimist', '1.2.0'],
  ]);
  const security = await audit(graphFor('3.6.0', '1.0.0'), graphFor('4.4.0', '1.1.0'), unrelatedAdvisories(), single('date-fns', '3.6.0', '4.4.0'));
  assert.deepEqual(security.remaining, []);
  assert.equal(security.beforeCount, 0);
  assert.equal(security.unaffectedElsewhereCount, 3);
});

test('peer edges from a target count on npm and pnpm', async () => {
  const response = () => ({ framework: [advisory('*', 'high', 'Framework issue')] });
  const pnpm = await audit(pnpmPeerProject('1.0.0'), pnpmPeerProject('2.0.0'), response(), single('plugin', '1.0.0', '2.0.0'));
  assert.deepEqual(pnpm.remaining.map((entry) => entry.path), [['plugin', 'framework']]);
  const peerProject = (plugin, direct) => npmGraph({ plugin, ...(direct ? { framework: '1.0.0' } : {}) }, [
    ['node_modules/plugin', plugin, undefined, { peerDependencies: { framework: '^1.0.0' } }],
    ['node_modules/framework', '1.0.0', undefined, direct ? {} : { peer: true }],
  ]);
  for (const direct of [true, false]) {
    const npm = await audit(peerProject('1.0.0', direct), peerProject('2.0.0', direct), response(), single('plugin', '1.0.0', '2.0.0'));
    assert.deepEqual(npm.remaining.map((entry) => entry.path), [['plugin', 'framework']]);
  }
});

test('a coordinated plan that moves a direct framework counts it as a target', async () => {
  const graphFor = (plugin, framework) => npmGraph({ plugin, framework, other: '1.0.0', more: '1.0.0' }, [
    ['node_modules/plugin', plugin],
    ['node_modules/framework', framework],
    ['node_modules/other', '1.0.0', { framework: '1.0.0' }],
    ['node_modules/other/node_modules/framework', '1.0.0'],
    ['node_modules/more', '1.0.0', { framework: '2.0.0' }],
    ['node_modules/more/node_modules/framework', '2.0.0'],
  ]);
  const plan = { requested: change('plugin', '1.0.0', '2.0.0'),
    changes: [change('plugin', '1.0.0', '2.0.0'), change('framework', '1.0.0', '2.0.0')] };
  const response = { framework: [advisory('*', 'high', 'Framework issue')] };
  const security = await audit(graphFor('1.0.0', '1.0.0'), graphFor('2.0.0', '2.0.0'), response, plan);
  assert.deepEqual(security.remaining.map((entry) => entry.path), [['framework']]);
  assert.equal(security.remaining[0].resolvedVersion, '2.0.0');
  assert.equal(security.beforeCount, 1);
});

test('a finding the target stops reaching counts before the upgrade and not as remaining', async () => {
  const graphFor = (app, withHelper) => npmGraph({ app, aaa: '1.0.0' }, [
    ['node_modules/app', app, withHelper ? { helper: '1.0.0' } : undefined],
    ['node_modules/aaa', '1.0.0', { helper: '1.0.0' }],
    ['node_modules/helper', '1.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0', true), graphFor('2.0.0', false), response, single('app', '1.0.0', '2.0.0'));
  assert.deepEqual(security.remaining, []);
  assert.equal(security.beforeCount, 1);
  assert.equal(summarizeUpgradeSecurity(security).beforeCount, 1);
  assert.equal(summarizeUpgradeSecurity(security).afterLabel, '0');
  assert.equal(security.unaffectedElsewhereCount, undefined);
  assert.deepEqual(security.contexts.map((context) => context.primaryPath.nodes.map((node) => node.packageName)), [['app', 'helper']]);
  assert.doesNotMatch(decisionFor(security).recommendation, /remain/);
  assert.match(decisionFor(security).recommendation, /no longer reached through it/);
});

test('Before evidence stays within the path limit when many unrelated paths exist', async () => {
  const others = Array.from({ length: 120 }, (_, index) => `other${String(index).padStart(3, '0')}`);
  const graphFor = (app) => npmGraph({ ...Object.fromEntries(others.map((name) => [name, '1.0.0'])), app }, [
    ...others.map((name) => [`node_modules/${name}`, '1.0.0', { helper: '1.0.0' }]),
    ['node_modules/app', app, { middle: '1.0.0' }],
    ['node_modules/middle', '1.0.0', { helper: '1.0.0' }],
    ['node_modules/helper', '1.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0'), graphFor('2.0.0'), response, single('app', '1.0.0', '2.0.0'));
  assert.equal(security.contexts.length, 1);
  const [context] = security.contexts;
  assert.ok(context.paths.length >= 1 && context.paths.length <= 100);
  assert.ok(context.paths.every((path) => path.nodes[0].packageName === 'app'));
  assert.deepEqual(context.primaryPath.nodes.map((node) => node.packageName), ['app', 'middle', 'helper']);
});

test('a target path longer than the protocol allows keeps the finding and drops its path evidence', async () => {
  const chain = Array.from({ length: 101 }, (_, index) => `link${String(index).padStart(3, '0')}`);
  const graphFor = (app) => npmGraph({ app, short: '1.0.0' }, [
    ['node_modules/app', app, { [chain[0]]: '1.0.0' }],
    ...chain.map((name, index) => [`node_modules/${name}`, '1.0.0', { [chain[index + 1] ?? 'helper']: '1.0.0' }]),
    ['node_modules/short', '1.0.0', { helper: '1.0.0' }],
    ['node_modules/helper', '1.0.0'],
  ]);
  const response = { helper: [advisory('*', 'high', 'Helper issue')] };
  const security = await audit(graphFor('1.0.0'), graphFor('2.0.0'), response, single('app', '1.0.0', '2.0.0'));
  assert.equal(security.beforeCount, 1);
  assert.equal(security.remaining.length, 1);
  assert.ok(security.contexts.every((context) => context.paths.every((path) => path.nodes.length <= 100)));
});
