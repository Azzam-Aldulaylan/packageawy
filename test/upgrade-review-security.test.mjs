import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { auditUpgradeReview } from '../out/host/upgradeReviewSecurity.js';
import { summarizeUpgradeSecurity, requiresSecurityAcknowledgement } from '../out/host/upgradeSecuritySummary.js';
import { IsolatedResolverVerifier } from '../out/host/resolverVerifier.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../out/host/webviewProtocol.js';

function graph(version, { child = false, alias = false, extra = false } = {}) {
  const manifest = { dependencies: { app: alias ? `npm:real-app@${version}` : version, ...(extra ? { added: '2.0.0' } : {}) } };
  const packages = { '': manifest, 'node_modules/app': { version, ...(alias ? { name: 'real-app' } : {}), ...(child ? { dependencies: { child: '3.0.0' } } : {}) },
    ...(child ? { 'node_modules/child': { version: '3.0.0' } } : {}), ...(extra ? { 'node_modules/added': { version: '2.0.0' } } : {}) };
  return buildDependencyGraph({ root: '/fixture', manifest: parseManifest(JSON.stringify(manifest)),
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages }), packageManager: 'npm' });
}
const advisory = (range = '>=2', severity = 'high') => ({ id: 100, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Fixture vulnerability', severity, vulnerable_versions: range });
async function audit(before, after, response = { app: [advisory()] }, overrides = {}) {
  const requests = [];
  const security = await auditUpgradeReview({ before, after, signal: new AbortController().signal, enabled: () => true,
    client: { post: async (url, body) => { requests.push({ url, body: JSON.parse(body) }); return { status: 200, body: JSON.stringify(response) }; } }, ...overrides });
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-partial', requestId: 'review', package: 'app', section: { kind: 'security', security } }), true);
  return { security, requests };
}

test('a clean installed package whose target is vulnerable gets one full before/after union request', async () => {
  const { security, requests } = await audit(graph('1.0.0'), graph('2.0.0'));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { app: ['1.0.0', '2.0.0'] });
  assert.equal(security.introduced.length, 1);
  assert.equal(security.introduced[0].resolvedVersion, '2.0.0');
  assert.deepEqual(security.introduced[0].path, ['app']);
  assert.equal(requiresSecurityAcknowledgement(security), true);
  assert.equal(summarizeUpgradeSecurity(security).beforeCount, 0);
  assert.equal(summarizeUpgradeSecurity(security).afterLabel, '1');
});

test('a newly added vulnerable transitive is included and attributed as transitive', async () => {
  const { security, requests } = await audit(graph('1.0.0'), graph('2.0.0', { child: true }), { child: [advisory()] });
  assert.deepEqual(requests[0].body.child, ['3.0.0']);
  assert.equal(security.introduced[0].flaggedPackage, 'child');
  assert.deepEqual(security.introduced[0].path, ['app', 'child']);
});

test('resolved findings and unchanged findings retain their separate counts', async () => {
  const change = { packageName: 'app', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'prod' };
  const fixed = (await audit(graph('1.0.0'), graph('2.0.0'), { app: [advisory('<2')] }, { proposal: { requested: change, changes: [change] } })).security;
  assert.equal(fixed.status, 'resolved');
  assert.equal(fixed.resolvedAdvisories.length, 1);
  assert.equal(fixed.remaining.length, 0);
  assert.equal(fixed.contexts[0].provenResolution.directDependencyChanges[0].targetVersion, '2.0.0');
  const unchanged = (await audit(graph('1.0.0'), graph('2.0.0'), { app: [advisory('*')] })).security;
  assert.equal(unchanged.remaining.length, 1);
  assert.equal(unchanged.introduced.length, 0);
  assert.equal(unchanged.remaining[0].resolvedVersion, '2.0.0');
  assert.equal(requiresSecurityAcknowledgement(unchanged), false);
});

test('coordinated planner additions and bulk-substituted versions are audited from their proposed graph', async () => {
  const coordinated = await audit(graph('1.0.0'), graph('2.0.0', { extra: true }), { added: [advisory()] });
  assert.equal(coordinated.security.introduced[0].flaggedPackage, 'added');
  assert.equal(requiresSecurityAcknowledgement(coordinated.security), true);
  const bulk = await audit(graph('1.0.0'), graph('4.0.0'), { app: [advisory('>=4')] });
  assert.deepEqual(bulk.requests[0].body.app, ['1.0.0', '4.0.0']);
  assert.equal(bulk.security.introduced[0].resolvedVersion, '4.0.0');
});

test('aliases submit registry identity while evidence retains installed paths', async () => {
  const { security, requests } = await audit(graph('1.0.0', { alias: true }), graph('2.0.0', { alias: true }), { 'real-app': [advisory()] });
  assert.deepEqual(requests[0].body, { 'real-app': ['1.0.0', '2.0.0'] });
  assert.equal(security.introduced[0].flaggedPackage, 'real-app');
  assert.deepEqual(security.introduced[0].path, ['app']);
});

test('resolver and advisory failures stay unavailable, and Off sends nothing', async () => {
  const resolution = await audit(graph('1.0.0'), undefined);
  assert.equal(resolution.requests.length, 0);
  assert.equal(resolution.security.checkState, 'unavailable');
  const advisoryFailure = await audit(graph('1.0.0'), graph('2.0.0'), {}, { client: { post: async () => { throw new Error('offline'); } } });
  assert.equal(advisoryFailure.security.status, 'unknown');
  assert.equal(summarizeUpgradeSecurity(advisoryFailure.security).afterLabel, 'Security check unavailable');
  const off = await audit(graph('1.0.0'), graph('2.0.0'), {}, { enabled: () => false });
  assert.equal(off.requests.length, 0);
  assert.equal(off.security.checkState, 'off');
  assert.equal(summarizeUpgradeSecurity(off.security).afterLabel, 'Off');
});

test('the advisory setting is read again at dispatch time', async () => {
  let reads = 0;
  const result = await audit(graph('1.0.0'), graph('2.0.0'), {}, { enabled: () => ++reads === 1 });
  assert.equal(reads, 2);
  assert.equal(result.requests.length, 0);
  assert.equal(result.security.checkState, 'off');
});

for (const manager of ['npm', 'pnpm']) {
test(`${manager} compatibility and review security share one materialized resolver graph per exact proposal`, async () => {
  let runs = 0;
  const verifier = new IsolatedResolverVerifier({ packageManager: manager, packageManagerVersion: '10',
    invocation: { executable: 'fake', prefixArgs: [] }, manifestText: JSON.stringify({ dependencies: { app: '^1', added: '^1' } }),
    registry: 'https://registry.npmjs.org', policy: {}, retainResolvedGraph: true,
    runner: { run: async (_, args, cwd) => {
      runs++;
      assert.ok(args.includes(manager === 'npm' ? '--package-lock-only' : '--lockfile-only'));
      if (manager === 'pnpm') await writeFile(`${cwd}/pnpm-lock.yaml`, `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      app:
        specifier: 2.0.0
        version: 2.0.0
packages:
  app@2.0.0: {}
snapshots:
  app@2.0.0: {}
`);
      else await writeFile(`${cwd}/package-lock.json`, JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies: { app: '2.0.0' } }, 'node_modules/app': { version: '2.0.0' },
      } }));
      return { exitCode: 0, stdout: '', stderr: '' };
    } },
  });
  const change = { packageName: 'app', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'prod' };
  const proposal = { requested: change, changes: [change] };
  assert.equal((await verifier.verify(proposal)).status, 'compatible');
  const resolved = await verifier.materializeResolvedGraph(proposal);
  assert.equal(resolved.ok, true);
  assert.ok([...resolved.graph.nodes.values()].some(node => node.name === 'app' && node.version === '2.0.0'));
  await verifier.materializeResolvedGraph(structuredClone(proposal));
  assert.equal(runs, 1);
  await verifier.verify({ ...proposal, changes: [change, { ...change, packageName: 'added' }] });
  assert.equal(runs, 2, 'a changed coordinated proposal has its own resolver evidence');
});
}

for (const coordinated of [false, true]) {
  test(`host refuses unacknowledged introduced high findings for ${coordinated ? 'coordinated' : 'single'} confirmation`, async () => {
    const { security } = await audit(graph('1.0.0'), graph('2.0.0'));
    const messages = [];
    let executions = 0;
    const coordinator = new UpgradeAssistantCoordinator({ platform: {}, sink: { postMessage: message => messages.push(message) },
      ensureController: async () => { executions++; return undefined; }, getSelectedProject: () => undefined,
      isDisposed: () => false, flushDeferredChanges: async () => {}, reloadFinalState: async () => {} });
    coordinator.analysis = { id: 'review', expiresAt: Date.now() + 60_000, security,
      eligibility: { packageName: 'app' }, compatibilityStatus: coordinated ? 'conflict' : 'compatible',
      smartPlanProposal: coordinated ? { changes: [] } : null, proposal: { changes: [] } };
    const confirm = coordinated ? 'handleUseSmartPlan' : 'handleConfirmUpgrade';
    await coordinator[confirm]({ analysisId: 'review' });
    assert.equal(messages.at(-1).error.code, 'SECURITY_ACKNOWLEDGEMENT_REQUIRED');
    assert.equal(executions, 0);
    assert.ok(coordinator.analysis, 'refusal leaves the review available for acknowledgement');
    const request = { type: coordinated ? 'use-smart-plan' : 'confirm-upgrade', analysisId: 'review', securityAcknowledged: true };
    assert.equal(isWebviewToHostMessage(request), true);
    assert.equal(isWebviewToHostMessage({ ...request, securityAcknowledged: 'true' }), false);
    await coordinator[confirm](request);
    assert.equal(executions, 1);
    assert.equal(coordinator.analysis, undefined);
  });
}

test('introduced advisory links use review-owned evidence and reject forged paths and references', async () => {
  const { security } = await audit(graph('1.0.0'), graph('2.0.0', { child: true }), { child: [advisory()] });
  const coordinator = new UpgradeAssistantCoordinator({ platform: {}, isDisposed: () => false });
  coordinator.analysis = { security };
  const request = { package: 'app', advisoryId: 100, path: ['app', 'child'] };
  assert.equal(coordinator.resolveReviewAdvisoryUrl(request), advisory().url);
  assert.equal(coordinator.resolveReviewAdvisoryUrl({ ...request, path: ['app'] }), null);
  assert.equal(coordinator.resolveReviewAdvisoryUrl({ ...request, reference: 'CVE-2026-99999' }), null);
});

test('merged advisory aliases retain the highest severity for acknowledgement', async () => {
  const { security } = await audit(graph('1.0.0'), graph('2.0.0'), { app: [
    { ...advisory('>=2', 'low'), id: 1 }, { ...advisory('>=2', 'critical'), id: 2 },
  ] });
  assert.equal(security.introduced.length, 1);
  assert.equal(security.introduced[0].advisory.severity, 'critical');
  assert.equal(requiresSecurityAcknowledgement(security), true);
});

test('a successful resolver without parseable graph evidence stays unavailable and is not run again', async () => {
  let runs = 0;
  const verifier = new IsolatedResolverVerifier({ packageManager: 'npm', packageManagerVersion: '10',
    invocation: { executable: 'fake', prefixArgs: [] }, manifestText: JSON.stringify({ dependencies: { app: '^1' } }),
    registry: 'https://registry.npmjs.org', policy: {}, retainResolvedGraph: true,
    runner: { run: async () => { runs++; return { exitCode: 0, stdout: '', stderr: '' }; } },
  });
  const change = { packageName: 'app', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'prod' };
  const proposal = { requested: change, changes: [change] };
  await verifier.verify(proposal);
  assert.deepEqual(await verifier.materializeResolvedGraph(proposal), { ok: false });
  assert.equal(runs, 1);
});

test('finding versions correspond to the displayed path when several vulnerable copies exist', async () => {
  const manifest = { dependencies: { app: '2.0.0', carrier: '1.0.0' } };
  const after = buildDependencyGraph({ root: '/fixture', manifest: parseManifest(JSON.stringify(manifest)), packageManager: 'npm',
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages: {
      '': manifest, 'node_modules/app': { version: '2.0.0' },
      'node_modules/carrier': { version: '1.0.0', dependencies: { app: '1.0.0' } },
      'node_modules/carrier/node_modules/app': { version: '1.0.0' },
    } }) });
  const { security } = await audit(graph('0.5.0'), after, { app: [advisory('>=1')] });
  assert.deepEqual(security.introduced[0].path, ['app']);
  assert.equal(security.introduced[0].resolvedVersion, '2.0.0');
});
