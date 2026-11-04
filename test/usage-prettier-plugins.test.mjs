/**
 * Prettier 2 loads installed Prettier plugins on its own, so they count as
 * used there and nowhere else: src/core/usage/prettierPlugins.ts, and the
 * "likely unused" finding built from that evidence (unused.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import {
  isPrettierAutoLoadedPluginName,
  prettierAutoLoadReference,
  prettierMajorFrom,
  projectPrettierMajor,
} from '../out/core/usage/prettierPlugins.js';
import { buildUnusedFinding } from '../out/core/usage/unused.js';

function usage(packageName, references = []) {
  return { packageName, references, truncated: false, scannedFileCount: 10, scannedAt: '2026-08-01T00:00:00.000Z' };
}

/** What the usage analyzer produces for a package with no other references. */
function findingWithPrettier(packageName, prettierMajor) {
  const reference = prettierAutoLoadReference(packageName, prettierMajor);
  return buildUnusedFinding(packageName, usage(packageName, reference === null ? [] : [reference]));
}

function npmProject(devDependencies, installed) {
  const manifestText = JSON.stringify({ name: 'app', version: '1.0.0', devDependencies });
  const packages = { '': { name: 'app', version: '1.0.0', devDependencies } };
  for (const [name, version] of Object.entries(installed)) {
    packages[`node_modules/${name}`] = { version, dev: true };
  }
  const manifest = parseManifest(manifestText);
  const graph = buildDependencyGraph({
    root: '/workspace/app',
    manifest,
    lockfileText: JSON.stringify({ name: 'app', lockfileVersion: 3, packages }),
    packageManager: 'npm',
  });
  return { graph, manifest };
}

test('on Prettier 2 an unreferenced prettier-plugin-* package counts as used', () => {
  const { graph, manifest } = npmProject(
    { prettier: '^2.8.0', 'prettier-plugin-tailwindcss': '^0.4.1' },
    { prettier: '2.8.8', 'prettier-plugin-tailwindcss': '0.4.1' }
  );
  const major = projectPrettierMajor(graph, manifest);
  assert.equal(major, 2);

  const reference = prettierAutoLoadReference('prettier-plugin-tailwindcss', major);
  assert.deepEqual(reference, {
    filePath: 'package.json',
    line: 0,
    column: 0,
    snippet: 'Loaded automatically by Prettier 2',
    kind: 'config',
    context: 'Prettier 2',
  });
  assert.equal(findingWithPrettier('prettier-plugin-tailwindcss', major), null);
});

test('on Prettier 3 a plugin without a config reference is still reported', () => {
  const { graph, manifest } = npmProject(
    { prettier: '^3.0.0', 'prettier-plugin-tailwindcss': '^0.5.0' },
    { prettier: '3.3.3', 'prettier-plugin-tailwindcss': '0.5.0' }
  );
  const major = projectPrettierMajor(graph, manifest);
  assert.equal(major, 3);
  assert.equal(prettierAutoLoadReference('prettier-plugin-tailwindcss', major), null);
  const finding = findingWithPrettier('prettier-plugin-tailwindcss', major);
  assert.equal(finding?.kind, 'likely-unused');
});

test('scoped Prettier plugins are loaded automatically on Prettier 2', () => {
  assert.equal(isPrettierAutoLoadedPluginName('@trivago/prettier-plugin-sort-imports'), true);
  assert.equal(isPrettierAutoLoadedPluginName('@prettier/plugin-xml'), true);
  assert.equal(findingWithPrettier('@trivago/prettier-plugin-sort-imports', 2), null);
  assert.equal(findingWithPrettier('@prettier/plugin-xml', 2), null);
  assert.notEqual(findingWithPrettier('@trivago/prettier-plugin-sort-imports', 3), null);
});

test('packages that are not Prettier plugins get no Prettier evidence', () => {
  for (const name of ['prettier', 'eslint-plugin-prettier', 'eslint-config-prettier', 'prettier-plugin-', 'left-pad']) {
    assert.equal(prettierAutoLoadReference(name, 2), null, name);
  }
});

test('without Prettier installed a plugin is reported as before', () => {
  const { graph, manifest } = npmProject({ 'prettier-plugin-tailwindcss': '^0.4.1' }, { 'prettier-plugin-tailwindcss': '0.4.1' });
  const major = projectPrettierMajor(graph, manifest);
  assert.equal(major, null);
  assert.equal(prettierAutoLoadReference('prettier-plugin-tailwindcss', major), null);
  assert.equal(findingWithPrettier('prettier-plugin-tailwindcss', major)?.kind, 'likely-unused');
});

test('the lockfile version wins over the declared range', () => {
  const { graph, manifest } = npmProject({ prettier: '>=2' }, { prettier: '2.8.8' });
  assert.equal(projectPrettierMajor(graph, manifest), 2);
});

test('without a lockfile entry the declared range decides, but only when it allows one major', () => {
  assert.equal(projectPrettierMajor(null, parseManifest(JSON.stringify({ devDependencies: { prettier: '^2.8.0' } }))), 2);
  assert.equal(prettierMajorFrom(null, '~2.3.0'), 2);
  assert.equal(prettierMajorFrom(null, '^3.0.0'), 3);
  assert.equal(prettierMajorFrom(null, '>=2'), null);
  assert.equal(prettierMajorFrom(null, '*'), null);
  assert.equal(prettierMajorFrom(null, 'latest'), null);
});
