import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

test('a project without a workspace, or with root settings only, keeps the single-project layout', async (t) => {
  assert.equal(await read(await workspace(t, { yaml: null }), { importerId: '.' }), undefined);
  assert.equal(await read(await workspace(t, { yaml: 'onlyBuiltDependencies:\n  - esbuild\n' }), { importerId: '.' }), undefined);
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
