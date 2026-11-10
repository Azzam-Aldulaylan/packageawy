import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { REGISTRY, SIZES, PUBLIC_BEHIND_PINS, fixture, fakeAdapters } from '../scripts/performance/registry-fixtures.mjs';

async function run(data, store, registry = data.registry) {
  const { client, auditRunner } = fakeAdapters(data, { latest: 0, packument: 0, advisories: 0, audit: 0 });
  const result = await buildPackageRows({ root: '/benchmark/project', ...data, registry, httpClient: client, auditRunner, etagStore: store });
  const calls = client.calls.filter((call) => !call.url.startsWith('https://api.github.com/'));
  return { result, calls, bytes: calls.reduce((sum, call) => sum + call.wireBytes, 0) };
}

test('public-behind-pins strictly reduces bytes with equal requests and rows against the packument path', async () => {
  const data = fixture(PUBLIC_BEHIND_PINS);
  const next = await run(data, new MemoryEtagStore());
  const old = await run(data, new MemoryEtagStore(), REGISTRY);
  assert.deepEqual(next.result, old.result);
  assert.equal(data.vulnerable.size, 0);
  assert.equal(next.calls.length, old.calls.length);
  assert.equal(next.calls.filter((call) => call.kind === 'exact-version').length, PUBLIC_BEHIND_PINS.direct);
  assert.equal(next.calls.filter((call) => call.kind === 'packument').length, 0);
  assert.ok(next.bytes < old.bytes, `${next.bytes} < ${old.bytes}`);
});

for (const size of SIZES) {
  test(`${size.name} caret fixture keeps equal requests, bytes and rows, cold and populated`, async () => {
    const data = fixture(size);
    const publicData = { ...data, registry: 'https://registry.npmjs.org/' };
    const oldStore = new MemoryEtagStore();
    const nextStore = new MemoryEtagStore();
    for (let scan = 0; scan < 2; scan += 1) {
      const old = await run(data, oldStore);
      const next = await run(publicData, nextStore);
      assert.deepEqual(next.result, old.result);
      assert.equal(next.calls.length, old.calls.length);
      assert.equal(next.bytes, old.bytes);
      assert.equal(next.calls.filter((call) => call.kind === 'exact-version').length, 0);
    }
  });
}

test('populated cache permits only new exact-document bytes when cached packuments would return 304', async () => {
  const data = fixture(PUBLIC_BEHIND_PINS);
  const oldStore = new MemoryEtagStore();
  const nextStore = new MemoryEtagStore();
  // Populate the public URLs with today's packument-only responses by using
  // caret ranges whose latest is outside the range, then scan exact pins.
  const caret = fixture({ ...PUBLIC_BEHIND_PINS, exactPins: false });
  const outside = JSON.parse(caret.manifestText);
  for (const name of Object.keys(outside.dependencies)) outside.dependencies[name] = '~1.0.0';
  const seed = { ...data, manifestText: JSON.stringify(outside) };
  await run(seed, oldStore);
  await run(seed, nextStore);
  const old = await run(seed, oldStore);
  const next = await run(data, nextStore);
  const exactBytes = next.calls.filter((call) => call.kind === 'exact-version').reduce((sum, call) => sum + call.wireBytes, 0);
  assert.equal(next.calls.length, old.calls.length);
  assert.equal(next.bytes - old.bytes, exactBytes);
  const warm = await run(data, nextStore);
  assert.equal(warm.bytes, old.bytes);
});
