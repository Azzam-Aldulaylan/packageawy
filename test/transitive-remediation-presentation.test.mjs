import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransitiveRemediationPlan } from '../out/core/advisories/transitiveRemediationPlan.js';
import { buildTransitiveRemediationPresentation } from '../out/host/transitiveRemediationPresentation.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

function edge(name, targetNodeId) {
  return { name, requestedRange: '*', kind: 'runtime', targetNodeId, optional: false };
}

function node(name, path, { version, direct = false, edges = [] }) {
  return { name, version, range: direct ? '*' : '', dev: false, direct, path, deps: edges.map((entry) => entry.name), edges };
}

function pnpmGraph(nodes) {
  return { root: '/project', packageManager: 'pnpm', lockfileVersion: '9.0', nodes: new Map(nodes.map((entry) => [entry.path, entry])) };
}

const minimistIssue = {
  id: 'GHSA-XVCH-5GV4-984H',
  severity: 'critical',
  title: 'Prototype Pollution in minimist',
  url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
  vulnerableVersions: '>=1.0.0 <1.2.6',
  identifiers: [{ type: 'GHSA', value: 'GHSA-XVCH-5GV4-984H' }],
};

// pnpm keys packages by version. rc moves to the minimist 1.2.8 that mkdirp
// already uses, so the only lockfile change is the 1.2.5 entry going away.
const before = pnpmGraph([
  node('rc', 'rc@1.2.8', { version: '1.2.8', direct: true, edges: [edge('minimist', 'minimist@1.2.5')] }),
  node('mkdirp', 'mkdirp@0.5.6', { version: '0.5.6', direct: true, edges: [edge('minimist', 'minimist@1.2.8')] }),
  node('minimist', 'minimist@1.2.5', { version: '1.2.5' }),
  node('minimist', 'minimist@1.2.8', { version: '1.2.8' }),
]);
const after = pnpmGraph([
  node('rc', 'rc@1.2.8', { version: '1.2.8', direct: true, edges: [edge('minimist', 'minimist@1.2.8')] }),
  node('mkdirp', 'mkdirp@0.5.6', { version: '0.5.6', direct: true, edges: [edge('minimist', 'minimist@1.2.8')] }),
  node('minimist', 'minimist@1.2.8', { version: '1.2.8' }),
]);

test('a pnpm fix that reuses an installed version names that version and reaches the webview', () => {
  const advisories = new Map([['minimist', [minimistIssue]]]);
  const plan = createTransitiveRemediationPlan({
    rootPackageName: 'rc',
    targetAdvisories: [{
      advisory: minimistIssue,
      flaggedPackage: 'minimist',
      path: ['rc', 'minimist'],
      flaggedVersion: '1.2.5',
      patchedVersion: { status: 'known', version: '1.2.6' },
    }],
    manifestUnchanged: true,
    before: { graph: before, advisoriesByName: advisories, advisories: 'complete' },
    after: { graph: after, advisoriesByName: advisories, advisories: 'complete' },
  });
  assert.equal(plan.classification, 'full');

  const presentation = buildTransitiveRemediationPresentation({
    analysisId: '0123456789abcdef0123456789abcdef',
    generatedAt: '2026-10-29T08:00:00.000Z',
    expiresAt: '2026-10-29T09:00:00.000Z',
    rootPackage: 'rc',
    currentVersion: '1.2.8',
    packageManager: 'pnpm',
    packageManagerVersion: '9.15.1',
    lifecycleScriptsEnabled: false,
    manifestPath: 'package.json',
    lockfilePath: 'pnpm-lock.yaml',
    plan,
    afterGraph: after,
    targetedPackages: new Set(['minimist']),
    verification: { configured: false },
  });

  const minimist = presentation.changes.find((change) => change.packageName === 'minimist');
  assert.deepEqual(minimist.fromVersions, ['1.2.5']);
  assert.deepEqual(minimist.toVersions, ['1.2.8']);
  assert.equal(isHostToWebviewMessage({ status: 'remediation-plan', package: 'rc', plan: presentation }), true);
});
