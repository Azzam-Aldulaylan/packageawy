import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { readPnpmWorkspaceLayout } from '../out/host/pnpmWorkspaceLayout.js';

const lockfileText = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .: {}',
  '  apps/api: {}',
  '  apps/web: {}',
  '  packages/shared: {}',
  '  ../outside: {}',
  '',
].join('\n');

async function fixture(t, { workspaceYaml = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-workspace-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (workspaceYaml) await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  await writeFile(path.join(root, 'package.json'), '{"name":"root"}');
  for (const dir of ['apps/api', 'apps/web', 'packages/shared']) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify({ name: dir }));
  }
  await writeFile(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
  await writeFile(path.join(root, '.pnpmfile.cjs'), 'module.exports = {};\n');
  return root;
}

test('a workspace member gets pnpm-workspace.yaml and every other workspace manifest', async (t) => {
  const root = await fixture(t);
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', lockfileText });
  assert.equal(layout.importerId, 'apps/web');
  assert.deepEqual(layout.files.map((file) => file.path).sort(), [
    'apps/api/package.json', 'package.json', 'packages/shared/package.json', 'pnpm-workspace.yaml',
  ]);
  assert.equal(layout.files.find((file) => file.path === 'package.json').text, '{"name":"root"}');
  assert.ok(!layout.files.some((file) => /npmrc|pnpmfile|outside/.test(file.path)));
});

test('the workspace root importer gets every member manifest but not its own', async (t) => {
  const root = await fixture(t);
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: '.', lockfileText });
  assert.deepEqual(layout.files.map((file) => file.path).sort(), [
    'apps/api/package.json', 'apps/web/package.json', 'packages/shared/package.json', 'pnpm-workspace.yaml',
  ]);
});

test('a single pnpm project without pnpm-workspace.yaml keeps the single-project layout', async (t) => {
  const root = await fixture(t, { workspaceYaml: false });
  assert.equal(await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: '.', lockfileText }), undefined);
});

test('only resolution settings from pnpm-workspace.yaml reach the temporary project', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - 'apps/*'",
    "  - '../outside/*'",
    "  - '/abs/*'",
    "  - '!apps/api'",
    'lockfileDir: /somewhere/else',
    'storeDir: /somewhere/store',
    'pnpmfile: ./hooks.cjs',
    'patchedDependencies:',
    '  jose: patches/jose.patch',
    'catalog:',
    '  react: 18.3.1',
    'overrides:',
    '  semver: 7.6.0',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'root', pnpm: { overrides: { a: '1.0.0' }, patchedDependencies: { b: 'p.patch' } },
  }));
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', lockfileText });
  const workspace = JSON.parse(layout.files.find((file) => file.path === 'pnpm-workspace.yaml').text);
  assert.deepEqual(workspace, {
    packages: ['apps/web', 'packages/shared'],
    catalog: { react: '18.3.1' },
    overrides: { semver: '7.6.0' },
  });
  const rootManifest = JSON.parse(layout.files.find((file) => file.path === 'package.json').text);
  assert.deepEqual(rootManifest.pnpm, { overrides: { a: '1.0.0' } });
});

test('workspace members missing from the lockfile are found from the workspace patterns', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/**'\n");
  for (const dir of ['packages/new', 'packages/nested/deep', 'packages/node_modules/skip', 'tools/other']) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify({ name: dir }));
  }
  const layout = await readPnpmWorkspaceLayout({
    lockfileRoot: root, importerId: 'apps/web', lockfileText: "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/web: {}\n",
  });
  assert.deepEqual(layout.files.map((file) => file.path).filter((file) => file !== 'pnpm-workspace.yaml').sort(), [
    'apps/api/package.json', 'package.json', 'packages/nested/deep/package.json',
    'packages/new/package.json', 'packages/shared/package.json',
  ]);
});

test('./ prefixes, trailing slashes and brace patterns still find members, and members are listed by path', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - './apps/*/'\n  - '{packages,tools}/*'\n");
  await mkdir(path.join(root, 'tools/cli'), { recursive: true });
  await writeFile(path.join(root, 'tools/cli/package.json'), '{"name":"cli"}');
  const layout = await readPnpmWorkspaceLayout({
    lockfileRoot: root, importerId: 'apps/web', lockfileText: "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  });
  const workspace = JSON.parse(layout.files.find((file) => file.path === 'pnpm-workspace.yaml').text);
  assert.deepEqual([...workspace.packages].sort(), ['apps/api', 'apps/web', 'packages/shared', 'tools/cli']);
});

test('character classes find unlocked members and exclusions drop stale importers', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/[ab]'\n  - '!apps/api'\n");
  for (const dir of ['packages/a', 'packages/b', 'packages/c']) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify({ name: dir }));
  }
  const layout = await readPnpmWorkspaceLayout({ lockfileRoot: root, importerId: 'apps/web', lockfileText });
  const workspace = JSON.parse(layout.files.find((file) => file.path === 'pnpm-workspace.yaml').text);
  assert.deepEqual([...workspace.packages].sort(), ['apps/web', 'packages/a', 'packages/b', 'packages/shared']);
  assert.ok(!layout.files.some((file) => file.path === 'apps/api/package.json'));
});
