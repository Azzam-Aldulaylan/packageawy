import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardController } from '../out/host/dashboardController.js';
import { PersistentProjectCacheStore, PROJECT_CACHE_STORAGE_KEY } from '../out/core/cache/projectCacheStore.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { packumentSecurityReference, securityClient, securityOptions, PUBLIC, PACKUMENT_ONLY } from './helpers/cold-load-security.mjs';

test('exact-document and packument scans persist equal security snapshots and grant equal upgrade eligibility', async t => {
  const expected = await packumentSecurityReference();
  const run = async registry => {
    const data = new Map();
    const cache = new PersistentProjectCacheStore({ get: key => data.get(key), update: async (key, value) => { data.set(key, value); } });
    const client = securityClient();
    const controller = new DashboardController({ ...securityOptions, registry, lockfilePath: '/fixture/package-lock.json',
      httpClient: client, auditRunner: client, etagStore: new MemoryEtagStore(),
      projectInfo: { id: 'fixture', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
      buildInfo: { extensionVersion: 'test', builtAt: 'test' },
      projectCacheStore: cache, cacheKey: 'fixture', ttlMinutesProvider: () => 30 });
    t.after(() => { controller.dispose(); cache.dispose(); });
    const messages = [];
    await controller.handleReady({ postMessage: m => messages.push(m) });
    // Join the public enrichment queue, which runs after the atomic snapshot.
    await controller.updateAdvisories.enrich([], () => true, () => {});
    const snapshot = cache.get('fixture');
    assert.ok(snapshot);
    const { generatedAt, ...persisted } = snapshot;
    assert.ok(Number.isFinite(Date.parse(generatedAt)));
    assert.deepEqual(persisted.rows, expected.rows);
    assert.deepEqual(persisted.availability, expected.availability);
    assert.deepEqual(persisted.hygieneFindings, expected.hygieneFindings);
    assert.equal(controller.isEligible(), true);
    const requests = expected.rows.filter(row => row.upgradeTo !== null).map(row => ({ package: row.name, target: row.upgradeTo }));
    const eligibility = requests.map(request => controller.validateUpgradeRequest(request));
    assert.ok(eligibility.every(result => result.ok));
    assert.equal(controller.validateUpgradeRequest({ package: 'ms', target: '2.1.3' }).ok, false);
    assert.equal(controller.validateUpgradeRequest({ package: 'lodash', target: '99.0.0' }).ok, false);
    assert.equal(controller.validateBulkUpgradeRequest(requests).ok, true);
    const updateAdvisories = messages.findLast(m => m.status === 'update-advisories').results;
    assert.deepEqual(updateAdvisories.find(result => result.name === 'lodash' && result.version === '4.17.20'),
      { name: 'lodash', version: '4.17.20', status: 'checked', count: 1, highestSeverity: 'high' });
    assert.deepEqual(updateAdvisories.find(result => result.name === 'lodash' && result.version === '4.17.21'),
      { name: 'lodash', version: '4.17.21', status: 'checked', count: 0, highestSeverity: null });
    await controller.handleReady({ postMessage: m => messages.push(m) });
    assert.deepEqual(messages.findLast(m => 'data' in m).data.updateAdvisories, updateAdvisories, 'replay embeds the settled offered-version checks');
    cache.dispose();
    assert.deepEqual(data.get(PROJECT_CACHE_STORAGE_KEY).entries[0][1], snapshot, 'the snapshot reaches the backing store');
    return { persisted, eligibility, updateAdvisories, calls: client.calls };
  };
  const exact = await run(PUBLIC);
  const packument = await run(PACKUMENT_ONLY);
  assert.ok(exact.calls.includes(`${PUBLIC}dayjs/1.11.10`));
  assert.ok(packument.calls.includes(`${PACKUMENT_ONLY}dayjs`));
  assert.ok(packument.calls.every(url => !/\/1\.11\.10$/.test(url)));
  assert.deepEqual(exact.persisted, packument.persisted);
  assert.deepEqual(exact.eligibility, packument.eligibility);
  assert.deepEqual(exact.updateAdvisories, packument.updateAdvisories);
});
