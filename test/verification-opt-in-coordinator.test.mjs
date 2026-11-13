/** Verification suggestions through the coordinator: analysis payload and confirm-time acceptance. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvedTarget } from './helpers/mutation-target.mjs';

const SCRIPTS = { build: 'tsc', test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .', dev: 'vite' };

function makeCoordinator(UpgradeAssistantCoordinator, { setting = [], trusted = true, evidenceCurrent = () => true } = {}) {
  const manifestText = JSON.stringify({ dependencies: { react: '^18.0.0' }, scripts: SCRIPTS });
  const source = {
    manifestText,
    lockfileText: JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { react: '^18.0.0' } }, 'node_modules/react': { version: '18.2.0' } },
    }),
    lockfilePath: '/nonexistent-packageawy-fixture/package-lock.json',
    lockfileName: 'package-lock.json',
    registry: 'https://registry.npmjs.org/',
    resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
    packageManager: 'npm',
    importerId: '.',
    mutationTarget: resolvedTarget('/nonexistent-packageawy-fixture'),
  };
  const messages = [];
  const updates = [];
  const platform = {
    getSetting: (key, fallback) => (key === 'upgrade.verificationScripts' ? setting : fallback),
    isWorkspaceTrusted: () => trusted,
    async updateWorkspaceSetting(key, value) {
      updates.push([key, value]);
    },
    showWarningMessage: () => undefined,
  };
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root: '/nonexistent-packageawy-fixture',
      upgradeSource: source,
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
    getSelectedProject: () => ({
      id: 'project',
      dir: '',
      folder: { id: 'file:///nonexistent-packageawy-fixture', name: 'fixture', path: '/nonexistent-packageawy-fixture' },
    }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    smartCleanupRemovalEvidence: () => ({ isCurrent: evidenceCurrent }),
    loadProject: async () => ({ root: '/nonexistent-packageawy-fixture', ...source }),
  });
  return { coordinator, messages, updates };
}

async function analyze(fixture) {
  await fixture.coordinator.handleAnalyzeSmartCleanupRemove({
    requestId: 'cleanup',
    removalRequestId: 'impact',
    packages: ['react'],
  });
  const review = fixture.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(review, 'the removal review was posted');
  return review.analysis;
}

test('an unconfigured removal review carries host-detected suggestions', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const analysis = await analyze(makeCoordinator(UpgradeAssistantCoordinator));
  assert.deepEqual(analysis.verification, { configured: false, suggestedScriptNames: ['build', 'lint'] });
});

test('a configured setting replaces suggestions', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const analysis = await analyze(makeCoordinator(UpgradeAssistantCoordinator, { setting: ['lint'] }));
  assert.deepEqual(analysis.verification, { configured: true, scriptNames: ['lint'] });
});

test('remember persists only suggested names, and only for a trusted workspace', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');

  const trusted = makeCoordinator(UpgradeAssistantCoordinator);
  const reviewed = await analyze(trusted);
  await trusted.coordinator.handleConfirmRemove({
    analysisId: reviewed.analysisId,
    verificationScripts: ['lint', 'test', 'dev', 'postinstall'],
    rememberVerificationScripts: true,
  });
  assert.deepEqual(trusted.updates, [['upgrade.verificationScripts', ['lint']]]);
  assert.equal(trusted.coordinator.isBusy(), false, 'the run released its reservation');

  const untrusted = makeCoordinator(UpgradeAssistantCoordinator, { trusted: false });
  const untrustedReview = await analyze(untrusted);
  await untrusted.coordinator.handleConfirmRemove({
    analysisId: untrustedReview.analysisId,
    verificationScripts: ['build'],
    rememberVerificationScripts: true,
  });
  assert.deepEqual(untrusted.updates, []);
});

test('a review that fails its confirm-time checks saves nothing', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  let current = true;
  const fixture = makeCoordinator(UpgradeAssistantCoordinator, { evidenceCurrent: () => current });
  const reviewed = await analyze(fixture);
  current = false;
  await fixture.coordinator.handleConfirmRemove({
    analysisId: reviewed.analysisId,
    verificationScripts: ['build'],
    rememberVerificationScripts: true,
  });
  assert.equal(fixture.messages.findLast((message) => message.status === 'remove-error').error.code, 'STALE_ANALYSIS');
  assert.deepEqual(fixture.updates, []);
});
