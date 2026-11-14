import { recoveryFixture } from './helpers/recovery.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OperationReservation, SourceGenerationGuard } from '../out/host/operationReservation.js';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { resolvedTarget } from './helpers/mutation-target.mjs';

// The coordinator only reads settings from the platform in these paths.
const platform = { getSetting: (_key, fallback) => fallback };

function fixture({ flushFails = false, disposed = false } = {}) {
  let held = false;
  const calls = [];
  const lifecycle = new OperationReservation({
    locks: new ProjectMutationLocks(),
    reserve() {
      if (held) return false;
      held = true;
      return true;
    },
    release(packageName) {
      held = false;
      calls.push(`release:${packageName}`);
    },
    async flushDeferredChanges() {
      calls.push('flush');
      if (flushFails) throw new Error('reload failed');
    },
    resumePendingBackground() {
      calls.push('resume');
    },
    isDisposed: () => disposed,
    dispose() {
      calls.push('dispose');
    },
  });
  return { lifecycle, calls };
}

for (const exit of ['cancel', 'analysis-failure', 'controller-unavailable']) {
  test(`${exit} releases, flushes, and resumes exactly once`, async () => {
    const { lifecycle, calls } = fixture();
    const handle = lifecycle.reserve('pkg', '/workspace');
    assert.equal(handle.ok, true);
    assert.equal(await handle.releaseReadOnly(), true);
    assert.equal(await handle.releaseReadOnly(), false, 'a stale second release has no side effects');
    assert.deepEqual(calls, ['release:pkg', 'flush', 'resume']);
  });
}

test('read-only review ownership is not mutation ownership', async t => {
  const f = await recoveryFixture(t);
  const { lifecycle } = fixture();
  const handle = lifecycle.reserve('pkg', f.root);
  assert.equal(lifecycle.isMutationBusy, false);
  assert.equal(await handle.beginMutation(f.target), true);
  assert.equal(lifecycle.isMutationBusy, true);
});

test('a remounted webview releases abandoned read-only ownership but never a mutation', async t => {
  const f = await recoveryFixture(t);
  const readOnly = fixture();
  readOnly.lifecycle.reserve('review', '/workspace');
  assert.equal(await readOnly.lifecycle.held.releaseReadOnly(), true);
  assert.deepEqual(readOnly.calls, ['release:review', 'flush', 'resume']);

  const mutation = fixture();
  await mutation.lifecycle.reserve('install', f.root).beginMutation(f.target);
  assert.equal(await mutation.lifecycle.held.releaseReadOnly(), false);
  assert.deepEqual(mutation.calls, []);
});

test('a flush failure is contained and later release cycles still run', async () => {
  const { lifecycle, calls } = fixture({ flushFails: true });
  await lifecycle.reserve('one', '/workspace').releaseReadOnly();
  await lifecycle.reserve('two', '/workspace').complete('not-started');
  assert.deepEqual(calls, ['release:one', 'flush', 'resume', 'release:two', 'flush', 'resume']);
});

test('disposal runs after release, drain, and resume', async () => {
  const { lifecycle, calls } = fixture({ disposed: true });
  await lifecycle.reserve('pkg', '/workspace').releaseReadOnly();
  assert.deepEqual(calls, ['release:pkg', 'flush', 'resume', 'dispose']);
});

test('a source change invalidates a captured review before mutation execution', () => {
  const generation = new SourceGenerationGuard();
  const reviewGeneration = generation.capture();
  assert.equal(generation.isCurrent(reviewGeneration), true);
  generation.advance();
  assert.equal(generation.isCurrent(reviewGeneration), false);
});

test('a source change racing Removal Review prevents publishing executable stored analysis', () => {
  const generation = new SourceGenerationGuard();
  const analysisGeneration = generation.capture();
  let storedRemoval;
  generation.advance();
  const published = generation.commitIfCurrent(analysisGeneration, () => {
    storedRemoval = { id: 'stale-removal' };
  });
  assert.equal(published, false);
  assert.equal(storedRemoval, undefined, 'confirm-remove has no stored analysis to execute');
});

test('a host source change terminates a real in-flight Upgrade analysis exactly once', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const messages = [];
  const lifecycle = [];
  let rejectProjectLoad;
  let markProjectLoadStarted;
  const projectLoadStarted = new Promise((resolve) => {
    markProjectLoadStarted = resolve;
  });
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      lastResultRows: () => [],
      upgradeSource: { mutationTarget: resolvedTarget('/workspace') },
      validateBulkUpgradeRequest: () => ({
        ok: true,
        upgrades: [{ packageName: 'dep', currentVersion: '1.0.0', target: '2.0.0', classification: 'major' }],
      }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: {} }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {
      lifecycle.push('flush');
    },
    onMutationLockReleased: () => {
      lifecycle.push('resume');
    },
    loadProject: async () => {
      markProjectLoadStarted();
      return await new Promise((_, reject) => {
        rejectProjectLoad = reject;
      });
    },
  });

  const analysis = coordinator.handleAnalyzeUpgrade({
    type: 'upgrade',
    requestId: 'request-1',
    package: 'dep',
    target: '2.0.0',
  });
  await projectLoadStarted;

  coordinator.handleProjectSourceChanged();
  coordinator.handleProjectSourceChanged();
  rejectProjectLoad(new Error('source snapshot superseded'));
  await analysis;

  assert.deepEqual(messages, [{
    status: 'upgrade-error',
    requestId: 'request-1',
    package: 'dep',
    error: {
      code: 'STALE_SOURCE',
      message: 'Project files changed while upgrade analysis was running. Analyze again.',
    },
  }]);
  assert.deepEqual(lifecycle, ['flush', 'resume']);
  assert.equal(coordinator.isBusy(), false);
});

test('a webview remount abandons an in-flight read-only review without publishing into the new view', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const messages = [];
  const lifecycle = [];
  let rejectProjectLoad;
  let markProjectLoadStarted;
  const projectLoadStarted = new Promise((resolve) => {
    markProjectLoadStarted = resolve;
  });
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      lastResultRows: () => [],
      upgradeSource: { mutationTarget: resolvedTarget('/workspace') },
      validateBulkUpgradeRequest: () => ({
        ok: true,
        upgrades: [{ packageName: 'dep', currentVersion: '1.0.0', target: '2.0.0', classification: 'major' }],
      }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: {} }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => lifecycle.push('flush'),
    onMutationLockReleased: () => lifecycle.push('resume'),
    loadProject: async () => {
      markProjectLoadStarted();
      return await new Promise((_, reject) => {
        rejectProjectLoad = reject;
      });
    },
  });

  const analysis = coordinator.handleAnalyzeUpgrade({
    type: 'upgrade',
    requestId: 'orphaned-request',
    package: 'dep',
    target: '2.0.0',
  });
  await projectLoadStarted;
  await coordinator.handleWebviewReady();

  assert.equal(coordinator.isBusy(), false);
  assert.deepEqual(lifecycle, ['flush', 'resume']);
  rejectProjectLoad(new Error('abandoned by webview remount'));
  await analysis;
  assert.deepEqual(messages, []);
});

for (const flow of ['single', 'bulk']) for (const [current, target, upgradeReason] of [
  ['1.0.0', '3.0.0', 'update'],
  ['0.21.1', '0.21.4', 'security-fix'],
]) {
  test(`${flow} upgrade review preserves the dashboard ${upgradeReason} target with Publisher LTS available`, async () => {
    const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
    const validatedRequests = [];
    const requestedUrls = [];
    const messages = [];
    const body = JSON.stringify({ lts: '2.0.0', latest: '3.0.0' });
    const coordinator = new UpgradeAssistantCoordinator({
      platform,
      sink: { postMessage: message => messages.push(message) },
      httpClient: {
        get: async url => {
          requestedUrls.push(url);
          return { status: 200, headers: {}, body, wireBytes: body.length };
        },
      },
      etagStore: { get: () => undefined, set: () => {} },
      ensureController: async () => ({
        upgradeSource: { resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} }, mutationTarget: resolvedTarget('/workspace') },
        lastResultRows: () => [{ name: 'pkg', current, upgradeTo: target, upgradeReason }],
        validateBulkUpgradeRequest: requests => {
          validatedRequests.push(requests);
          return { ok: true, upgrades: requests.map(request => ({
            packageName: request.package, currentVersion: current, target: request.target, classification: 'prod',
          })) };
        },
      }),
      getSelectedProject: () => undefined,
      isDisposed: () => false,
      reloadFinalState: async () => {},
      flushDeferredChanges: async () => {},
      loadProject: async () => { throw new Error('no selected project'); },
    });

    const changes = [{ package: 'pkg', target }];
    if (flow === 'bulk') {
      await coordinator.handleAnalyzeBulkUpgrade({ type: 'bulk-upgrade', requestId: 'same-target', changes });
    } else {
      await coordinator.handleAnalyzeUpgrade({ type: 'upgrade', requestId: 'same-target', package: 'pkg', target });
    }
    assert.deepEqual(validatedRequests, [changes]);
    assert.deepEqual(requestedUrls, ['https://registry.npmjs.org/-/package/pkg/dist-tags']);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'upgrade-targets');
    assert.equal(messages[0].requestId, 'same-target');
    assert.ok(messages[0].targets.options.find(option => option.version === '2.0.0').labels.includes('lts'));
    assert.ok(messages[0].targets.options.some(option => option.version === target));
  });
}

test('publisher LTS lookup uses bounded registry concurrency', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const changes = Array.from({ length: 18 }, (_, index) => ({ package: `pkg-${index}`, target: '3.0.0' }));
  const rows = changes.map((change) => ({ name: change.package, current: '1.0.0', upgradeTo: '3.0.0' }));
  const body = JSON.stringify({ lts: '2.0.0', latest: '3.0.0' });
  let active = 0;
  let peak = 0;
  const messages = [];
  const validatedRequests = [];
  const requestedUrls = [];
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: message => messages.push(message) },
    httpClient: {
      get: async url => {
        requestedUrls.push(url);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { status: 200, headers: {}, body, wireBytes: body.length };
      },
    },
    etagStore: { get: () => undefined, set: () => {} },
    ensureController: async () => ({
      upgradeSource: {
        resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} },
        mutationTarget: resolvedTarget('/workspace'),
      },
      lastResultRows: () => rows,
      validateBulkUpgradeRequest: (requests) => {
        validatedRequests.push(requests);
        return {
          ok: true,
          upgrades: requests.map(request => ({
            packageName: request.package, currentVersion: '1.0.0',
            target: request.target, classification: 'prod',
          })),
        };
      },
    }),
    getSelectedProject: () => undefined,
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    loadProject: async () => { throw new Error('validation should stop before project loading'); },
  });

  await coordinator.handleAnalyzeBulkUpgrade({ type: 'bulk-upgrade', requestId: 'bounded-lts', changes });

  assert.deepEqual(validatedRequests, [changes]);
  assert.equal(requestedUrls.length, changes.length);
  assert.ok(requestedUrls.every(url => url.endsWith('/dist-tags')));
  assert.equal(messages.length, changes.length);
  assert.ok(messages.every(message => message.status === 'upgrade-targets'));
  assert.ok(messages.every(message => message.targets.options.some(option => option.labels.includes('lts'))));
  assert.equal(peak, 8);
});

test('cancel-remove with a null id cancels a pending project load and releases without publishing a stale review', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const messages = [];
  const lifecycle = [];
  let resolveProjectLoad;
  let markProjectLoadStarted;
  let projectLoadCalls = 0;
  const projectLoadStarted = new Promise((resolve) => {
    markProjectLoadStarted = resolve;
  });
  const manifestText = JSON.stringify({ dependencies: { react: '^18.0.0' } });
  const source = {
    manifestText,
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/react': { version: '18.2.0' } } }),
    lockfilePath: '/workspace/package-lock.json',
    registry: 'https://registry.npmjs.org/',
    packageManager: 'npm',
    importerId: '.',
    mutationTarget: resolvedTarget('/workspace'),
  };
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root: '/workspace',
      upgradeSource: source,
      validateBulkRemoveRequest: () => ({
        ok: true,
        removals: [{ packageName: 'react', classification: 'prod' }],
      }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: {} }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => lifecycle.push('flush'),
    onMutationLockReleased: () => lifecycle.push('resume'),
    loadProject: async () => {
      projectLoadCalls += 1;
      if (projectLoadCalls > 1) return { root: '/workspace', ...source };
      markProjectLoadStarted();
      return await new Promise((resolve) => {
        resolveProjectLoad = resolve;
      });
    },
  });

  const analysis = coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  await projectLoadStarted;
  assert.equal(coordinator.isBusy(), true);
  coordinator.handleCancelRemove({ analysisId: null });
  assert.equal(coordinator.isBusy(), false, 'the reservation is released synchronously by cancellation');

  const replacement = coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  await replacement;
  const replacementReview = messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(replacementReview, 'an immediate retry is accepted instead of being rejected by the cancelled pending slot');
  assert.equal(messages.some((message) => message.status === 'remove-error'), false);
  coordinator.handleCancelRemove({ analysisId: replacementReview.analysis.analysisId });

  resolveProjectLoad({ root: '/workspace', ...source });
  await analysis;

  assert.equal(messages.filter((message) => message.status === 'remove-analysis').length, 1);
  assert.equal(messages.some((message) => message.status === 'remove-error'), false);
});

test('Smart Cleanup removal is capability-gated and rechecks host usage evidence before confirmation', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const manifestText = JSON.stringify({ dependencies: { react: '^18.0.0' } });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { react: '^18.0.0' } },
      'node_modules/react': { version: '18.2.0' },
    },
  });
  const baseSource = {
    manifestText,
    lockfileText,
    lockfilePath: '/workspace/package-lock.json',
    lockfileName: 'package-lock.json',
    registry: 'https://registry.npmjs.org/',
    resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
    packageManager: 'npm',
    importerId: '.',
    mutationTarget: resolvedTarget('/workspace'),
  };

  const makeCoordinator = ({ importerId = '.', evidenceCurrent = () => true } = {}) => {
    const messages = [];
    let validationCalls = 0;
    const source = { ...baseSource, importerId };
    const coordinator = new UpgradeAssistantCoordinator({
      platform,
      sink: { postMessage: (message) => messages.push(message) },
      httpClient: {},
      etagStore: {},
      ensureController: async () => ({
        root: '/workspace',
        upgradeSource: source,
        validateBulkRemoveRequest: () => {
          validationCalls += 1;
          return { ok: true, removals: [{ packageName: 'react', classification: 'prod' }] };
        },
      }),
      getSelectedProject: () => ({ id: 'project', dir: '', folder: { uri: { fsPath: '/workspace' } } }),
      isDisposed: () => false,
      reloadFinalState: async () => {},
      flushDeferredChanges: async () => {},
      smartCleanupRemovalEvidence: () => ({ isCurrent: evidenceCurrent }),
      loadProject: async () => ({ root: '/workspace', ...source }),
    });
    return { coordinator, messages, validationCalls: () => validationCalls };
  };

  const workspaceMember = makeCoordinator({ importerId: 'packages/app' });
  await workspaceMember.coordinator.handleAnalyzeSmartCleanupRemove({
    requestId: 'cleanup-member',
    removalRequestId: 'impact-member',
    packages: ['react'],
  });
  assert.equal(workspaceMember.validationCalls(), 0, 'unsupported topology is rejected before generic removal eligibility');
  assert.equal(workspaceMember.messages.findLast((message) => message.status === 'remove-error').error.code, 'NOT_ELIGIBLE');

  let evidenceCurrent = true;
  const rootProject = makeCoordinator({ evidenceCurrent: () => evidenceCurrent });
  await rootProject.coordinator.handleAnalyzeSmartCleanupRemove({
    requestId: 'cleanup-root',
    removalRequestId: 'impact-root',
    packages: ['react'],
  });
  const review = rootProject.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(review, 'a supported project with current evidence receives a host removal review');

  evidenceCurrent = false;
  await rootProject.coordinator.handleConfirmRemove({ analysisId: review.analysis.analysisId });
  assert.equal(rootProject.messages.findLast((message) => message.status === 'remove-error').error.code, 'STALE_ANALYSIS');
  assert.equal(rootProject.coordinator.isBusy(), false, 'a stale Smart Cleanup review releases its reservation');

  const cancelledBeforeDelivery = makeCoordinator();
  await cancelledBeforeDelivery.coordinator.handleAnalyzeSmartCleanupRemove({
    requestId: 'cleanup-cancelled-before-delivery',
    removalRequestId: 'impact-cancelled-before-delivery',
    packages: ['react'],
  });
  assert.equal(
    cancelledBeforeDelivery.coordinator.isBusy(),
    false,
    'a completed read-only removal review does not retain the mutation reservation'
  );
  cancelledBeforeDelivery.coordinator.handleCancelRemove({
    analysisId: null,
    requestId: 'cleanup-cancelled-before-delivery',
  });
  assert.equal(
    cancelledBeforeDelivery.coordinator.isBusy(),
    false,
    'request-correlated cancellation clears the stored review without re-locking the project'
  );
});

test('bulk removal preflight blocks a required peer unless its direct owner is in the exact removal set', async () => {
  const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
  const manifestText = JSON.stringify({ dependencies: { consumer: '^1.0.0', react: '^18.0.0' } });
  const lockfileText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/consumer': { version: '1.0.0', peerDependencies: { react: '^18.0.0' } },
      'node_modules/react': { version: '18.2.0' },
    },
  });
  const source = {
    manifestText,
    lockfileText,
    lockfilePath: '/workspace/package-lock.json',
    registry: 'https://registry.npmjs.org/',
    packageManager: 'npm',
    importerId: '.',
    mutationTarget: resolvedTarget('/workspace'),
  };

  async function run(changes) {
    const messages = [];
    const removals = changes.map(({ package: packageName }) => ({ packageName, classification: 'prod' }));
    const coordinator = new UpgradeAssistantCoordinator({
      platform,
      sink: { postMessage: (message) => messages.push(message) },
      httpClient: {},
      etagStore: {},
      ensureController: async () => ({
        root: '/workspace',
        upgradeSource: source,
        validateBulkRemoveRequest: () => ({ ok: true, removals }),
      }),
      getSelectedProject: () => ({ id: 'project', dir: '', folder: {} }),
      isDisposed: () => false,
      reloadFinalState: async () => {},
      flushDeferredChanges: async () => {},
      loadProject: async () => ({ root: '/workspace', ...source }),
    });
    await coordinator.handleAnalyzeBulkRemove({ changes });
    return { coordinator, messages };
  }

  const blocked = await run([{ package: 'react' }]);
  assert.equal(blocked.messages.findLast((message) => message.status === 'remove-error').error.code, 'REQUIRED_PEER_DEPENDENCY');
  assert.equal(blocked.messages.some((message) => message.status === 'remove-analysis'), false);
  assert.equal(blocked.coordinator.isBusy(), false);

  const coordinated = await run([{ package: 'react' }, { package: 'consumer' }]);
  assert.equal(coordinated.messages.some((message) => message.status === 'remove-error' && message.error.code === 'REQUIRED_PEER_DEPENDENCY'), false);
  assert.equal(coordinated.messages.some((message) => message.status === 'remove-analysis'), true);
  coordinated.coordinator.handleCancelRemove({ analysisId: coordinated.messages.findLast((message) => message.status === 'remove-analysis').analysis.analysisId });
});
