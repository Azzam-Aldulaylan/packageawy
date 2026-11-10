/** The file-backed cache store and the one-time move out of global state. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileKeyValueStore, migrateStoreKeys } from '../out/host/platform/fileKeyValueStore.js';
import { PersistentEtagStore, REGISTRY_CACHE_STORAGE_KEY } from '../out/core/cache/persistentEtagStore.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'packageawy-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'cache');
}

function memento(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key),
    update: async (key, value) => { if (value === undefined) data.delete(key); else data.set(key, value); },
  };
}

const collection = { schemaVersion: 2, entries: [['https://registry.npmjs.org/axios', { etag: 'W/"1"', body: '{"name":"axios"}' }]] };

test('values round-trip through files and survive a new store', async (t) => {
  const dir = tempDir(t);
  const store = new FileKeyValueStore(dir);
  assert.equal(store.get('k'), undefined);
  await store.update('k', { a: 1 });
  assert.deepEqual(store.get('k'), { a: 1 });
  assert.deepEqual(new FileKeyValueStore(dir).get('k'), { a: 1 });
  assert.deepEqual(readdirSync(dir), ['k.json']);
  await store.update('k', undefined);
  assert.equal(new FileKeyValueStore(dir).get('k'), undefined);
});

test('a corrupt file reads as missing', async (t) => {
  const dir = tempDir(t);
  await new FileKeyValueStore(dir).update('k', 1);
  writeFileSync(join(dir, 'k.json'), '{not json');
  assert.equal(new FileKeyValueStore(dir).get('k'), undefined);
});

test('the old global state cache moves to files and the old key is dropped', async (t) => {
  const dir = tempDir(t);
  const globalState = memento({ [REGISTRY_CACHE_STORAGE_KEY]: collection, 'other.setting': true });
  const files = new FileKeyValueStore(dir);
  await migrateStoreKeys(globalState, files, [REGISTRY_CACHE_STORAGE_KEY]);
  assert.equal(globalState.get(REGISTRY_CACHE_STORAGE_KEY), undefined);
  assert.equal(globalState.get('other.setting'), true, 'small state stays');
  assert.deepEqual(new FileKeyValueStore(dir).get(REGISTRY_CACHE_STORAGE_KEY), collection);
  // A second run finds nothing to move.
  await migrateStoreKeys(globalState, files, [REGISTRY_CACHE_STORAGE_KEY]);
  assert.deepEqual(files.get(REGISTRY_CACHE_STORAGE_KEY), collection);
});

test('a newer file value wins over a leftover global state value', async (t) => {
  const dir = tempDir(t);
  const files = new FileKeyValueStore(dir);
  const newer = { schemaVersion: 2, entries: [] };
  await files.update(REGISTRY_CACHE_STORAGE_KEY, newer);
  const globalState = memento({ [REGISTRY_CACHE_STORAGE_KEY]: collection });
  await migrateStoreKeys(globalState, files, [REGISTRY_CACHE_STORAGE_KEY]);
  assert.deepEqual(files.get(REGISTRY_CACHE_STORAGE_KEY), newer);
  assert.equal(globalState.get(REGISTRY_CACHE_STORAGE_KEY), undefined);
});

test('the registry cache persists into the file store with the same bounds', async (t) => {
  const dir = tempDir(t);
  const files = new FileKeyValueStore(dir);
  const store = new PersistentEtagStore(files, undefined, { trailingDelayMs: 0, maxDelayMs: 0 });
  store.set('https://registry.npmjs.org/left-pad', { etag: 'W/"2"', body: '{"name":"left-pad"}' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  store.dispose();
  const written = JSON.parse(readFileSync(join(dir, `${encodeURIComponent(REGISTRY_CACHE_STORAGE_KEY)}.json`), 'utf8'));
  assert.equal(written.schemaVersion, 2);
  assert.deepEqual(written.entries.map(([key]) => key), ['https://registry.npmjs.org/left-pad']);
});
