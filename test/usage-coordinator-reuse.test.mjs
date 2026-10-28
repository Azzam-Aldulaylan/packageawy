import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageAnalysisCoordinator } from '../out/host/usage/usageCoordinator.js';

let findFilesCalls = 0;

const platform = {
  findFiles: async () => {
    findFilesCalls += 1;
    return [];
  },
  statFile: async () => ({ size: 0 }),
  readFile: async () => new Uint8Array(),
  withProgress: async (_title, run) => run(
    { report: () => undefined },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }
  ),
  openFile: () => undefined,
};

function fixture() {
  const messages = [];
  const selected = {
    id: 'project-a',
    dir: '',
    relativePath: 'package.json',
    manifestPath: '/workspace/package.json',
    folder: { id: 'file:///workspace', name: 'workspace', path: '/workspace' },
  };
  const controller = {
    root: '/workspace',
    upgradeSource: {
      manifestText: JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.0.0', react: '^18.0.0' } }),
      lockfileText: null,
      lockfilePath: null,
      packageManager: 'npm',
      importerId: '.',
    },
    lastResultRows: () => [{ name: 'lodash' }, { name: 'react' }],
  };
  const coordinator = new UsageAnalysisCoordinator({
    platform,
    sink: { postMessage: (message) => messages.push(message) },
    ensureController: async () => controller,
    getSelectedProject: () => selected,
    isDisposed: () => false,
  });
  return { coordinator, messages, selected, controller };
}

test('coordinator reuses a real cleanup scan and immediately supersedes rendered evidence on source invalidation', async () => {
  findFilesCalls = 0;
  const { coordinator, messages } = fixture();

  assert.equal(await coordinator.handleAnalyzeCleanup({ background: true }), true);
  assert.equal(findFilesCalls, 2, 'cleanup performs one concurrent source/config discovery pair');

  await coordinator.handleWhereUsed({ package: 'react' });
  const usage = messages.findLast((message) => message.status === 'usage-result');
  assert.equal(usage.analysis.fromCache, true);
  assert.equal(findFilesCalls, 2, 'where-used reuses cleanup instead of scanning');

  await coordinator.handleAnalyzeRemovalImpact({ requestId: 'impact-1', packages: ['react'] });
  const impact = messages.findLast((message) => message.status === 'removal-impact-result');
  assert.equal(impact.requestId, 'impact-1');
  assert.deepEqual(impact.packages, ['react']);
  assert.equal(impact.assessments.length, 1);
  assert.equal(findFilesCalls, 2, 'removal impact reuses the complete cleanup entry');

  const beforeInvalidation = messages.length;
  assert.equal(coordinator.invalidateProjectSource('project-a'), 1);
  const supersession = messages.slice(beforeInvalidation);
  assert.deepEqual(supersession.map((message) => message.status), [
    'usage-error',
    'cleanup-result',
    'removal-impact-error',
  ]);
  assert.equal(supersession[0].error.code, 'STALE_SOURCE');
  assert.deepEqual(supersession[1].findings, []);
  assert.equal(Date.parse(supersession[1].cacheExpiresAt), 0);
  assert.equal(supersession[2].error.code, 'STALE_SOURCE');
  assert.equal(supersession[2].requestId, 'impact-1');
  assert.deepEqual(supersession[2].packages, ['react']);

  coordinator.dispose();
});

test('an explicit cleanup pass satisfies the project-wide background reuse gate', async () => {
  findFilesCalls = 0;
  const { coordinator } = fixture();

  assert.equal(await coordinator.handleAnalyzeCleanup(), true);
  assert.equal(findFilesCalls, 2);
  await coordinator.requestBackgroundUsageRefresh();
  assert.equal(findFilesCalls, 2, 'the same project does not rescan before its one-hour reuse window expires');

  coordinator.dispose();
});

test('Smart Cleanup evidence authorizes only a canonical selectable subset and is revoked by source changes', async () => {
  const { coordinator } = fixture();

  await coordinator.handleAnalyzeRemovalImpact({
    requestId: 'impact-selection',
    packages: ['lodash', 'react'],
  });

  const subset = coordinator.smartCleanupRemovalEvidence('impact-selection', ['react']);
  assert.ok(subset, 'a deliberate subset of the reviewed low-risk packages remains executable');
  assert.equal(subset.isCurrent(), true);
  assert.equal(coordinator.smartCleanupRemovalEvidence('impact-selection', ['react', 'lodash']), null, 'selection must be canonical');
  assert.equal(coordinator.smartCleanupRemovalEvidence('wrong-request', ['react']), null, 'request ids cannot cross analysis runs');
  assert.equal(coordinator.smartCleanupRemovalEvidence('impact-selection', ['missing']), null, 'unreviewed packages are rejected');

  coordinator.invalidateProjectSource('project-a');
  assert.equal(subset.isCurrent(), false, 'the retained execution guard is revoked synchronously');

  coordinator.dispose();
});

test('targeted cancellation during controller lookup drops every stale removal-impact message', async () => {
  const base = fixture();
  let resolveController;
  const controllerReady = new Promise((resolve) => {
    resolveController = resolve;
  });
  const messages = [];
  const coordinator = new UsageAnalysisCoordinator({
    platform,
    sink: { postMessage: (message) => messages.push(message) },
    ensureController: async () => controllerReady,
    getSelectedProject: () => base.selected,
    isDisposed: () => false,
  });

  const stale = coordinator.handleAnalyzeRemovalImpact({ requestId: 'impact-old', packages: ['react'] });
  coordinator.handleCancelRemovalImpact({ requestId: 'impact-old' });
  resolveController(base.controller);
  await stale;

  assert.deepEqual(messages, [], 'cancelled lookup cannot publish queued progress, result, or error');

  await coordinator.handleAnalyzeRemovalImpact({ requestId: 'impact-new', packages: ['react'] });
  const result = messages.findLast((message) => message.status === 'removal-impact-result');
  assert.equal(result.requestId, 'impact-new');
  assert.deepEqual(result.packages, ['react']);

  coordinator.dispose();
  base.coordinator.dispose();
});

test('a stale package selection fails atomically with the exact requested package set', async () => {
  const { coordinator, messages } = fixture();
  await coordinator.handleAnalyzeRemovalImpact({ requestId: 'impact-stale', packages: ['missing', 'react'] });

  const error = messages.findLast((message) => message.status === 'removal-impact-error');
  assert.equal(error.requestId, 'impact-stale');
  assert.deepEqual(error.packages, ['missing', 'react']);
  assert.equal(error.error.code, 'STALE_SOURCE');
  assert.equal(messages.some((message) => message.status === 'removal-impact-result'), false);

  coordinator.dispose();
});
