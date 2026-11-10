import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { readPnpmWorkspaceLayout } from '../out/host/pnpmWorkspaceLayout.js';

async function workspace(t, { yaml = "packages:\n  - 'apps/*'\n  - 'packages/*'\n", dirs = ['apps/api', 'apps/web', 'packages/shared'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-workspace-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (yaml !== null) await writeFile(path.join(root, 'pnpm-workspace.yaml'), yaml);
  await writeFile(path.join(root, 'package.json'), '{"name":"root"}');
  for (const dir of dirs) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify({ name: dir }));
  }
  await writeFile(path.join(root, '.pnpmfile.cjs'), 'module.exports = {};\n');
  return root;
}

const paths = (layout) => layout.files.map((file) => file.path).sort();
const workspaceFile = (layout) => JSON.parse(layout.files.find((file) => file.path === 'pnpm-workspace.yaml').text);

test('a workspace member gets the workspace file, the root manifest and the other members', async (t) => {
  const root = await workspace(t);
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.equal(layout.importerId, 'apps/web');
  assert.deepEqual(paths(layout), ['apps/api/package.json', 'package.json', 'packages/shared/package.json', 'pnpm-workspace.yaml']);
  assert.match(layout.fingerprint, /^[0-9a-f]{64}$/);
});

test('the workspace root importer gets every member manifest but not its own', async (t) => {
  const root = await workspace(t);
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: '.' });
  assert.deepEqual(paths(layout), ['apps/api/package.json', 'apps/web/package.json', 'packages/shared/package.json', 'pnpm-workspace.yaml']);
});

test('a single pnpm project without pnpm-workspace.yaml keeps the single-project layout', async (t) => {
  const root = await workspace(t, { yaml: null });
  assert.equal(await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: '.' }), undefined);
});

test('package patterns are copied as written, except ones that leave the workspace', async (t) => {
  const patterns = ['./apps/*/', 'packages/!(excluded)', 'packages/p{1..2}', 'libs/[ab]', '!apps/api', '../outside/*', '/abs/*', '!../x'];
  const root = await workspace(t, { yaml: `packages:\n${patterns.map((p) => `  - '${p}'`).join('\n')}\n` });
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.deepEqual(workspaceFile(layout).packages, patterns.slice(0, 5));
});

test('only resolution settings without paths reach the temporary project', async (t) => {
  const root = await workspace(t, {
    yaml: [
      'packages:',
      "  - 'apps/*'",
      'linkWorkspacePackages: true',
      'preferWorkspacePackages: true',
      'autoInstallPeers: false',
      'resolutionMode: time-based',
      'catalog:',
      '  react: 18.3.1',
      'overrides:',
      '  semver: 7.6.0',
      'lockfileDir: /somewhere/else',
      'storeDir: /somewhere/store',
      'virtualStoreDir: ../vstore',
      'modulesDir: ../mods',
      'pnpmfile: ./hooks.cjs',
      'globalPnpmfile: /g.cjs',
      'patchedDependencies:',
      '  jose: patches/jose.patch',
      '',
    ].join('\n'),
  });
  await writeFile(path.join(root, '.npmrc'), [
    'link-workspace-packages=true',
    'auto-install-peers=true',
    '//registry.npmjs.org/:_authToken=secret',
    'registry=https://private.example/',
    'store-dir=/somewhere/store',
    'lockfile-dir=/somewhere/else',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'root', pnpm: { overrides: { a: '1.0.0' }, patchedDependencies: { b: 'p.patch' } },
  }));
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.deepEqual(workspaceFile(layout), {
    packages: ['apps/*'],
    overrides: { semver: '7.6.0' },
    catalog: { react: '18.3.1' },
    linkWorkspacePackages: true,
    preferWorkspacePackages: true,
    resolutionMode: 'time-based',
    autoInstallPeers: false,
  });
  assert.equal(layout.files.find((file) => file.path === '.npmrc').text, 'link-workspace-packages=true\nauto-install-peers=true\n');
  assert.deepEqual(JSON.parse(layout.files.find((file) => file.path === 'package.json').text).pnpm, { overrides: { a: '1.0.0' } });
  assert.ok(!layout.files.some((file) => /pnpmfile/.test(file.path)));
});

test('every manifest a pattern could match is staged, and pnpm decides membership', async (t) => {
  const root = await workspace(t, {
    yaml: "packages:\n  - 'packages/!(excluded)'\n  - 'packages/p{1..2}'\n  - 'libs/[ab]'\n  - 'apps/web'\n  - 'tools/**'\n",
    dirs: ['apps/web', 'apps/old', 'packages/excluded', 'packages/p1', 'packages/p2', 'libs/a', 'libs/b',
      'tools/one/two', 'packages/node_modules/skip', 'packages/.hidden', 'assets/icon'],
  });
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.deepEqual(paths(layout), [
    'libs/a/package.json', 'libs/b/package.json', 'package.json',
    'packages/excluded/package.json', 'packages/p1/package.json', 'packages/p2/package.json',
    'pnpm-workspace.yaml', 'tools/one/two/package.json',
  ]);
});

test('the candidate walk follows each pattern prefix and stops at its depth', async (t) => {
  const assets = Array.from({ length: 50 }, (_, index) => `assets/a${index}/deep`);
  const root = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n", dirs: ['apps/web', 'apps/api/nested', ...assets] });
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.deepEqual(paths(layout), ['package.json', 'pnpm-workspace.yaml']);
});

test('a cancelled discovery returns no layout', async (t) => {
  const root = await workspace(t);
  const abort = new AbortController();
  abort.abort();
  assert.equal(await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', signal: abort.signal }), undefined);
});

test('the fingerprint changes when a staged file changes', async (t) => {
  const root = await workspace(t);
  const before = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).fingerprint, before.fingerprint);
  await writeFile(path.join(root, 'packages/shared/package.json'), '{"name":"shared","version":"2.0.0"}');
  const sibling = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.notEqual(sibling.fingerprint, before.fingerprint);
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  assert.notEqual((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).fingerprint, sibling.fingerprint);
});

test('top-level !(...) extglobs match members rather than exclude them', async (t) => {
  const root = await workspace(t, {
    yaml: "packages:\n  - '!(excluded)'\n  - '!(skip)/*'\n",
    dirs: ['web', 'excluded', 'group/inner'],
  });
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'web' });
  assert.deepEqual(workspaceFile(layout).packages, ['!(excluded)', '!(skip)/*']);
  assert.deepEqual(paths(layout), ['excluded/package.json', 'group/inner/package.json', 'package.json', 'pnpm-workspace.yaml']);
  assert.equal(layout.unavailableReason, undefined);
});

test('settings or manifests that point at local paths outside the workspace make the layout unavailable', async (t) => {
  const contained = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - 'packages/*'\noverrides:\n  foo: link:./packages/shared\n" });
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: contained, importerId: 'apps/web' })).unavailableReason, undefined);

  for (const yaml of [
    "packages:\n  - 'apps/*'\noverrides:\n  foo: link:/outside\n",
    "packages:\n  - 'apps/*'\ncatalog:\n  foo: file:../outside\n",
    "packages:\n  - 'apps/*'\npackageExtensions:\n  bar:\n    dependencies:\n      foo: ~/outside\n",
  ]) {
    const root = await workspace(t, { yaml });
    assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason, /outside the workspace/);
  }

  const sibling = await workspace(t);
  await writeFile(path.join(sibling, 'packages/shared/package.json'), JSON.stringify({ name: 'shared', dependencies: { x: 'file:../../../outside' } }));
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: sibling, importerId: 'apps/web' })).unavailableReason, /packages\/shared\/package.json/);
});

test('symlinks that leave the workspace are not followed and make the layout unavailable', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const outside = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(outside, 'secret'), { recursive: true });
  await writeFile(path.join(outside, 'secret/package.json'), '{"name":"secret"}');

  const linkedPrefix = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - 'linked/*'\n" });
  await symlink(outside, path.join(linkedPrefix, 'linked'));
  const prefixLayout = await readPnpmWorkspaceLayout({ lockfileRoot: linkedPrefix, importerId: 'apps/web' });
  assert.ok(!paths(prefixLayout).some((file) => file.startsWith('linked/')));
  assert.match(prefixLayout.unavailableReason, /directory resolves outside the workspace/);

  const linkedManifest = await workspace(t);
  await rm(path.join(linkedManifest, 'packages/shared/package.json'));
  await symlink(path.join(outside, 'secret/package.json'), path.join(linkedManifest, 'packages/shared/package.json'));
  const manifestLayout = await readPnpmWorkspaceLayout({ lockfileRoot: linkedManifest, importerId: 'apps/web' });
  assert.ok(!paths(manifestLayout).includes('packages/shared/package.json'));
  assert.match(manifestLayout.unavailableReason, /resolves outside the workspace/);
});

test('a discovery cut short by its limits makes the layout unavailable', async (t) => {
  const many = Array.from({ length: 501 }, (_, index) => `packages/p${index}`);
  const wide = await workspace(t, { dirs: ['apps/web', ...many] });
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: wide, importerId: 'apps/web' })).unavailableReason, /more packages/);

  const deep = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - 'tools/**'\n", dirs: ['apps/web', 'tools/1/2/3/4/5/6/7'] });
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: deep, importerId: 'apps/web' })).unavailableReason, /more packages/);

  const fits = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - 'tools/**'\n", dirs: ['apps/web', 'tools/1/2'] });
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: fits, importerId: 'apps/web' })).unavailableReason, undefined);
});

test('every local specifier form is checked for containment, and ordinary ranges are not', async (t) => {
  for (const spec of ['workspace:../../../outside', '../../../outside.tgz', 'file:../../../x.tar.gz', 'C:\\outside', 'link:~/outside']) {
    const root = await workspace(t);
    await writeFile(path.join(root, 'packages/shared/package.json'), JSON.stringify({ name: 'shared', dependencies: { x: spec } }));
    const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
    assert.match(layout.unavailableReason ?? '', /outside the workspace/, spec);
  }
  const root = await workspace(t);
  await writeFile(path.join(root, 'packages/shared/package.json'), JSON.stringify({
    name: 'shared',
    dependencies: { a: '~18.2.0', b: 'workspace:*', c: 'workspace:^', d: 'npm:foo@1', e: 'link:../../apps/web', f: 'https://x.example/p.tgz' },
  }));
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason, undefined);
});

test('a change that only affects availability still changes the fingerprint', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const outside = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const root = await workspace(t);
  const before = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  await symlink(outside, path.join(root, 'packages/escape'));
  const after = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.match(after.unavailableReason, /resolves outside the workspace/);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('depth truncation is reported whatever the pattern order', async (t) => {
  for (const order of [["tools/*/*/*/*/*/*", 'tools/**'], ['tools/**', 'tools/*/*/*/*/*/*']]) {
    const root = await workspace(t, {
      yaml: `packages:\n  - 'apps/*'\n${order.map((p) => `  - '${p}'`).join('\n')}\n`,
      dirs: ['apps/web', 'tools/1/2/3/4/5/6/7'],
    });
    assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason ?? '', /more packages/, order.join(' then '));
  }
});

test('an extglob group spanning directories is walked as deep as it can repeat', async (t) => {
  const root = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - 'tools/+(x/)pkg'\n", dirs: ['apps/web', 'tools/x/x/x/pkg'] });
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.ok(paths(layout).includes('tools/x/x/x/pkg/package.json'));
  assert.equal(layout.unavailableReason, undefined);
});

test('read and parse failures make the layout unavailable instead of dropping files', async (t) => {
  const badJson = await workspace(t);
  await writeFile(path.join(badJson, 'packages/shared/package.json'), '{ not json');
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: badJson, importerId: 'apps/web' })).unavailableReason, /packages\/shared\/package.json could not be parsed/);

  const badYaml = await workspace(t, { yaml: 'packages: [\n' });
  const yamlLayout = await readPnpmWorkspaceLayout({ lockfileRoot: badYaml, importerId: 'apps/web' });
  assert.match(yamlLayout.unavailableReason, /pnpm-workspace.yaml could not be parsed/);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const { chmod } = await import('node:fs/promises');
    const unreadable = await workspace(t);
    await chmod(path.join(unreadable, 'packages'), 0o000);
    const layout = await readPnpmWorkspaceLayout({ lockfileRoot: unreadable, importerId: 'apps/web' });
    await chmod(path.join(unreadable, 'packages'), 0o755);
    assert.match(layout.unavailableReason, /could not be read/);
  }
});

test('.npmrc values may be quoted or commented, and unsupported values make the layout unavailable', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, '.npmrc'), [
    'link-workspace-packages="true"',
    "auto-install-peers='false' ; comment",
    'dedupe-peer-dependents=true # comment',
    '; strict-peer-dependencies=true',
    '',
  ].join('\n'));
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.equal(layout.files.find((file) => file.path === '.npmrc').text,
    'link-workspace-packages=true\nauto-install-peers=false\ndedupe-peer-dependents=true\n');
  assert.equal(layout.unavailableReason, undefined);

  await writeFile(path.join(root, '.npmrc'), 'link-workspace-packages="true"\nauto-install-peers=true\n');
  assert.notEqual((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).fingerprint, layout.fingerprint);

  await writeFile(path.join(root, '.npmrc'), 'resolution-mode=${MODE}\n');
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason, /resolution-mode/);
});

test('an .npmrc that resolves outside the workspace makes the layout unavailable', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const outside = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'npmrc'), 'auto-install-peers=false\n');
  const root = await workspace(t);
  await symlink(path.join(outside, 'npmrc'), path.join(root, '.npmrc'));
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason, /\.npmrc resolves outside/);
});

test('local protocols are checked even without a leading dot', async (t) => {
  for (const spec of ['file:assets/../../../../outside', 'link:assets/../../../../outside', 'portal:/abs']) {
    const root = await workspace(t);
    await writeFile(path.join(root, 'packages/shared/package.json'), JSON.stringify({ name: 'shared', dependencies: { x: spec } }));
    assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason ?? '', /outside the workspace/, spec);
  }
  const root = await workspace(t);
  await writeFile(path.join(root, 'packages/shared/package.json'), JSON.stringify({ name: 'shared', dependencies: { x: 'file:vendor/x' } }));
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason, undefined);
});

test('the reviewed manifest is checked for member and root importers', async (t) => {
  const root = await workspace(t);
  const escaping = JSON.stringify({ name: 'web', dependencies: { x: 'file:/outside' } });
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', manifestText: escaping })).unavailableReason,
    /reviewed package.json/);
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: '.', manifestText: escaping })).unavailableReason,
    /reviewed package.json/);
  const fine = JSON.stringify({ name: 'web', dependencies: { shared: 'link:../../packages/shared' } });
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', manifestText: fine })).unavailableReason, undefined);
});

test('patched dependencies make the layout unavailable and their configuration is fingerprinted', async (t) => {
  const yamlPatch = await workspace(t, { yaml: "packages:\n  - 'apps/*'\npatchedDependencies:\n  jose@5.9.6: patches/jose.patch\n" });
  assert.match((await readPnpmWorkspaceLayout({ lockfileRoot: yamlPatch, importerId: 'apps/web' })).unavailableReason, /patches/);

  const root = await workspace(t);
  const manifest = (patchPath) => JSON.stringify({ name: 'root', pnpm: { patchedDependencies: { 'jose@5.9.6': patchPath } } });
  await writeFile(path.join(root, 'package.json'), manifest('patches/a.patch'));
  const first = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' });
  assert.match(first.unavailableReason, /patches/);
  await writeFile(path.join(root, 'package.json'), manifest('patches/b.patch'));
  assert.notEqual((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).fingerprint, first.fingerprint);
});

test('patterns that cannot be staged make the layout unavailable', async (t) => {
  for (const yaml of ["packages:\n  - 'apps/*'\n  - '../shared/*'\n", "packages:\n  - 'apps/*'\n  - '.hidden/shared'\n", 'catalog:\n  react: 18.3.1\n']) {
    const root = await workspace(t, { yaml });
    assert.ok((await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web' })).unavailableReason, yaml);
  }
  const negatedOutside = await workspace(t, { yaml: "packages:\n  - 'apps/*'\n  - '!../x'\n" });
  assert.equal((await readPnpmWorkspaceLayout({ lockfileRoot: negatedOutside, importerId: 'apps/web' })).unavailableReason, undefined);
});

test('a settings-only pnpm-workspace.yaml at a single project root keeps the single-project layout', async (t) => {
  const root = await workspace(t, { yaml: 'onlyBuiltDependencies:\n  - esbuild\n', dirs: [] });
  assert.equal(await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: '.' }), undefined);
});
