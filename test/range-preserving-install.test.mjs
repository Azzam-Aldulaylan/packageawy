import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRangePreservingInstall } from '../out/host/rangePreservingInstall.js';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';

const text = (state) => (state.exists ? Buffer.from(state.contents).toString('utf8') : null);

function memoryFiles(initial) {
  const states = new Map(Object.entries(initial).map(([path, value]) => [path, Buffer.from(value)]));
  return {
    states,
    async read(path) {
      const value = states.get(path);
      return value === undefined ? { exists: false } : { exists: true, contents: Uint8Array.from(value) };
    },
    async compareAndSwap(path, expected, replacement) {
      const current = states.get(path);
      const matches = expected.exists
        ? current !== undefined && current.equals(Buffer.from(expected.contents))
        : current === undefined;
      if (!matches) return 'conflict';
      if (replacement.exists) states.set(path, Buffer.from(replacement.contents));
      else states.delete(path);
      return 'restored';
    },
  };
}

const original = '{\n  "dependencies": {\n    "a": "^1.0.0"\n  }\n}\n';
const staged = original.replace('^1.0.0', '1.2.0');
const styled = original.replace('^1.0.0', '^1.2.0');
const userEdit = original.replace('"a": "^1.0.0"', '"a": "^1.0.0",\n    "b": "^2.0.0"');

test('a package.json edit during pass one is kept as a rollback conflict, not overwritten', async () => {
  const files = memoryFiles({ '/p/package.json': original, '/p/package-lock.json': 'old-lock' });
  let restyleRan = false;
  const result = await runUpgradeTransaction({
    allowlistedPaths: ['/p/package.json', '/p/package-lock.json'],
    files,
    manifestStage: { path: '/p/package.json', expectedContents: Buffer.from(original), contents: Buffer.from(staged) },
    install: createRangePreservingInstall({
      files,
      manifestPath: '/p/package.json',
      stagedManifest: staged,
      styledManifest: styled,
      resolve: async () => {
        files.states.set('/p/package-lock.json', Buffer.from('new-lock'));
        files.states.set('/p/package.json', Buffer.from(userEdit));
        return { ok: true };
      },
      restyle: async () => {
        restyleRan = true;
        return { ok: true };
      },
    }),
  });
  assert.equal(restyleRan, false);
  assert.equal(result.install.status, 'failed');
  assert.equal(result.install.code, 'STALE_SOURCE');
  assert.equal(text(await files.read('/p/package.json')), userEdit);
  assert.equal(text(await files.read('/p/package-lock.json')), 'old-lock');
  const manifestRollback = result.rollback.files.find((file) => file.path === '/p/package.json');
  assert.equal(manifestRollback.status, 'conflict');
  assert.notEqual(result.completion, 'rolled-back');
});

test('without a concurrent edit both passes run and the styled manifest is kept', async () => {
  const files = memoryFiles({ '/p/package.json': original, '/p/package-lock.json': 'old-lock' });
  const result = await runUpgradeTransaction({
    allowlistedPaths: ['/p/package.json', '/p/package-lock.json'],
    files,
    manifestStage: { path: '/p/package.json', expectedContents: Buffer.from(original), contents: Buffer.from(staged) },
    install: createRangePreservingInstall({
      files,
      manifestPath: '/p/package.json',
      stagedManifest: staged,
      styledManifest: styled,
      resolve: async () => ({ ok: true }),
      restyle: async () => {
        files.states.set('/p/package-lock.json', Buffer.from('styled-lock'));
        return { ok: true };
      },
    }),
  });
  assert.equal(result.completion, 'kept');
  assert.equal(text(await files.read('/p/package.json')), styled);
});

test('a failed pass one rolls back to the original manifest', async () => {
  const files = memoryFiles({ '/p/package.json': original, '/p/package-lock.json': 'old-lock' });
  const result = await runUpgradeTransaction({
    allowlistedPaths: ['/p/package.json', '/p/package-lock.json'],
    files,
    manifestStage: { path: '/p/package.json', expectedContents: Buffer.from(original), contents: Buffer.from(staged) },
    install: createRangePreservingInstall({
      files,
      manifestPath: '/p/package.json',
      stagedManifest: staged,
      styledManifest: styled,
      resolve: async () => ({ ok: false, code: 'PACKAGE_MANAGER_FAILED', message: 'boom' }),
      restyle: async () => ({ ok: true }),
    }),
  });
  assert.equal(result.completion, 'rolled-back');
  assert.equal(text(await files.read('/p/package.json')), original);
});
