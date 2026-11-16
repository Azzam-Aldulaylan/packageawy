import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import io from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { readPnpmWorkspaceLayout } from '../out/host/pnpmWorkspaceLayout.js';

const YAML = "packages:\n  - 'apps/*'\n  - 'packages/**'\n";

async function workspace(t, { yaml = YAML, dirs = ['apps/api', 'apps/web', 'packages/shared'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-workspace-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (yaml !== null) await writeFile(path.join(root, 'pnpm-workspace.yaml'), yaml);
  await writeFile(path.join(root, 'package.json'), '{"name":"root"}');
  for (const dir of dirs) await writeManifest(root, dir, { name: dir });
  return root;
}

async function writeManifest(root, dir, manifest) {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(manifest));
}

async function outsideDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const read = (root, extra = {}) => readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', ...extra });
const paths = (layout) => layout.files.map((file) => file.path).sort();
const fileText = (layout, name) => layout.files.find((file) => file.path === name)?.text;

for (const operation of ['realpath', 'readdir', 'open', 'stat']) {
  test(`workspace ${operation} preserves graceful and strict filesystem error modes`, async t => {
    const root = await workspace(t);
    const realRoot = await io.realpath(root);
    if (operation === 'stat') await symlink(path.join(root, 'packages/shared'), path.join(root, 'linked'), 'dir');
    const original = io[operation];
    let error = Object.assign(new Error('unavailable'), { code: 'EMFILE' });
    // Fail within discovery too, so its outer cancellation catch cannot hide strict errors.
    const target = operation === 'realpath' ? path.join(realRoot, 'packages') : operation === 'open'
      ? path.join(realRoot, 'package.json') : operation === 'stat' ? path.join(realRoot, 'linked') : realRoot;
    io[operation] = async (file, ...args) => {
      if (file === target) throw error;
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    t.after(() => { io[operation] = original; syncBuiltinESMExports(); });
    const graceful = await read(root);
    if (operation !== 'stat') assert.match(graceful.unavailableReason, /could not be read/);
    await assert.rejects(read(root, { strict: true }), cause => cause === error);
    error = new TypeError('programming failure');
    for (const strict of [false, true]) await assert.rejects(read(root, { strict }), cause => cause === error);
  });
}

test('cancellation during the last workspace manifest read discards the layout', async t => {
  const root = await workspace(t, { dirs: ['apps/web'] });
  const realRoot = await io.realpath(root);
  const abort = new AbortController();
  const original = io.open;
  io.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (file === path.join(realRoot, 'package.json')) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        abort.abort();
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { io.open = original; syncBuiltinESMExports(); });
  assert.equal(await read(root, { signal: abort.signal }), undefined);
});

test('every manifest under the lock root is staged, hidden directories included', async (t) => {
  const root = await workspace(t, { dirs: ['apps/api', 'apps/web', 'packages/shared/.internal', 'packages/shared/node_modules/x', '.git/x'] });
  const layout = await read(root);
  assert.deepEqual(paths(layout), ['apps/api/package.json', 'package.json', 'packages/shared/.internal/package.json', 'pnpm-workspace.yaml']);
  assert.equal(fileText(layout, 'pnpm-workspace.yaml'), YAML);
  assert.equal(layout.unavailableReason, undefined);
  assert.match(layout.fingerprint, /^[0-9a-f]{64}$/);

  const rootLayout = await read(root, { importerId: '.' });
  assert.ok(paths(rootLayout).includes('apps/web/package.json'));
  assert.ok(!paths(rootLayout).includes('package.json'));
});

test('a project without a workspace, or with a settings-free workspace, keeps the single-project layout', async (t) => {
  assert.equal(await read(await workspace(t, { yaml: null }), { importerId: '.' }), undefined);
  for (const yaml of ['', '# empty workspace\n', '{}\n', 'packages: []\n', 'packages:\n']) {
    assert.equal(await read(await workspace(t, { yaml }), { importerId: '.' }), undefined);
  }
});

test('root-only workspace resolution settings are explicitly unavailable', async t => {
  for (const setting of ['catalog:\n  react: 19.0.0', 'catalogs:\n  stable:\n    react: 19.0.0',
    'overrides:\n  react: 19.0.0', 'patchedDependencies:\n  react@19.0.0: react.patch',
    'onlyBuiltDependencies:\n  - esbuild', 'autoInstallPeers: false', 'someFutureSetting: true']) {
    for (const packages of ['', 'packages: []\n']) {
      const root = await workspace(t, { yaml: `${packages}${setting}\n`, dirs: [] });
      assert.match((await read(root, { importerId: '.' }))?.unavailableReason ?? '', /workspace.*settings.*review does not stage/i, setting);
    }
  }
});

test('workspace byte budgets reject oversized files before reading their contents', async t => {
  for (const relative of ['pnpm-workspace.yaml', 'package.json', 'apps/web/package.json', '.npmrc', 'apps/web/.npmrc']) {
    const root = await workspace(t);
    // Multi-byte content ensures the budget is in bytes, not JS string length.
    await writeFile(path.join(root, relative), 'é'.repeat(524289));
    const target = await io.realpath(path.join(root, relative));
    const original = io.open;
    let loaded = false;
    io.open = async (file, ...args) => {
      const handle = await original(file, ...args);
      if (file === target) {
        const read = handle.read.bind(handle);
        handle.read = async (...args) => { loaded = true; return read(...args); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    let layout;
    try { layout = await read(root); }
    finally { io.open = original; syncBuiltinESMExports(); }
    assert.equal(loaded, false, `${relative} was loaded before enforcing its byte limit`);
    assert.match(layout.unavailableReason, /1 MiB/);
    assert.ok(!paths(layout).includes(relative));
  }
});

test('workspace aggregate byte budget stops manifest reads and directory discovery', async t => {
  const dirs = Array.from({ length: 20 }, (_, index) => `unmatched/p${String(index).padStart(2, '0')}`);
  const root = await workspace(t, { dirs });
  const text = JSON.stringify({ name: 'large', padding: 'x'.repeat(1024 * 1024 - 100) });
  for (const dir of dirs) await writeFile(path.join(root, dir, 'package.json'), text);
  const originalOpen = io.open;
  const originalReaddir = io.readdir;
  const visited = [];
  let bytesRead = 0;
  io.open = async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      const result = await read(...args);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  };
  io.readdir = async (file, ...args) => {
    visited.push(path.basename(file));
    return originalReaddir(file, ...args);
  };
  syncBuiltinESMExports();
  let layout;
  try { layout = await read(root, { importerId: '.' }); }
  finally { io.open = originalOpen; io.readdir = originalReaddir; syncBuiltinESMExports(); }
  assert.ok(bytesRead <= 16 * 1024 * 1024, `loaded ${bytesRead} bytes`);
  assert.match(layout.unavailableReason, /16 MiB/);
  assert.ok(!visited.includes('p19'), 'discovery continued after the budget was exhausted');
});

test('the reviewed in-memory manifest also consumes the workspace byte budget', async t => {
  const root = await workspace(t);
  const manifestText = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
  assert.match((await read(root, { manifestText })).unavailableReason ?? '', /1 MiB/);
});

test('supported settings are staged verbatim and fingerprinted, anything else is unknown', async (t) => {
  const yaml = `${YAML}linkWorkspacePackages: true\nignoreCompatibilityDb: true\ncatalog:\n  react: 18.3.1\n`;
  const root = await workspace(t, { yaml });
  const layout = await read(root);
  assert.equal(fileText(layout, 'pnpm-workspace.yaml'), yaml);
  assert.equal(layout.unavailableReason, undefined);
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), yaml.replace('ignoreCompatibilityDb: true', 'ignoreCompatibilityDb: false'));
  assert.notEqual((await read(root)).fingerprint, layout.fingerprint);

  for (const setting of ['lockfileDir: /elsewhere', 'patchedDependencies:\n  a@1.0.0: p.patch', 'pnpmfile: hooks.cjs', 'someFutureSetting: 1']) {
    const other = await workspace(t, { yaml: `${YAML}${setting}\n` });
    assert.match((await read(other)).unavailableReason, /pnpm-workspace.yaml sets \w+, which the review does not stage/, setting);
  }
});

test('.npmrc keeps supported lines verbatim, leaves registries to the host and rejects the rest', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, '.npmrc'), 'auto-install-peers = "true" ; note\nregistry=https://r.example/\n//r.example/:_authToken=secret\n@a:registry=https://a.example/\n');
  const layout = await read(root);
  assert.equal(fileText(layout, '.npmrc'), 'auto-install-peers = "true" ; note\n');
  assert.equal(layout.unavailableReason, undefined);
  await writeFile(path.join(root, '.npmrc'), 'auto-install-peers=false\n');
  assert.notEqual((await read(root)).fingerprint, layout.fingerprint);
  await writeFile(path.join(root, '.npmrc'), 'store-dir=/elsewhere\n');
  assert.match((await read(root)).unavailableReason, /\.npmrc sets store-dir/);

  const outside = await outsideDir(t);
  await writeFile(path.join(outside, 'npmrc'), 'auto-install-peers=false\n');
  const linked = await workspace(t);
  await symlink(path.join(outside, 'npmrc'), path.join(linked, '.npmrc'));
  assert.match((await read(linked)).unavailableReason, /\.npmrc resolves outside/);
});

test('manifest pnpm fields outside the supported set, such as patches, are unknown', async (t) => {
  const root = await workspace(t);
  await writeManifest(root, '.', { name: 'root', pnpm: { overrides: { a: '1.0.0' } } });
  assert.equal((await read(root)).unavailableReason, undefined);
  await writeManifest(root, '.', { name: 'root', pnpm: { patchedDependencies: { 'a@1.0.0': 'p.patch' } } });
  assert.match((await read(root)).unavailableReason, /pnpm.patchedDependencies/);
});

test('local specifiers are classified like pnpm and must stay inside the workspace', async (t) => {
  const outside = ['assets/../../../../outside', 'file:assets/../../../../outside', 'link:/outside', 'workspace:../../../outside',
    '../../../outside.tgz', 'C:\\outside', '~/outside', 'git+file:///outside', 'portal:../../../outside'];
  for (const spec of outside) {
    const root = await workspace(t);
    await writeManifest(root, 'packages/shared', { name: 'shared', dependencies: { x: spec } });
    assert.match((await read(root)).unavailableReason ?? '', /packages\/shared\/package.json points at a local path outside/, spec);
  }
  const inside = ['~18.2.0', 'workspace:*', 'workspace:^', 'npm:foo@1', 'user/repo', 'https://x.example/p.tgz',
    'link:../../apps/web', 'file:vendor/x', 'vendor/x/y'];
  const root = await workspace(t);
  await writeManifest(root, 'packages/shared', { name: 'shared', dependencies: Object.fromEntries(inside.map((spec, i) => [`d${i}`, spec])) });
  assert.equal((await read(root)).unavailableReason, undefined);

  const escaping = JSON.stringify({ name: 'web', dependencies: { x: 'assets/../../../../outside' } });
  assert.match((await read(root, { manifestText: escaping })).unavailableReason, /reviewed package.json/);
  const override = await workspace(t, { yaml: `${YAML}overrides:\n  foo: assets/../../outside\n` });
  assert.match((await read(override)).unavailableReason, /workspace setting points at a local path/);
});

test('package patterns that leave the workspace are unknown, in every brace expansion', async (t) => {
  const fine = await workspace(t, { yaml: "packages:\n  - '{apps,packages}/*'\n  - 'packages/p{1..2}'\n" });
  assert.equal((await read(fine)).unavailableReason, undefined);
  for (const pattern of ['../shared/*', '/abs/*', '!../x', '{.,.}{.,.}/outside/*', '{/,packages/}*', '{a,{b,../c}}/*', '{-..0}{-..0}/outside', '{-..0}git/*', '{a..z}/*', '.\\./*', 'apps/\\*', '+(..)/*']) {
    const root = await workspace(t, { yaml: `packages:\n  - 'apps/*'\n  - '${pattern}'\n` });
    assert.match((await read(root)).unavailableReason, /pattern points outside/, pattern);
  }
});

test('symlinks are followed inside the workspace, but aliases and escapes are unknown', async (t) => {
  const aliased = await workspace(t);
  await symlink(path.join(aliased, 'packages/shared'), path.join(aliased, 'packages/aaa'));
  assert.match((await read(aliased)).unavailableReason, /second path to a directory/);

  const narrowed = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - 'packages/shared'\n" });
  await symlink(path.join(narrowed, 'packages/shared'), path.join(narrowed, 'packages/aaa'));
  const layout = await read(narrowed);
  assert.match(layout.unavailableReason, /second path to a directory/);

  const root = await workspace(t);

  const outside = await outsideDir(t);
  await writeManifest(outside, 'secret', { name: 'secret' });
  const before = await read(root);
  await symlink(outside, path.join(root, 'packages/escape'));
  const after = await read(root);
  assert.match(after.unavailableReason, /resolves outside the workspace/);
  assert.ok(!paths(after).some((file) => file.startsWith('packages/escape')));
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('limits, read failures and parse failures are unknown, and cancellation gives no layout', async (t) => {
  const deep = await workspace(t, { dirs: ['apps/web', `packages/${Array.from({ length: 17 }, (_, i) => `d${i}`).join('/')}`] });
  assert.match((await read(deep)).unavailableReason, /more directories/);

  const badJson = await workspace(t);
  await writeFile(path.join(badJson, 'packages/shared/package.json'), '{ not json');
  assert.match((await read(badJson)).unavailableReason, /packages\/shared\/package.json could not be parsed/);
  assert.match((await read(await workspace(t, { yaml: 'packages: [\n' }))).unavailableReason, /could not be parsed/);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const unreadable = await workspace(t);
    await chmod(path.join(unreadable, 'packages'), 0o000);
    const layout = await read(unreadable);
    await chmod(path.join(unreadable, 'packages'), 0o755);
    assert.match(layout.unavailableReason, /packages could not be read/);
  }

  const abort = new AbortController();
  abort.abort();
  assert.equal(await read(await workspace(t), { signal: abort.signal }), undefined);
});

test('editing any staged manifest changes the fingerprint', async (t) => {
  const root = await workspace(t, { dirs: ['apps/web', 'packages/shared/.internal'] });
  const before = await read(root);
  await writeManifest(root, 'packages/shared/.internal', { name: 'internal', version: '2.0.0' });
  assert.notEqual((await read(root)).fingerprint, before.fingerprint);
});

test('default pnpmfiles and other manifest formats are unknown and fingerprinted', async (t) => {
  const root = await workspace(t);
  const before = await read(root);
  await writeFile(path.join(root, '.pnpmfile.cjs'), 'module.exports = { hooks: {} };\n');
  const withHooks = await read(root);
  assert.match(withHooks.unavailableReason, /\.pnpmfile\.cjs/);
  assert.notEqual(withHooks.fingerprint, before.fingerprint);
  assert.ok(!paths(withHooks).includes('.pnpmfile.cjs'));

  const yamlManifest = await workspace(t);
  await mkdir(path.join(yamlManifest, 'packages/other'), { recursive: true });
  await writeFile(path.join(yamlManifest, 'packages/other/package.yaml'), 'name: other\n');
  assert.match((await read(yamlManifest)).unavailableReason, /packages\/other\/package.yaml is a manifest format/);
});

test('the reviewed member .npmrc is unknown and fingerprinted', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'apps/web/.npmrc'), 'link-workspace-packages=true\n');
  const first = await read(root);
  assert.match(first.unavailableReason, /apps\/web\/\.npmrc/);
  await writeFile(path.join(root, 'apps/web/.npmrc'), 'link-workspace-packages=false\n');
  assert.notEqual((await read(root)).fingerprint, first.fingerprint);
});

test('member .npmrc credentials never enter the user-facing reasons array', async t => {
  const root = await workspace(t);
  const secret = 'npm_memberPrivateToken';
  await writeFile(path.join(root, 'apps/web/.npmrc'), `//registry.example/:_authToken=${secret}\n`);
  const original = Array.prototype.push;
  let queuedSecret = false;
  Array.prototype.push = function (...values) {
    if (values.some(value => typeof value === 'string' && value.includes(secret))) queuedSecret = true;
    return original.apply(this, values);
  };
  let first;
  try { first = await read(root); }
  finally { Array.prototype.push = original; }
  assert.equal(queuedSecret, false, 'credential contents were queued as user-facing reasons');
  assert.equal(first.unavailableReason, 'apps/web/.npmrc sets project settings the review does not stage.');
  assert.ok(!JSON.stringify(first).includes(secret));
  await writeFile(path.join(root, 'apps/web/.npmrc'), '//registry.example/:_authToken=npm_changedToken\n');
  assert.notEqual((await read(root)).fingerprint, first.fingerprint);
});

test('contained file symlinks, including a linked manifest, keep the layout available', async (t) => {
  const root = await workspace(t, { dirs: ['apps/web', 'shared-src'] });
  await writeFile(path.join(root, 'LICENSE'), 'MIT\n');
  await symlink(path.join(root, 'LICENSE'), path.join(root, 'apps/web/LICENSE'));
  await mkdir(path.join(root, 'packages/linked'), { recursive: true });
  await symlink(path.join(root, 'shared-src/package.json'), path.join(root, 'packages/linked/package.json'));
  const layout = await read(root);
  assert.equal(layout.unavailableReason, undefined);
  assert.ok(paths(layout).includes('packages/linked/package.json'));
});

test('a bare CR in .npmrc separates lines, and protocols are matched in any case', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, '.npmrc'), 'auto-install-peers=true\rlockfile-dir=/outside\n');
  assert.match((await read(root)).unavailableReason, /\.npmrc sets lockfile-dir/);

  for (const spec of ['GIT+FILE:///private/external', 'File:/outside', 'LINK:../../../outside']) {
    const sibling = await workspace(t);
    await writeManifest(sibling, 'packages/shared', { name: 'shared', dependencies: { x: spec } });
    assert.match((await read(sibling)).unavailableReason ?? '', /points at a local path outside/, spec);
    const reviewed = JSON.stringify({ name: 'web', dependencies: { x: spec } });
    assert.match((await read(await workspace(t), { manifestText: reviewed })).unavailableReason ?? '', /reviewed package.json/, spec);
    const setting = await workspace(t, { yaml: `${YAML}overrides:\n  foo: '${spec}'\n` });
    assert.match((await read(setting)).unavailableReason ?? '', /workspace setting points at a local path/, spec);
  }
});

test('a package pattern that can select a directory inside .git is unknown', async (t) => {
  for (const pattern of ['.git/*', '.GIT/hidden', '.{git,other}/*', '.g*/*', 'apps/.git/x', '@(.git)/*', '[.]git/*', '!(x)/*']) {
    const root = await workspace(t, { yaml: `packages:\n  - 'apps/*'\n  - '${pattern}'\n` });
    assert.match((await read(root)).unavailableReason, /inside \.git|pattern points outside/, pattern);
  }
  for (const pattern of ['apps/*', 'packages/**', '.internal/*', '!.git/*']) {
    const root = await workspace(t, { yaml: `packages:\n  - 'apps/*'\n  - '${pattern}'\n` });
    assert.equal((await read(root)).unavailableReason, undefined, pattern);
  }
});

test('root resolutions and overrides that point outside the workspace are unknown', async (t) => {
  const outside = await outsideDir(t);
  for (const field of ['resolutions', 'overrides']) {
    for (const spec of [`file:${outside}`, 'link:../../outside', '../outside']) {
      const root = await workspace(t);
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', [field]: { 'is-number': spec } }));
      assert.match((await read(root)).unavailableReason, /points at a local path outside the workspace/, `${field} ${spec}`);
    }
  }
});

// Race both the legacy path stat and the checked handle stat, so these
// regressions exercise the same interleaving before and after the fix.
async function afterFileStat(t, target, change) {
  const originals = { stat: io.stat, open: io.open };
  let changed = false;
  const mutate = async () => {
    if (!changed) { changed = true; await change(); }
  };
  io.stat = async (file, ...args) => {
    const info = await originals.stat(file, ...args);
    if (file === target) await mutate();
    return info;
  };
  io.open = async (file, ...args) => {
    const handle = await originals.open(file, ...args);
    if (file === target) {
      const stat = handle.stat.bind(handle);
      handle.stat = async (...args) => {
        const info = await stat(...args);
        await mutate();
        return info;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(io, originals); syncBuiltinESMExports(); });
  return () => changed;
}

test('a manifest swapped for an outside symlink after its size check is never staged', async t => {
  const root = await workspace(t);
  const target = await io.realpath(path.join(root, 'packages/shared/package.json'));
  const outside = await outsideDir(t);
  const secret = JSON.stringify({ private: 'outside-secret', padding: 'x'.repeat(8 * 1024 * 1024) });
  await writeFile(path.join(outside, 'secret.json'), secret);
  const changed = await afterFileStat(t, target, async () => {
    await rm(target);
    await symlink(path.join(outside, 'secret.json'), target);
  });
  const layout = await read(root, { strict: true });
  assert.ok(changed());
  assert.ok(!JSON.stringify(layout).includes('outside-secret'));
});

test('a manifest growing after fstat is bounded to one MiB plus a sentinel byte', async t => {
  const root = await workspace(t);
  const target = await io.realpath(path.join(root, 'packages/shared/package.json'));
  const changed = await afterFileStat(t, target, () => writeFile(target,
    JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) })));
  // Count both the old whole-file read and the new handle reads.
  const originals = { readFile: io.readFile, open: io.open };
  let bytes = 0;
  let closed = false;
  io.readFile = async (file, ...args) => {
    const value = await originals.readFile(file, ...args);
    if (file === target) bytes += Buffer.byteLength(value);
    return value;
  };
  io.open = async (file, ...args) => {
    const handle = await originals.open(file, ...args);
    if (file === target) {
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        bytes += result.bytesRead;
        return result;
      };
      handle.close = async () => { closed = true; return close(); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(io, originals); syncBuiltinESMExports(); });
  const layout = await read(root);
  assert.ok(changed());
  assert.ok(bytes <= 1024 * 1024 + 1, `read ${bytes} bytes`);
  assert.match(layout.unavailableReason ?? '', /1 MiB/);
  assert.ok(!paths(layout).includes('packages/shared/package.json'));
  assert.ok(closed, 'the rejected file handle was not closed');
});

test('missing reviewed manifests are unavailable even with valid supplied text', async t => {
  for (const [importerId, yaml] of [['.', YAML], ['apps/web', YAML], ['.', 'packages: []\n']]) {
    const root = await workspace(t, { yaml });
    await rm(path.join(root, importerId, 'package.json'));
    const layout = await read(root, { importerId, manifestText: '{"name":"reviewed"}' });
    assert.match(layout?.unavailableReason ?? '', /reviewed package.json.*(?:missing|could not be read)/i);
  }
});

test('supplied reviewed text is size checked even when its disk manifest disappeared', async t => {
  const root = await workspace(t);
  await rm(path.join(root, 'apps/web/package.json'));
  const layout = await read(root, { manifestText: JSON.stringify({ padding: 'é'.repeat(4 * 1024 * 1024) }) });
  assert.match(layout.unavailableReason ?? '', /1 MiB/);
});

test('supplied reviewed text is validated even when discovery cannot find the manifest', async t => {
  for (const manifestText of ['{invalid', '{"pnpm":{"patchedDependencies":{}}}',
    '{"dependencies":{"x":"file:../../../private"}}']) {
    const root = await workspace(t);
    await rm(path.join(root, 'apps/web/package.json'));
    const layout = await read(root, { manifestText });
    assert.match(layout.unavailableReason ?? '', /reviewed package.json.*(?:parsed|pnpm|outside)/i);
  }
});

test('aggregate accounting charges bytes read after a file shrinks, rather than its stale size', async t => {
  const dirs = Array.from({ length: 20 }, (_, index) => `packages/p${index}`);
  const root = await workspace(t, { dirs: ['apps/web', ...dirs] });
  const originals = { stat: io.stat, open: io.open };
  // Deterministically shrink each file immediately after its size is sampled.
  const shrunk = new Set();
  const shrink = async (file, info) => {
    if (file.endsWith('/package.json') && !shrunk.has(file)) {
      shrunk.add(file);
      info.size = 1024 * 1024;
      await writeFile(file, '{}');
    }
    return info;
  };
  io.stat = async (file, ...args) => shrink(file, await originals.stat(file, ...args));
  io.open = async (file, ...args) => {
    const handle = await originals.open(file, ...args);
    const stat = handle.stat.bind(handle);
    handle.stat = async (...args) => shrink(file, await stat(...args));
    // Exercise partial reads as well as the final EOF.
    const read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 3), position);
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(io, originals); syncBuiltinESMExports(); });
  const layout = await read(root);
  assert.equal(layout.unavailableReason, undefined);
  assert.equal(paths(layout).filter(file => file.endsWith('package.json')).length, dirs.length + 1);
  assert.equal(fileText(layout, `${dirs[19]}/package.json`), '{}');
});

test('the supplied reviewed snapshot consumes aggregate budget even when discovery skips its directory', async t => {
  const dirs = Array.from({ length: 16 }, (_, i) => `packages/p${String(i).padStart(2, '0')}`);
  const root = await workspace(t, { dirs: ['node_modules/reviewed', ...dirs] });
  const text = JSON.stringify({ padding: 'x'.repeat(1024 * 1024 - 100) });
  for (const dir of dirs) await writeFile(path.join(root, dir, 'package.json'), text);
  const layout = await read(root, { importerId: 'node_modules/reviewed', manifestText: text });
  assert.match(layout.unavailableReason ?? '', /16 MiB/);
  assert.ok(!paths(layout).includes(`${dirs[15]}/package.json`));
});

for (const operation of ['stat', 'read']) {
  test(`workspace handle ${operation} closes on failure and preserves strict error policy`, async t => {
    const root = await workspace(t);
    const target = await io.realpath(path.join(root, 'packages/shared/package.json'));
    const original = io.open;
    let opened = 0;
    let closed = 0;
    let error = Object.assign(new Error('unavailable'), { code: 'EMFILE' });
    io.open = async (file, ...args) => {
      const handle = await original(file, ...args);
      if (file === target) {
        opened++;
        handle[operation] = async () => { throw error; };
        const close = handle.close.bind(handle);
        handle.close = async () => { closed++; return close(); };
      }
      return handle;
    };
    syncBuiltinESMExports();
    t.after(() => { io.open = original; syncBuiltinESMExports(); });
    assert.match((await read(root)).unavailableReason, /could not be read/);
    await assert.rejects(read(root, { strict: true }), cause => cause === error);
    error = new TypeError('programming failure');
    for (const strict of [false, true]) await assert.rejects(read(root, { strict }), cause => cause === error);
    assert.equal(opened, 4);
    assert.equal(closed, opened);
  });
}
