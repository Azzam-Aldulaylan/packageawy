import assert from 'node:assert/strict';
import test from 'node:test';
import { auditInstalledPeer, peerGraph, peerAdvisories } from './helpers/installed-peer-security.mjs';
import { attributeAdvisories, advisoryCoverageByRoot } from '../out/core/advisories/attribution.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { buildInstallPathIndex } from '../out/core/graph/paths.js';

test('auto-installed peers and their descendants are introduced with installed paths and versions', async () => {
  const security = await auditInstalledPeer();
  assert.equal(security.checkState, 'complete');
  assert.deepEqual(security.introduced.map(entry => [entry.flaggedPackage, entry.path, entry.resolvedVersion]).sort(), [
    ['child', ['app', 'peer', 'child'], '4.0.0'], ['peer', ['app', 'peer'], '3.0.0'],
  ]);
  assert.deepEqual(security.remaining, []);
  assert.deepEqual(security.resolvedAdvisories, []);
  assert.equal(buildInstallPathIndex(peerGraph(true)).distance.has('node_modules/peer'), false,
    'hygiene paths retain their installation-reason policy');
});

test('dashboard security attributes the same installed peers and excludes absent peers and orphans', () => {
  const graph = peerGraph(true);
  const advisories = new Map(Object.entries(peerAdvisories).map(([name, entries]) => [name,
    entries.map(({ vulnerable_versions, ...entry }) => ({ ...entry, vulnerableVersions: vulnerable_versions }))]));
  const attributed = attributeAdvisories(graph, advisories).get('app');
  assert.deepEqual(attributed.map(entry => [entry.flaggedPackage, entry.path, entry.flaggedVersion]), [
    ['peer', ['app', 'peer'], '3.0.0'], ['child', ['app', 'peer', 'child'], '4.0.0'],
  ]);
  assert.equal(advisoryCoverageByRoot(graph).get('app'), 'complete', 'absent optional peers need no coverage');
  graph.nodes.get('node_modules/child').version = null;
  assert.equal(advisoryCoverageByRoot(graph).get('app'), 'partial', 'installed peer descendants need version coverage');
});

for (const coordinated of [false, true]) {
  test(`host requires acknowledgement of installed peers for ${coordinated ? 'coordinated' : 'single'} confirm`, async () => {
    const security = await auditInstalledPeer();
    const messages = [];
    let executions = 0;
    const coordinator = new UpgradeAssistantCoordinator({ platform: {}, sink: { postMessage: message => messages.push(message) },
      ensureController: async () => { executions++; return undefined; }, getSelectedProject: () => undefined,
      isDisposed: () => false, flushDeferredChanges: async () => {}, reloadFinalState: async () => {} });
    coordinator.analysis = { id: 'review', expiresAt: Date.now() + 60_000, security,
      eligibility: { packageName: 'app' }, compatibilityStatus: coordinated ? 'conflict' : 'compatible',
      smartPlanProposal: coordinated ? { changes: [] } : null, proposal: { changes: [] } };
    await coordinator[coordinated ? 'handleUseSmartPlan' : 'handleConfirmUpgrade']({ analysisId: 'review' });
    assert.equal(messages.at(-1)?.error.code, 'SECURITY_ACKNOWLEDGEMENT_REQUIRED');
    assert.equal(executions, 0);
    coordinator.handleCancelUpgrade({ analysisId: 'review' });
  });
}
