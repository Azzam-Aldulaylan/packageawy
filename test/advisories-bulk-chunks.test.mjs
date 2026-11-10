import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBulkAdvisories } from '../out/core/advisories/bulk.js';
import { auditUpgradeReview } from '../out/host/upgradeReviewSecurity.js';

const maxBytes = 256 * 1024;
const response = body => ({ status: 200, body: JSON.stringify(body) });
const rawAdvisory = name => ({ id: name, url: `https://example.com/${name}`, title: name,
  severity: 'high', vulnerable_versions: '*' });
const bodyOf = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`pkg-${i}`, ['1.0.0']]));

for (const [count, sizes] of [[500, [500]], [501, [500, 1]], [1001, [500, 500, 1]]]) {
  test(`bulk requests split ${count} packages at the 500 package boundary and merge results`, async () => {
    const requests = [];
    const result = await fetchBulkAdvisories({ post: async (_, body) => {
      const names = Object.keys(JSON.parse(body));
      requests.push(names);
      return response(Object.fromEntries(names.filter(name => name !== 'pkg-0').map(name => [name, [rawAdvisory(name)]])));
    } }, bodyOf(count));
    assert.deepEqual(requests.map(names => names.length), sizes);
    assert.equal(result.size, count - 1);
    assert.equal(result.has('pkg-0'), false, 'clean packages remain absent');
    assert.equal(result.get(`pkg-${count - 1}`)[0].vulnerableVersions, '*');
  });
}

test('serialized UTF-8 bytes, JSON escaping and braces count toward the request size boundary', async () => {
  // Exact byte boundary for the first entry, then one more entry forces a split.
  const name = 'pkg';
  const overhead = Buffer.byteLength(JSON.stringify({ [name]: [''] }));
  const body = { [name]: ['x'.repeat(maxBytes - overhead)], second: ['1.0.0'] };
  const requests = [];
  await fetchBulkAdvisories({ post: async (_, serialized) => { requests.push(serialized); return response({}); } }, body);
  assert.deepEqual(requests.map(serialized => Buffer.byteLength(serialized)), [maxBytes, Buffer.byteLength(JSON.stringify({ second: ['1.0.0'] }))]);
  assert.deepEqual(Object.assign({}, ...requests.map(serialized => JSON.parse(serialized))), body);

  const unicode = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`unicode-${i}`, ['é"'.repeat(30_000)]]));
  const encoded = [];
  await fetchBulkAdvisories({ post: async (_, serialized) => { encoded.push(serialized); return response({}); } }, unicode);
  assert.ok(encoded.length > 1);
  assert.ok(encoded.every(serialized => Buffer.byteLength(serialized) <= maxBytes));
  assert.deepEqual(Object.assign({}, ...encoded.map(serialized => JSON.parse(serialized))), unicode);
});

test('a single package exceeding the byte budget fails before dispatch', async () => {
  let posts = 0;
  await assert.rejects(fetchBulkAdvisories({ post: async () => { posts++; return response({}); } },
    { huge: ['x'.repeat(maxBytes)] }), error => error.code === 'TOO_LARGE');
  assert.equal(posts, 0);
});

test('bulk requests have at most two in flight and preserve the caller cancellation signal', async () => {
  const signal = new AbortController().signal;
  const pending = [];
  let active = 0;
  let peak = 0;
  const work = fetchBulkAdvisories({ post: async (_, body, options) => {
    assert.equal(options.signal, signal);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => pending.push(resolve));
    active--;
    return response({});
  } }, bodyOf(1501), signal);
  await new Promise(resolve => setImmediate(resolve));
  const initiallyStarted = pending.length;
  // Drain without timers so even a broken concurrency bound cannot hang the test.
  while (pending.length) {
    pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  await work;
  assert.equal(initiallyStarted, 2);
  assert.equal(peak, 2);
});

test('one failed chunk makes the whole review unavailable even when another chunk is clean', async () => {
  const graph = { root: '/fixture', packageManager: 'npm', lockfileVersion: 3,
    nodes: new Map(Object.keys(bodyOf(501)).map(name => [name, { name, path: name, version: '1.0.0',
      direct: true, dev: false, range: '1.0.0', deps: [], edges: [] }])) };
  const requests = [];
  const security = await auditUpgradeReview({ before: graph, after: graph, enabled: () => true,
    signal: new AbortController().signal, client: { post: async (_, body) => {
      const names = Object.keys(JSON.parse(body));
      requests.push(names);
      return names.includes('pkg-500') ? { status: 503, body: '' } : response({});
    } } });
  assert.deepEqual(requests.map(names => names.length), [500, 1]);
  assert.equal(security.checkState, 'unavailable');
  assert.equal(security.status, 'unknown');
  assert.deepEqual(security.introduced, []);
});
