import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, makeCoordinator } from './helpers/removal-project.mjs';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { failedRequestSettlement } from '../out/host/failedRequestSettlement.js';

for (const bulk of [false, true]) for (const admissionClosed of [false, true]) {
  test(`${bulk ? 'bulk' : 'single'} upgrade rejection retains request id with admission ${admissionClosed ? 'closed' : 'open'}`, async t => {
    const project = await makeProject(t);
    const locks = new ProjectMutationLocks();
    if (admissionClosed) locks.closeAfterFailure();
    const f = makeCoordinator(project, {
      mutationLocks: locks,
      ensureController: async () => ({
        root: project.root, upgradeSource: await f.read(),
        validateBulkUpgradeRequest: () => ({ ok: false, reason: 'empty-batch' }),
      }),
    });
    t.after(() => f.coordinator.disposeWhenIdle());
    const requestId = 'originating-upgrade';
    if (bulk) await f.coordinator.handleAnalyzeBulkUpgrade({ requestId, changes: [{ package: 'react', target: '19.0.0' }] });
    else await f.coordinator.handleAnalyzeUpgrade({ requestId, package: 'react', target: '19.0.0' });
    const error = f.messages.find(message => message.status === 'upgrade-error');
    assert.ok(error);
    assert.equal(error.requestId, requestId);
  });
}

for (const method of ['handleConfirmUpgrade', 'handleUseSmartPlan']) {
  test(`${method} rejection echoes the requested analysis id`, async t => {
    const f = makeCoordinator(await makeProject(t));
    t.after(() => f.coordinator.disposeWhenIdle());
    await f.coordinator[method]({ analysisId: 'expired-analysis' });
    const error = f.messages.find(message => message.status === 'upgrade-error');
    assert.equal(error?.error.code, 'STALE_ANALYSIS');
    assert.equal(error?.analysisId, 'expired-analysis');
  });
}

test('internal failure settlement retains the originating upgrade ids', () => {
  for (const message of [
    { type: 'upgrade', package: 'react', target: '19.0.0', requestId: 'single-request' },
    { type: 'bulk-upgrade', changes: [{ package: 'react', target: '19.0.0' }], requestId: 'bulk-request' },
    { type: 'confirm-upgrade', analysisId: 'single-analysis' },
    { type: 'use-smart-plan', analysisId: 'smart-analysis' },
  ]) {
    const error = failedRequestSettlement(message, 'react');
    assert.equal(error.status, 'upgrade-error');
    if ('requestId' in message) assert.equal(error.requestId, message.requestId);
    else assert.equal(error.analysisId, message.analysisId);
  }
});
