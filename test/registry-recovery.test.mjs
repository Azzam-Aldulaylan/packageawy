import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FetchError } from '../out/core/registry/http.js';
import {
  ABBREVIATED_ACCEPT,
  MemoryEtagStore,
  fetchDistTags,
  fetchLatest,
  fetchPackageVersionMetadata,
  fetchPackument,
  getConditional,
} from '../out/core/registry/versions.js';
import {
  PersistentEtagStore,
  REGISTRY_CACHE_STORAGE_KEY,
} from '../out/core/cache/persistentEtagStore.js';

const registry = 'https://registry.example';
const corrupt = { etag: '"legacy"', body: '{broken' };
const notModified = { status: 304, headers: {}, body: '', wireBytes: 7 };
const jsonResponse = (value) => {
  const body = JSON.stringify(value);
  return { status: 200, headers: { etag: '"fresh"' }, body, wireBytes: Buffer.byteLength(body) };
};

function sequenceClient(...responses) {
  const calls = [];
  return {
    calls,
    async get(url, options) {
      calls.push({ url, ...options, headers: { ...options.headers } });
      assert.ok(calls.length <= responses.length, 'no unexpected recovery requests');
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

const endpoints = [
  {
    label: 'latest', path: '/pkg/latest', accept: 'application/json',
    load: (client, store, signal) => fetchLatest(client, store, registry, 'pkg', signal),
    document: { version: '2.0.0' }, expected: { version: '2.0.0' },
  },
  {
    label: 'packument', path: '/pkg', accept: ABBREVIATED_ACCEPT,
    load: (client, store, signal) => fetchPackument(client, store, registry, 'pkg', signal),
    document: { versions: { '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } },
    expected: { versions: ['2.0.0'], distTags: { latest: '2.0.0' } },
  },
  {
    label: 'dist-tags', path: '/-/package/pkg/dist-tags', accept: 'application/json',
    load: (client, store, signal) => fetchDistTags(client, store, registry, 'pkg', signal),
    document: { latest: '2.0.0' }, expected: { latest: '2.0.0' },
  },
  {
    label: 'exact metadata', path: '/pkg/2.0.0', accept: 'application/json',
    load: (client, store, signal) => fetchPackageVersionMetadata(client, store, registry, 'pkg', '2.0.0', signal),
    document: { name: 'pkg', version: '2.0.0' },
    expected: {
      name: 'pkg', version: '2.0.0', dependencies: {}, optionalDependencies: {},
      peerDependencies: {}, peerDependenciesMeta: {}, main: null,
    },
  },
];

for (const endpoint of endpoints) {
  const url = registry + endpoint.path;
  test(`${endpoint.label}: a legacy corrupt 304 body is replaced with one unconditional request`, async () => {
    const store = new MemoryEtagStore();
    store.set(url, corrupt);
    const fresh = jsonResponse(endpoint.document);
    const client = sequenceClient(notModified, fresh);
    const { signal } = new AbortController();

    assert.deepEqual(await endpoint.load(client, store, signal), endpoint.expected);
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls.map((call) => call.url), [url, url]);
    assert.deepEqual(client.calls.map((call) => call.headers), [
      { accept: endpoint.accept, 'if-none-match': corrupt.etag },
      { accept: endpoint.accept },
    ]);
    assert.ok(client.calls.every((call) => call.signal === signal));
    assert.deepEqual(store.get(url), { etag: fresh.headers.etag, body: fresh.body });
  });

  for (const body of ['{broken', 'null', '"unexpected"']) {
    test(`${endpoint.label}: an unreadable 200 body (${body}) is never stored or retried`, async () => {
      const store = new MemoryEtagStore();
      const client = sequenceClient({ ...jsonResponse({}), body });
      await assert.rejects(endpoint.load(client, store), { code: 'PARSE_ERROR' });
      assert.equal(store.get(url), undefined);
      assert.equal(client.calls.length, 1);
    });
  }
}

const failures = [
  ['malformed JSON', { ...jsonResponse({}), body: '{broken again' }, 'PARSE_ERROR'],
  ['invalid JSON shape', jsonResponse(null), 'PARSE_ERROR'],
  ['server error', { status: 503, headers: {}, body: '', wireBytes: 3 }, 'REGISTRY_5XX'],
  ['missing package', { status: 404, headers: {}, body: '', wireBytes: 3 }, 'REGISTRY_404'],
  ['another 304', notModified, 'NETWORK'],
  ...['NETWORK', 'TIMEOUT', 'TOO_LARGE', 'CANCELLED'].map((code) => [
    code, new FetchError(code, 'fixture failure'), code,
  ]),
];

for (const [label, response, code] of failures) {
  test(`recovery ${label} throws its error, deletes corruption, and stops after two requests`, async () => {
    const url = registry + '/pkg';
    const store = new MemoryEtagStore();
    store.set(url, corrupt);
    const client = sequenceClient(notModified, response);

    await assert.rejects(fetchPackument(client, store, registry, 'pkg'), (error) => {
      assert.equal(error.code, code);
      if (response instanceof Error) assert.equal(error, response);
      return true;
    });
    assert.equal(client.calls.length, 2);
    assert.equal(store.get(url), undefined);
    assert.equal(client.calls[1].headers['if-none-match'], undefined);
  });
}

test('JSON helper exposes recovery and accounts for both requests without changing the good 304 path', async () => {
  const url = registry + '/pkg';
  const store = new MemoryEtagStore();
  const fresh = jsonResponse({ versions: {} });
  const client = sequenceClient(fresh, notModified, notModified, fresh);
  const load = () => getConditional(client, store, url, ABBREVIATED_ACCEPT);

  assert.deepEqual(await load(), {
    json: { versions: {} }, wireBytes: fresh.wireBytes, notModified: false, recovered: false,
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(await load(), {
    json: { versions: {} }, wireBytes: notModified.wireBytes, notModified: true, recovered: false,
  });
  assert.equal(client.calls.length, 2);
  store.set(url, corrupt);
  assert.deepEqual(await load(), {
    json: { versions: {} }, wireBytes: notModified.wireBytes + fresh.wireBytes,
    notModified: false, recovered: true,
  });
  assert.equal(client.calls.length, 4);
});

test('a store without optional delete still refetches unconditionally and replaces corrupt data', async () => {
  const entries = new Map([[registry + '/pkg', corrupt]]);
  const store = { get: (key) => entries.get(key), set: (key, value) => entries.set(key, value) };
  const endpoint = endpoints[1];
  const fresh = jsonResponse(endpoint.document);
  const client = sequenceClient(notModified, fresh);
  assert.deepEqual(await endpoint.load(client, store), endpoint.expected);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].headers['if-none-match'], undefined);
  assert.equal(store.get(registry + '/pkg').body, fresh.body);
});

for (const succeeds of [true, false]) {
  test(`persisted legacy corruption stays ${succeeds ? 'repaired' : 'deleted'} across a reload`, async () => {
    const url = registry + '/pkg';
    const data = new Map([[REGISTRY_CACHE_STORAGE_KEY, { schemaVersion: 2, entries: [[url, corrupt]] }]]);
    const backing = {
      get: (key) => data.get(key),
      async update(key, value) { data.set(key, value); },
    };
    const store = new PersistentEtagStore(backing);
    const fresh = jsonResponse(endpoints[1].document);
    const client = sequenceClient(notModified, succeeds ? fresh : new FetchError('NETWORK', 'fixture failure'));
    if (succeeds) await fetchPackument(client, store, registry, 'pkg');
    else await assert.rejects(fetchPackument(client, store, registry, 'pkg'), { code: 'NETWORK' });
    store.dispose();
    await new Promise((resolve) => setImmediate(resolve));

    const reloaded = new PersistentEtagStore(backing);
    assert.deepEqual(reloaded.get(url), succeeds ? { etag: fresh.headers.etag, body: fresh.body } : undefined);
    assert.equal(client.calls.length, 2);
    reloaded.dispose();
  });
}
