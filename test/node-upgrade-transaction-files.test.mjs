import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  UpgradeTransactionPathError,
  createNodeUpgradeTransactionFileAdapter,
  fileStatesEqual,
} from '../out/host/nodeUpgradeTransactionFiles.js';

const encoder = new TextEncoder();

function present(text) {
  return { exists: true, contents: encoder.encode(text) };
}

const missing = { exists: false };

async function workspaceFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-transaction-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('Node adapter reads exact bytes and atomically replaces an expected existing file', async (t) => {
  const root = await workspaceFixture(t);
  const manifest = path.join(root, 'package.json');
  const before = Buffer.from([0x7b, 0x0a, 0x20, 0x20, 0xc3, 0xa9, 0x0a, 0x7d]);
  await writeFile(manifest, before);
  const adapter = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: root,
    allowlistedPaths: [manifest],
  });

  const snapshot = await adapter.read(manifest);
  assert.equal(snapshot.exists, true);
  assert.deepEqual(Buffer.from(snapshot.contents), before);

  await writeFile(manifest, 'installed');
  assert.equal(await adapter.compareAndSwap(manifest, present('installed'), snapshot), 'restored');
  assert.deepEqual(await readFile(manifest), before);
});

test('Node adapter preserves existing file permission bits when CAS replaces its inode', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows does not expose POSIX permission modes');
    return;
  }

  const root = await workspaceFixture(t);
  const manifest = path.join(root, 'package.json');
  await writeFile(manifest, 'before');
  await chmod(manifest, 0o640);
  const adapter = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: root,
    allowlistedPaths: [manifest],
  });

  assert.equal(await adapter.compareAndSwap(manifest, present('before'), present('staged')), 'restored');
  assert.equal((await stat(manifest)).mode & 0o777, 0o640);
  assert.equal(await readFile(manifest, 'utf8'), 'staged');

  assert.equal(await adapter.compareAndSwap(manifest, present('staged'), present('before')), 'restored');
  assert.equal((await stat(manifest)).mode & 0o777, 0o640, 'rollback replacement preserves the mode too');
});

test('Node adapter keeps transaction-created files private when the expected path is absent', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows does not expose POSIX permission modes');
    return;
  }

  const root = await workspaceFixture(t);
  const lockfile = path.join(root, 'package-lock.json');
  const adapter = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: root,
    allowlistedPaths: [lockfile],
  });

  assert.equal(await adapter.compareAndSwap(lockfile, missing, present('created')), 'restored');
  assert.equal((await stat(lockfile)).mode & 0o777, 0o600);
});

test('Node adapter restores a file expected to be absent without clobbering an existing path', async (t) => {
  const root = await workspaceFixture(t);
  const lockfile = path.join(root, 'package-lock.json');
  const adapter = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: root,
    allowlistedPaths: [lockfile],
  });

  assert.equal(await adapter.compareAndSwap(lockfile, missing, present('restored lock')), 'restored');
  assert.equal(await readFile(lockfile, 'utf8'), 'restored lock');

  // The target is no longer absent. A stale expected state is a conflict and
  // the existing bytes are preserved.
  assert.equal(await adapter.compareAndSwap(lockfile, missing, present('would clobber')), 'conflict');
  assert.equal(await readFile(lockfile, 'utf8'), 'restored lock');
});

test('Node adapter removes a transaction-created file only when exact expected bytes still match', async (t) => {
  const root = await workspaceFixture(t);
  const lockfile = path.join(root, 'package-lock.json');
  await writeFile(lockfile, 'transaction output');
  const adapter = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: root,
    allowlistedPaths: [lockfile],
  });

  assert.equal(
    await adapter.compareAndSwap(lockfile, present('different concurrent edit'), missing),
    'conflict'
  );
  assert.equal(await readFile(lockfile, 'utf8'), 'transaction output');

  assert.equal(await adapter.compareAndSwap(lockfile, present('transaction output'), missing), 'restored');
  assert.deepEqual(await adapter.read(lockfile), missing);
});

test('Node adapter rejects every path not in its exact host-owned allowlist', async (t) => {
  const root = await workspaceFixture(t);
  const manifest = path.join(root, 'package.json');
  const other = path.join(root, 'other.json');
  await writeFile(manifest, '{}');
  await writeFile(other, '{}');
  const adapter = await createNodeUpgradeTransactionFileAdapter({
    workspaceRoot: root,
    allowlistedPaths: [manifest],
  });

  await assert.rejects(
    adapter.read(other),
    (error) => error instanceof UpgradeTransactionPathError && error.code === 'PATH_NOT_ALLOWLISTED'
  );
});

test('factory rejects lexical paths outside the canonical workspace root', async (t) => {
  const root = await workspaceFixture(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside-package.json`);

  await assert.rejects(
    createNodeUpgradeTransactionFileAdapter({
      workspaceRoot: root,
      allowlistedPaths: [outside],
    }),
    (error) => error instanceof UpgradeTransactionPathError && error.code === 'PATH_OUTSIDE_WORKSPACE'
  );
});

test('factory rejects a symlinked allowlisted file that escapes the workspace', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symlinks can require elevated Windows privileges');
    return;
  }

  const root = await workspaceFixture(t);
  const outsideDir = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(async () => {
    await rm(outsideDir, { recursive: true, force: true });
  });
  const outside = path.join(outsideDir, 'package.json');
  const linked = path.join(root, 'package.json');
  await writeFile(outside, '{"outside":true}');
  await symlink(outside, linked);

  await assert.rejects(
    createNodeUpgradeTransactionFileAdapter({
      workspaceRoot: root,
      allowlistedPaths: [linked],
    }),
    (error) => error instanceof UpgradeTransactionPathError && error.code === 'SYMLINK_NOT_ALLOWED'
  );
  assert.equal(await readFile(outside, 'utf8'), '{"outside":true}');
});

test('factory rejects a symlinked ancestor even when the final file does not exist yet', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symlinks can require elevated Windows privileges');
    return;
  }

  const root = await workspaceFixture(t);
  const outsideDir = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-dir-'));
  t.after(async () => {
    await rm(outsideDir, { recursive: true, force: true });
  });
  const linkedDir = path.join(root, 'packages');
  await symlink(outsideDir, linkedDir, 'dir');

  await assert.rejects(
    createNodeUpgradeTransactionFileAdapter({
      workspaceRoot: root,
      allowlistedPaths: [path.join(linkedDir, 'package-lock.json')],
    }),
    (error) => error instanceof UpgradeTransactionPathError && error.code === 'SYMLINK_NOT_ALLOWED'
  );
});

test('factory rejects a symlinked ancestor that points back inside the workspace too', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symlinks can require elevated Windows privileges');
    return;
  }

  const root = await workspaceFixture(t);
  const realPackages = path.join(root, 'real-packages');
  await mkdir(realPackages);
  await writeFile(path.join(realPackages, 'package.json'), '{}');
  const linkedPackages = path.join(root, 'packages');
  await symlink(realPackages, linkedPackages, 'dir');

  await assert.rejects(
    createNodeUpgradeTransactionFileAdapter({
      workspaceRoot: root,
      allowlistedPaths: [path.join(linkedPackages, 'package.json')],
    }),
    (error) => error instanceof UpgradeTransactionPathError && error.code === 'SYMLINK_NOT_ALLOWED'
  );
});

test('FileState equality is exact for bytes and distinguishes missing from empty', () => {
  assert.equal(fileStatesEqual(present('same'), present('same')), true);
  assert.equal(fileStatesEqual(present('same'), present('different')), false);
  assert.equal(fileStatesEqual(missing, missing), true);
  assert.equal(fileStatesEqual(missing, { exists: true, contents: new Uint8Array() }), false);
});

test('any valid spelling of an allowlisted file is the same file, matched through the realpath', async (t) => {
  const root = await workspaceFixture(t);
  await mkdir(path.join(root, 'Member'));
  const manifest = path.join(root, 'Member', 'package.json');
  await writeFile(manifest, 'before');
  const variant = path.join(root, 'member', 'PACKAGE.json');
  if (!(await stat(variant).then(() => true, () => false))) {
    t.skip('this volume is case-sensitive, so other spellings are other files');
    return;
  }
  const adapter = await createNodeUpgradeTransactionFileAdapter({ workspaceRoot: root, allowlistedPaths: [manifest] });
  assert.deepEqual(Buffer.from((await adapter.read(variant)).contents).toString(), 'before');
  await assert.rejects(adapter.read(path.join(root, 'Member', 'other.json')), { code: 'PATH_NOT_ALLOWLISTED' });
  const fromVariant = await createNodeUpgradeTransactionFileAdapter({ workspaceRoot: root, allowlistedPaths: [variant] });
  assert.equal((await fromVariant.read(manifest)).exists, true);
});

/**
 * A fake Windows volume that ignores case, with a short name for the user
 * folder (RUNNER~1 for runneradmin, as os.tmpdir() returns on CI) and
 * `linked`, a link inside the workspace to `real`.
 */
function windowsVolume() {
  // A copy of the module, like `import * as path` gives: never path.win32 itself.
  const win = { ...path.win32 };
  const missing = (target) => Object.assign(new Error(`ENOENT ${target}`), { code: 'ENOENT' });
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
  const real = new Map([
    ['c:\\', 'C:\\'],
    ['c:\\users', 'C:\\Users'],
    ['c:\\users\\runneradmin', 'C:\\Users\\runneradmin'],
    ['c:\\users\\runner~1', 'C:\\Users\\runneradmin'],
  ]);
  for (const [from, to] of [[long, long], [short, long]]) {
    for (const tail of ['', '\\AppData', '\\AppData\\Local', '\\AppData\\Local\\Temp']) {
      const prefix = from.slice(0, from.indexOf('\\AppData'));
      real.set((prefix + tail).toLowerCase(), to.slice(0, to.indexOf('\\AppData')) + tail);
    }
  }
  for (const [name, target] of [['workspace', 'workspace'], ['workspace\\real', 'workspace\\real'], ['workspace\\real\\package-lock.json', 'workspace\\real\\package-lock.json'], ['workspace\\linked', 'workspace\\real']]) {
    real.set(`${long}\\${name}`.toLowerCase(), `${long}\\${target}`);
    real.set(`${short}\\${name}`.toLowerCase(), `${long}\\${target}`);
  }
  const links = new Set([`${long}\\workspace\\linked`.toLowerCase(), `${short}\\workspace\\linked`.toLowerCase()]);
  const key = (target) => win.normalize(target).toLowerCase();
  const checks = {
    path: win,
    lstat: async (target) => {
      if (!real.has(key(target))) throw missing(target);
      return { isSymbolicLink: () => links.has(key(target)) };
    },
    realpath: async (target) => {
      const resolved = real.get(key(target));
      if (resolved === undefined) throw missing(target);
      return resolved;
    },
  };
  return { checks, long, short };
}

test('a short-name or differently cased spelling is accepted, and its links are still found (Windows rules)', async () => {
  const { checks, long, short } = windowsVolume();
  const accepted = [
    [`${long}\\workspace`, `${long}\\workspace\\real\\package-lock.json`],
    // os.tmpdir() returned a short name for the folder, the allowlist uses either spelling.
    [`${short}\\workspace`, `${short}\\workspace\\real\\package-lock.json`],
    [`${short}\\workspace`, `${long}\\workspace\\real\\package-lock.json`],
    [`${long}\\workspace`, `${short}\\WORKSPACE\\Real\\package-lock.json`],
    [`${long}\\workspace`, `c:${long.slice(2)}\\workspace\\real\\new-lock.json`],
  ];
  for (const [workspaceRoot, allowlisted] of accepted) {
    await createNodeUpgradeTransactionFileAdapter({ workspaceRoot, allowlistedPaths: [allowlisted] }, checks);
  }
  for (const [workspaceRoot, allowlisted] of [
    [`${long}\\workspace`, `${long}\\workspace\\linked\\package-lock.json`],
    // The review's repro: a differently spelled prefix does not skip the link.
    [`${long}\\workspace`, `${long}\\WORKSPACE\\linked\\package-lock.json`],
    [`${long}\\workspace`, `${short}\\workspace\\linked\\package-lock.json`],
  ]) {
    await assert.rejects(
      createNodeUpgradeTransactionFileAdapter({ workspaceRoot, allowlistedPaths: [allowlisted] }, checks),
      { code: 'SYMLINK_NOT_ALLOWED' },
      allowlisted
    );
  }
  await assert.rejects(
    createNodeUpgradeTransactionFileAdapter({ workspaceRoot: `${long}\\workspace`, allowlistedPaths: [`${long}\\other\\package.json`] }, checks),
    { code: 'PATH_OUTSIDE_WORKSPACE' }
  );
});
