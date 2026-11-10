import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardController } from '../out/host/dashboardController.js';
import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { updateAdvisoryWarning } from '../out/host/updateAdvisoryState.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const json = value => ({ status: 200, headers: {}, body: JSON.stringify(value), wireBytes: 1 });
const warning = { name: 'minimist', version: '1.2.5', status: 'checked', count: 1, highestSeverity: 'high' };
const manifestText = JSON.stringify({ dependencies: { compat: 'npm:qs@^1.0.0' } });
const lockfileText = JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { compat: 'npm:minimist@^0.2.4' } },
  'node_modules/compat': { name: 'minimist', version: '0.2.4' },
} });

for (const legacy of [false, true]) {
  test(`cache restart with differing alias targets ${legacy ? 'leaves legacy versions unchecked' : 'preserves the scanned identity and warning'}`, async t => {
    // Serialize at the storage boundary, then create a new store on restart.
    const data = new Map();
    const storage = { get: key => data.get(key), async update(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
    } };
    const cache = new PersistentProjectCacheStore(storage);
    t.after(() => cache.dispose());
    const requests = [];
    const client = {
      async get(url) {
        assert.ok(url.startsWith('https://registry.npmjs.org/minimist'));
        return json({ version: '1.2.5', 'dist-tags': { latest: '1.2.5' },
          versions: { '0.2.4': { version: '0.2.4' }, '1.2.5': { version: '1.2.5' } } });
      },
      async post(_, body) {
        const request = JSON.parse(body);
        requests.push(request);
        return json(request.minimist?.includes('1.2.5') ? { minimist: [{
          id: 1, severity: 'high', title: 'Known vulnerability',
          url: 'https://example.com/advisory', vulnerable_versions: '>=1.0.0 <1.2.6',
        }] } : {});
      },
    };
    const options = { root: '/fixture', manifestText, lockfileText, lockfilePath: null,
      registry: 'https://registry.npmjs.org', httpClient: client, etagStore: new MemoryEtagStore(),
      projectInfo: { id: 'fixture', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
      buildInfo: { extensionVersion: 'test', builtAt: 'test' }, projectCacheStore: cache,
      cacheKey: 'fixture', ttlMinutesProvider: () => 30 };
    const fresh = new DashboardController(options);
    t.after(() => fresh.dispose());
    const scanned = [];
    await fresh.handleReady({ postMessage: message => scanned.push(message) });
    await tick();
    const dashboard = scanned.find(message => 'data' in message).data;
    assert.equal(dashboard.rows[0].registryName, 'minimist');
    assert.equal(dashboard.rows[0].latest, '1.2.5');
    assert.equal(dashboard.rows[0].worstSeverity, null, 'installed version has no finding');
    assert.deepEqual(scanned.find(message => message.status === 'update-advisories').results, [warning]);
    assert.equal(cache.get('fixture').rows[0].registryName, 'minimist');
    fresh.dispose();
    cache.dispose();

    if (legacy) {
      for (const collection of data.values()) {
        for (const [, snapshot] of collection.entries) delete snapshot.rows[0].registryName;
      }
    }
    const restartedCache = new PersistentProjectCacheStore(storage);
    t.after(() => restartedCache.dispose());
    assert.ok(restartedCache.get('fixture'), 'serialized snapshot passes cache validation');
    requests.length = 0;
    const restarted = new DashboardController({ ...options, projectCacheStore: restartedCache,
      etagStore: new MemoryEtagStore(), httpClient: { ...client, async get() {
        assert.fail('fresh cache replay does not scan metadata');
      } } });
    t.after(() => restarted.dispose());
    const replayed = [];
    await restarted.handleReady({ postMessage: message => replayed.push(message) });
    await tick();
    assert.equal(replayed[0].status, 'partial-error', 'cached rows replay immediately with audit enrichment unavailable');
    assert.equal(replayed[0].data.generatedAt, dashboard.generatedAt);
    assert.equal(replayed[0].data.rows[0].registryName, legacy ? undefined : 'minimist');
    const results = replayed.filter(message => message.status === 'update-advisories').flatMap(message => message.results);
    if (legacy) {
      assert.deepEqual(requests, [], 'unknown alias identity sends no offered-version request');
      assert.deepEqual(replayed[0].data.updateAdvisories, []);
      assert.deepEqual(results, [], 'unchecked versions have no warning marker');
    } else {
      assert.deepEqual(requests, [{ minimist: ['1.2.5'] }]);
      assert.deepEqual(results, [warning]);
      assert.ok(updateAdvisoryWarning(results[0]));
    }
  });
}

test('cache snapshots from before rows carried alias identities are rebuilt', async () => {
  const { CACHE_SCHEMA_VERSION } = await import('../out/core/cache/schema.js');
  assert.ok(CACHE_SCHEMA_VERSION >= 11, 'version 10 snapshots without registry identities are not replayed');
});
