import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FetchError } from '../out/core/registry/http.js';
import { fetchVersionInfo, MemoryEtagStore } from '../out/core/registry/versions.js';

const registry = 'https://registry.npmjs.org/';
const json = (value, etag = '"fixture"') => {
  const body = JSON.stringify(value);
  return { status: 200, headers: { etag }, body, wireBytes: Buffer.byteLength(body) };
};
const pin = { name: 'pkg', range: '1.2.3', installed: '1.2.3' };

function recorded({ name = 'pkg', latest = '2.0.0', exact, packument, latestResponse } = {}) {
  const calls = [];
  const encoded = name.replace('/', '%2f');
  const routes = {
    [`${registry}${encoded}/latest`]: latestResponse ?? json({ version: latest, description: 'About pkg', license: 'MIT', deprecated: 'Notice' }),
    [`${registry}${encoded}/1.2.3`]: exact ?? json({ name, version: '1.2.3', license: 'ISC', deprecated: 'Exact notice' }),
    [`${registry}${encoded}`]: packument ?? json({ versions: { '1.2.3': {}, [latest]: {} }, 'dist-tags': { latest } }),
    [`${registry}-/package/${encoded}/dist-tags`]: json({ latest }),
  };
  return {
    calls,
    async get(url, options = {}) {
      const call = { url, headers: options.headers, bytes: 0 };
      calls.push(call);
      const route = routes[url];
      if (route instanceof Error) throw route;
      assert.ok(route, url);
      const response = options.headers?.['if-none-match'] === route.headers.etag
        ? { status: 304, headers: {}, body: '', wireBytes: 0 } : route;
      call.bytes = response.wireBytes;
      return response;
    },
  };
}
const resolve = (client, eligible = true, extra = {}, req = pin, store = new MemoryEtagStore()) =>
  fetchVersionInfo({ client, store, registry, ...extra }, { ...req, exactPinEligible: eligible });

for (const latest of ['2.0.0', '1.0.0']) {
  test(`eligible pin with latest ${latest} confirms the exact document and equals the packument result`, async () => {
    const client = recorded({ latest });
    const baseline = await resolve(recorded({ latest }), false);
    assert.deepEqual(await resolve(client), baseline);
    assert.deepEqual(client.calls.map((call) => call.url), [`${registry}pkg/latest`, `${registry}pkg/1.2.3`]);
  });
}

test('current pin uses one request and flagged pin uses the shared packument path', async () => {
  const current = recorded({ latest: pin.range });
  assert.deepEqual(await resolve(current), await resolve(recorded({ latest: pin.range }), false));
  assert.equal(current.calls.length, 1);
  const flagged = recorded();
  assert.deepEqual(await resolve(flagged, true, { isFlagged: () => true }), await resolve(recorded(), false));
  assert.deepEqual(flagged.calls.map((call) => call.url), [`${registry}pkg/latest`, `${registry}pkg`]);
});

const failures = {
  '404': { status: 404, headers: {}, body: '', wireBytes: 20 },
  network: new FetchError('NETWORK', 'fixture network failure'),
  malformed: { status: 200, headers: {}, body: '{', wireBytes: 1 },
  'version mismatch': json({ name: 'pkg', version: '1.2.4' }),
  'name mismatch': json({ name: 'other', version: pin.range }),
};
for (const [label, exact] of Object.entries(failures)) {
  test(`exact ${label} falls back with exactly one extra request, cold and cached`, async () => {
    const client = recorded({ exact });
    const baseline = recorded({ exact });
    const store = new MemoryEtagStore();
    const oldStore = new MemoryEtagStore();
    for (let scan = 0; scan < 2; scan += 1) {
      client.calls.length = baseline.calls.length = 0;
      assert.deepEqual(await resolve(client, true, {}, pin, store), await resolve(baseline, false, {}, pin, oldStore));
      assert.equal(client.calls.length, baseline.calls.length + 1);
      assert.equal(client.calls.filter((call) => call.url.endsWith('/1.2.3')).length, 1);
      const bytes = (calls) => calls.reduce((sum, call) => sum + call.bytes, 0);
      assert.equal(bytes(client.calls) - bytes(baseline.calls), client.calls[1].bytes);
    }
  });
}

for (const latest of ['invalid', null]) {
  test(`invalid latest ${latest} goes directly to today's packument path`, async () => {
    const packument = json({ versions: { '1.2.3': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } });
    const client = recorded({ latest, packument });
    assert.deepEqual(await resolve(client), await resolve(recorded({ latest, packument }), false));
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[1].url, `${registry}pkg`);
  });
}

for (const latestResponse of [failures['404'], failures.network, failures.malformed]) {
  test(`/latest failure ${latestResponse.code ?? latestResponse.status} keeps today's failure`, async () => {
    for (const eligible of [false, true]) {
      const client = recorded({ latestResponse });
      await assert.rejects(resolve(client, eligible));
      assert.equal(client.calls.length, 1);
    }
  });
}

test('public scoped pin uses @scope%2fname and matches the packument result', async () => {
  const client = recorded({ name: '@scope/name' });
  const req = { ...pin, name: '@scope/name' };
  assert.deepEqual(await resolve(client, true, {}, req), await resolve(recorded({ name: req.name }), false, {}, req));
  assert.equal(client.calls[1].url, `${registry}@scope%2fname/1.2.3`);
});

test('304 confirms the exact pin using its cached body', async () => {
  const client = recorded();
  const store = new MemoryEtagStore();
  const first = await resolve(client, true, {}, pin, store);
  client.calls.length = 0;
  assert.deepEqual(await resolve(client, true, {}, pin, store), first);
  assert.equal(client.calls[1].headers['if-none-match'], '"fixture"');
  assert.equal(client.calls[1].bytes, 0);
  assert.equal(client.calls.length, 2);
});

test('approved difference: small documents succeed when the packument fails', async () => {
  const packument = new FetchError('NETWORK', 'packument failed');
  await assert.rejects(resolve(recorded({ packument }), false), { code: 'NETWORK' });
  assert.equal((await resolve(recorded({ packument }))).wanted, pin.range);
});

test('approved availability case: TOO_LARGE fallback already gives the same wanted', async () => {
  const packument = new FetchError('TOO_LARGE', 'fixture oversized');
  assert.deepEqual(await resolve(recorded({ packument })), await resolve(recorded({ packument }), false));
});

test('approved difference: /latest and packument dist-tags temporarily disagree', async () => {
  const packument = json({ versions: { '1.2.3': {}, '2.0.0': {}, '3.0.0': {} }, 'dist-tags': { latest: '2.0.0' } });
  const old = await resolve(recorded({ latest: '3.0.0', packument }), false);
  const next = await resolve(recorded({ latest: '3.0.0', packument }));
  assert.deepEqual(next, { ...old, latest: '3.0.0' });
  assert.equal(old.latest, '2.0.0');
});

test('approved difference: exact document reports a pin the stale packument lacks', async () => {
  const packument = json({ versions: { '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } });
  const old = await resolve(recorded({ packument }), false);
  assert.equal(old.wanted, null);
  assert.deepEqual(await resolve(recorded({ packument })), { ...old, wanted: pin.range });
});
