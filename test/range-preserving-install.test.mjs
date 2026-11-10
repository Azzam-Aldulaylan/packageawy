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

function runWithEdit({ resolve, restyle, verifier }) {
  const files = memoryFiles({ '/p/package.json': original, '/p/package-lock.json': 'old-lock' });
  const edit = () => files.states.set('/p/package.json', Buffer.from(userEdit));
  const result = runUpgradeTransaction({
    allowlistedPaths: ['/p/package.json', '/p/package-lock.json'],
    files,
    manifestStage: { path: '/p/package.json', expectedContents: Buffer.from(original), contents: Buffer.from(staged) },
    install: createRangePreservingInstall({
      manifestPath: '/p/package.json',
      stagedManifest: staged,
      styledManifest: styled,
      resolve: () => resolve(files, edit),
      restyle: () => restyle(files, edit),
    }),
    ...(verifier === undefined
      ? {}
      : { verifier: { verify: () => verifier(files, edit) }, verificationFailureDecider: { decide: async () => 'rollback' } }),
  });
  return { files, result };
}

async function assertEditKept({ files, result }) {
  const outcome = await result;
  assert.equal(text(await files.read('/p/package.json')), userEdit, 'the user edit survives rollback');
  assert.equal(outcome.rollback.files.find((file) => file.path === '/p/package.json').status, 'conflict');
  assert.equal(outcome.completion, 'incomplete');
  assert.equal(text(await files.read('/p/package-lock.json')), 'old-lock');
}

const lockWrite = (files) => files.states.set('/p/package-lock.json', Buffer.from('new-lock'));

test('(a) an edit made while pass one fails is kept', async () => {
  await assertEditKept(runWithEdit({
    resolve: async (files, edit) => { lockWrite(files); edit(); return { ok: false, code: 'X', message: 'pass one failed' }; },
    restyle: async () => ({ ok: true }),
  }));
});

test('(b) an edit made while pass two fails is kept', async () => {
  await assertEditKept(runWithEdit({
    resolve: async (files) => { lockWrite(files); return { ok: true }; },
    restyle: async (_files, edit) => { edit(); return { ok: false, code: 'X', message: 'pass two failed' }; },
  }));
});

test('(c) an edit made before pass one throws is kept', async () => {
  await assertEditKept(runWithEdit({
    resolve: async (files, edit) => { lockWrite(files); edit(); throw new Error('spawn failed'); },
    restyle: async () => ({ ok: true }),
  }));
});

test('(d) an edit made during successful passes is kept when verification then rolls back', async () => {
  await assertEditKept(runWithEdit({
    resolve: async (files) => { lockWrite(files); return { ok: true }; },
    restyle: async (_files, edit) => { edit(); return { ok: true }; },
    verifier: async () => ({ status: 'failed', checks: [{ id: 'test', status: 'failed' }] }),
  }));
});

test('an edit made during verification itself is kept too', async () => {
  await assertEditKept(runWithEdit({
    resolve: async (files) => { lockWrite(files); return { ok: true }; },
    restyle: async () => ({ ok: true }),
    verifier: async (_files, edit) => { edit(); return { status: 'failed', checks: [{ id: 'test', status: 'failed' }] }; },
  }));
});

test('without an edit, a failed verification restores the original manifest and lockfile', async () => {
  const { files, result } = runWithEdit({
    resolve: async (files) => { lockWrite(files); return { ok: true }; },
    restyle: async () => ({ ok: true }),
    verifier: async () => ({ status: 'failed', checks: [{ id: 'test', status: 'failed' }] }),
  });
  const outcome = await result;
  assert.equal(outcome.completion, 'rolled-back');
  assert.equal(text(await files.read('/p/package.json')), original);
  assert.equal(text(await files.read('/p/package-lock.json')), 'old-lock');
});
