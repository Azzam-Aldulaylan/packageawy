import assert from 'node:assert/strict';
import { makeCoordinator, makeProject, review, lockfile } from './removal-project.mjs';

export async function rollbackFixture(t, operation) {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.coordinator.session.invocationResolver = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
  f.state.installExitCode = 1;
  f.state.reinstallChoice = 'Reinstall';
  let confirm;
  if (operation === 'upgrade') {
    const snapshot = await f.read();
    const eligibility = { packageName: 'react', currentVersion: '18.2.0', targetVersion: '18.3.0', classification: 'prod' };
    f.coordinator.options.ensureController = async () => ({ root: project.root, upgradeSource: snapshot,
      validateBulkUpgradeRequest: () => ({ ok: true, upgrades: [eligibility] }) });
    f.coordinator.analysis = { id: 'upgrade', requests: [{ package: 'react', target: '18.3.0' }],
      publishedTargetsByPackage: new Map(), eligibility, snapshot, proposal: { changes: [eligibility] },
      compatibilityStatus: 'compatible', smartPlanProposal: null, security: null, ignoreScripts: true,
      verificationScripts: [], suggestedScriptNames: [], projectCompatibilityEvidenceFingerprint: null,
      expiresAt: Date.now() + 60_000 };
    confirm = () => f.coordinator.handleConfirmUpgrade({ analysisId: 'upgrade' });
  } else if (operation === 'transitive') {
    f.coordinator.options.platform.getSetting = (key, fallback) => key === 'security.publicAdvisoryCheck' ? false : fallback;
    f.coordinator.remediationPlans.set('plan', {
      id: 'plan', packageName: 'react', snapshot: await f.read(), before: {}, targetAdvisories: [],
      proposedLockfileText: lockfile(true).replace('18.2.0', '18.3.1'), packageManagerVersion: null, ignoreScripts: true,
      verificationScripts: [], suggestedScriptNames: [], plan: { automaticApplyAllowed: true, target: { resolved: [] } },
      presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} }, expiresAt: Date.now() + 60_000, stale: false,
    });
    confirm = () => f.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
  } else {
    let analysisId;
    if (operation === 'cleanup') analysisId = await review(f);
    else {
      await f.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
      analysisId = f.messages.findLast(message => message.status === 'remove-analysis')?.analysis.analysisId;
      assert.ok(analysisId);
    }
    confirm = () => f.coordinator.handleConfirmRemove({ analysisId });
  }
  return { ...f, project, confirm };
}
