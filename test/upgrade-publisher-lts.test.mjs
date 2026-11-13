import assert from 'node:assert/strict';
import test from 'node:test';

import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { resolvedTarget } from './helpers/mutation-target.mjs';

function fixture(get, count = 1) {
  const messages = [];
  const validated = [];
  const changes = Array.from({ length: count }, (_, index) => ({ package: `pkg-${index}`, target: '3.0.0' }));
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage: message => messages.push(message) },
    httpClient: { get }, etagStore: new MemoryEtagStore(),
    ensureController: async () => ({
      upgradeSource: { resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} }, mutationTarget: resolvedTarget('/workspace') },
      lastResultRows: () => changes.map(change => ({
        name: change.package, current: '1.0.0', upgradeTo: '3.0.0', upgradeReason: 'update',
      })),
      validateBulkUpgradeRequest: requests => {
        validated.push(requests);
        return { ok: true, upgrades: requests.map(request => ({
          packageName: request.package, currentVersion: '1.0.0', target: request.target, classification: 'prod',
        })) };
      },
    }),
    getSelectedProject: () => undefined, isDisposed: () => false,
    reloadFinalState: async () => {}, flushDeferredChanges: async () => {},
  });
  return { coordinator, messages, validated, changes };
}

function response(tags) {
  const body = JSON.stringify(tags);
  return { status: 200, headers: {}, body, wireBytes: body.length };
}

test('a failed publisher tag lookup preserves the requested target and other packages still receive labels', async () => {
  const f = fixture(async url => {
    if (url.includes('/pkg-0/')) throw new Error('Registry unavailable');
    return response({ lts: '2.0.0', latest: '3.0.0' });
  }, 2);
  await f.coordinator.handleAnalyzeBulkUpgrade({ type: 'bulk-upgrade', requestId: 'tags', changes: f.changes });
  assert.deepEqual(f.validated, [f.changes]);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].package, 'pkg-1');
  assert.equal(isHostToWebviewMessage(f.messages[0]), true);
  assert.ok(f.messages[0].targets.options.some(option => option.labels.includes('lts')));
});

test('cancelling publisher lookup drops pending labels and stops dispatching registry requests', async () => {
  const pending = [];
  let started;
  const poolStarted = new Promise(resolve => { started = resolve; });
  const f = fixture(() => new Promise(resolve => {
    pending.push(resolve);
    if (pending.length === 8) started();
  }), 18);
  const running = f.coordinator.handleAnalyzeBulkUpgrade({ type: 'bulk-upgrade', requestId: 'cancel-tags', changes: f.changes });
  await poolStarted;
  f.coordinator.handleCancelUpgrade({ analysisId: null });
  for (const resolve of pending) resolve(response({ lts: '2.0.0', latest: '3.0.0' }));
  await running;
  assert.equal(pending.length, 8);
  assert.deepEqual(f.messages, []);
  assert.equal(f.coordinator.isBusy(), false);
});
