import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { buildPackageRows } from '../out/core/pipeline.js';
import { FetchError } from '../out/core/registry/http.js';
import { limitMetadataRequests } from '../out/core/registry/requestLimiter.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

const PUBLIC = 'https://registry.npmjs.org/';
const GHSA = 'GHSA-aaaa-bbbb-cccc';
const json = (value) => {
  const body = JSON.stringify(value);
  return { status: 200, headers: {}, body, wireBytes: Buffer.byteLength(body) };
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const advisory = { id: 1, title: 'Recorded advisory', severity: 'high', vulnerable_versions: '<1.0.1', url: `https://github.com/advisories/${GHSA}` };
function setup(names = ['pkg'], range = '1.0.0') {
  const dependencies = Object.fromEntries(names.map((name) => [name, range]));
  return { root: '/fixture', registry: PUBLIC, manifestText: JSON.stringify({ dependencies }),
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies }, ...Object.fromEntries(names.map((name) => [`node_modules/${name}`, { version: '1.0.0' }])),
    } }), etagStore: new MemoryEtagStore(), auditUnavailableWhenOmitted: false };
}
function transport({ get, post, flagged = [], etag = false } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  return {
    calls, get peak() { return peak; },
    async get(url, options) {
      const github = url.startsWith('https://api.github.com/');
      const [name, suffix] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
      const kind = github ? 'github' : suffix === 'latest' ? 'latest'
        : url.endsWith('/dist-tags') ? 'dist-tags' : suffix ? 'exact' : 'packument';
      const call = { name, kind, url, bytes: 0 };
      calls.push(call);
      if (!github) { active += 1; peak = Math.max(peak, active); }
      try {
        const overridden = await get?.(call, options);
        await nextTurn();
        const response = overridden ?? (github ? json([{ ghsa_id: GHSA, cve_id: 'CVE-2026-1234', identifiers: [{ type: 'GHSA', value: GHSA }, { type: 'CVE', value: 'CVE-2026-1234' }] }])
          : kind === 'latest' ? json({ version: '2.0.0' })
          : kind === 'exact' ? json({ name, version: suffix })
          : kind === 'dist-tags' ? json({ latest: '2.0.0' })
          : json({ versions: { '1.0.0': {}, '1.0.1': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } }));
        if (etag) {
          response.headers.etag = '"recorded"';
          if (options?.headers?.['if-none-match'] === response.headers.etag) {
            return { status: 304, headers: {}, body: '', wireBytes: 0 };
          }
        }
        call.bytes = response.wireBytes;
        return response;
      } finally { if (!github) active -= 1; }
    },
    async post(url, body) {
      const overridden = await post?.(JSON.parse(body));
      return overridden ?? json(Object.fromEntries(flagged.map((name) => [name, [advisory]])));
    },
  };
}
const scan = (options, client) => buildPackageRows({ ...options, httpClient: client });

for (const concurrency of [1, 8]) {
  test(`eight escalations and advisory prefetch finish with concurrency ${concurrency}`, { timeout: 3000 }, async () => {
    const names = Array.from({ length: 8 }, (_, i) => `pkg-${i}`);
    const client = transport({ flagged: names.slice(0, 4) });
    const result = await scan({ ...setup(names, '^1.0.0'), concurrency }, client);
    assert.equal(result.rows.length, 8);
    assert.ok(result.rows.every((row) => row.wanted === '1.0.1'));
    assert.equal(client.calls.filter((call) => call.kind === 'packument').length, 8);
    assert.equal(client.peak, concurrency);
    assert.ok(client.peak <= concurrency);
  });
}

test('exact documents, prefetch, packuments and TOO_LARGE dist-tags share the metadata budget', async () => {
  const options = setup(['pin', 'oversized', 'flagged']);
  const lock = JSON.parse(options.lockfileText);
  const manifest = JSON.parse(options.manifestText);
  manifest.dependencies.oversized = lock.packages[''].dependencies.oversized = '^1.0.0';
  const client = transport({ flagged: ['flagged'], get(call) {
    if (call.name === 'oversized' && call.kind === 'packument') throw new FetchError('TOO_LARGE', 'oversized fixture');
  } });
  await scan({ ...options, manifestText: JSON.stringify(manifest), lockfileText: JSON.stringify(lock), concurrency: 1 }, client);
  assert.equal(client.peak, 1);
  for (const kind of ['latest', 'exact', 'packument', 'dist-tags']) assert.ok(client.calls.some((call) => call.kind === kind), kind);
});

test('default metadata budget caps many simultaneous prefetch requests at eight', async () => {
  const names = Array.from({ length: 16 }, (_, i) => `pkg-${i}`);
  const client = transport({ flagged: names });
  await scan(setup(names), client);
  assert.equal(client.peak, 8);
});

for (const fails of [false, true]) {
  test(`prefetch ${fails ? 'failure' : 'success'} is shared by version and patched stages before GitHub finishes`, { timeout: 3000 }, async () => {
    const latest = deferred();
    const github = deferred();
    const prefetched = deferred();
    const client = transport({ flagged: ['pkg'], async get(call) {
      if (call.kind === 'latest') await latest.promise;
      if (call.kind === 'github') await github.promise;
      if (call.kind === 'packument') {
        prefetched.resolve();
        if (fails) throw new FetchError('NETWORK', 'shared failed packument');
      }
    } });
    const pending = scan({ ...setup(), concurrency: 2 }, client);
    await prefetched.promise;
    await nextTurn();
    latest.resolve();
    await nextTurn();
    github.resolve();
    const result = await pending;
    assert.equal(client.calls.filter((call) => call.kind === 'packument').length, 1);
    assert.equal(client.calls.filter((call) => call.kind === 'exact').length, 0);
    assert.equal(result.rows[0].advisories[0].patchedVersion.status, fails ? 'unknown' : 'known');
    assert.equal(result.availability.updates, fails ? 'partial' : 'complete');
    assert.equal(result.rows[0].advisories[0].advisory.identifiers[0].type, 'CVE');
  });
}

test('late flagging adds exactly one exact request and its bytes, cold and cached', async () => {
  async function run(late, etagStore) {
    const exact = deferred();
    const client = transport({ etag: true, flagged: ['pkg'], async post() { if (late) await exact.promise; }, get(call) {
      if (call.kind === 'exact') exact.resolve();
    } });
    const result = await scan({ ...setup(), etagStore, ...(late ? {} : { registry: 'https://registry.fixture.invalid/' }) }, client);
    return { client, result };
  }
  const oldStore = new MemoryEtagStore();
  const nextStore = new MemoryEtagStore();
  for (let scan = 0; scan < 2; scan += 1) {
    const old = await run(false, oldStore);
    const next = await run(true, nextStore);
    assert.deepEqual(next.result, old.result);
    const metadata = (client) => client.calls.filter((call) => call.kind !== 'github');
    const nextCalls = metadata(next.client);
    const oldCalls = metadata(old.client);
    assert.equal(nextCalls.length, oldCalls.length + 1);
    assert.equal(nextCalls.filter((call) => call.kind === 'exact').length, 1);
    assert.equal(nextCalls.filter((call) => call.kind === 'packument').length, 1);
    const bytes = (calls) => calls.reduce((sum, call) => sum + call.bytes, 0);
    assert.equal(bytes(nextCalls) - bytes(oldCalls), nextCalls.find((call) => call.kind === 'exact').bytes);
  }
});

test('queued cancellation rejects promptly without releasing an occupied slot', { timeout: 3000 }, async () => {
  const held = deferred();
  const calls = [];
  const limited = limitMetadataRequests({ async get(url) { calls.push(url); if (url === 'first') await held.promise; return json({}); } }, 1);
  const first = limited.get('first');
  const abort = new AbortController();
  const queued = limited.get('cancelled', { signal: abort.signal });
  const rejected = assert.rejects(queued, { code: 'CANCELLED' });
  const next = limited.get('next');
  abort.abort();
  await rejected;
  assert.deepEqual(calls, ['first']);
  held.resolve();
  await Promise.all([first, next]);
  assert.deepEqual(calls, ['first', 'next']);
  await assert.rejects(limited.get('already aborted', { signal: abort.signal }), { code: 'CANCELLED' });
});

test('pipeline cancellation clears queued prefetch and version requests', { timeout: 3000 }, async () => {
  const started = deferred();
  const abort = new AbortController();
  const client = transport({ flagged: ['a', 'b', 'c'], get(call, options) {
    if (call.kind !== 'github') return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new FetchError('CANCELLED', 'cancelled fixture')), { once: true });
      started.resolve();
    });
  } });
  const pending = scan({ ...setup(['a', 'b', 'c']), concurrency: 1, signal: abort.signal }, client);
  await started.promise;
  await nextTurn();
  abort.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(client.calls.filter((call) => call.kind !== 'github').length, 1);
});

for (const failedChunk of [false, true]) {
  test(`prefetch waits for all bulk chunks${failedChunk ? ' and skips a partial failure' : ''}`, { timeout: 3000 }, async () => {
    const first = deferred();
    const second = deferred();
    const prefetch = deferred();
    const latest = deferred();
    let posts = 0;
    const client = transport({ async post() {
      posts += 1;
      if (posts === 1) { first.resolve(); return json({ pkg: [advisory] }); }
      await second.promise;
      return failedChunk ? { status: 500, headers: {}, body: '', wireBytes: 0 } : json({});
    }, async get(call) {
      if (call.kind === 'latest') await latest.promise;
      if (call.kind === 'packument') prefetch.resolve();
    } });
    const options = setup();
    const lock = JSON.parse(options.lockfileText);
    lock.packages['node_modules/pkg'].dependencies = {};
    for (let i = 0; i < 500; i += 1) {
      lock.packages['node_modules/pkg'].dependencies[`child-${i}`] = '1.0.0';
      lock.packages[`node_modules/child-${i}`] = { version: '1.0.0' };
    }
    const pending = scan({ ...options, lockfileText: JSON.stringify(lock) }, client);
    await first.promise;
    await nextTurn();
    assert.equal(posts, 2);
    assert.equal(client.calls.filter((call) => call.kind === 'packument').length, 0);
    second.resolve();
    if (!failedChunk) await prefetch.promise;
    else await nextTurn();
    assert.equal(client.calls.filter((call) => call.kind === 'packument').length, failedChunk ? 0 : 1);
    latest.resolve();
    const result = await pending;
    assert.equal(result.availability.advisories, failedChunk ? 'unavailable' : 'complete');
  });
}

test('scoped prefetch and version escalation use the routed registry and one shared packument', async () => {
  const client = transport({ flagged: ['@scope/pkg'] });
  await scan({ ...setup(['@scope/pkg']), concurrency: 1, resolvedRegistry: {
    url: PUBLIC, source: 'default', scoped: { '@scope': 'https://private.fixture.invalid/' },
  } }, client);
  const metadata = client.calls.filter((call) => call.kind !== 'github');
  assert.ok(metadata.every((call) => call.url.startsWith('https://private.fixture.invalid/@scope%2fpkg')));
  assert.equal(metadata.filter((call) => call.kind === 'packument').length, 1);
  assert.equal(client.peak, 1);
});
