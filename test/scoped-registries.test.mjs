/**
 * Scoped registries from .npmrc reach every registry request in the dashboard
 * scan, the response cache keeps registries apart, and a workspace member
 * inherits the workspace root's .npmrc.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore, fetchLatest } from '../out/core/registry/versions.js';
import { deriveProjectCacheKey } from '../out/core/cache/keys.js';
import { loadProject } from '../out/host/projectResolution.js';

const PUBLIC = 'https://registry.npmjs.org';
const PRIVATE = 'https://npm.company.example';
const OTHER_PRIVATE = 'https://npm.other.example';

const json = (body, etag) => ({
  status: 200,
  headers: etag === undefined ? {} : { etag },
  body: JSON.stringify(body),
  wireBytes: JSON.stringify(body).length,
});

function routedClient(routes) {
  const urls = [];
  return {
    urls,
    async get(url, options = {}) {
      urls.push(url);
      const route = routes[url];
      if (route === undefined) return { status: 404, headers: {}, body: '', wireBytes: 0 };
      return typeof route === 'function' ? route(options) : route;
    },
    async post() {
      return json({});
    },
  };
}

test('a scoped package is fetched from its scoped registry while an unscoped package uses the default', async () => {
  const manifest = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    dependencies: { '@company/ui': '^2.0.0', 'clean-pkg': '^1.0.0' },
  });
  const lockfile = JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { '@company/ui': '^2.0.0', 'clean-pkg': '^1.0.0' } },
      'node_modules/@company/ui': { version: '2.0.0' },
      'node_modules/clean-pkg': { version: '1.0.0' },
    },
  });
  const client = routedClient({
    [`${PRIVATE}/@company%2fui/latest`]: json({ version: '3.0.0' }),
    // `latest` is outside ^2, so the scan escalates to the version list.
    [`${PRIVATE}/@company%2fui`]: json({ versions: { '2.0.0': {}, '2.1.0': {}, '3.0.0': {} }, 'dist-tags': { latest: '3.0.0' } }),
    [`${PUBLIC}/clean-pkg/latest`]: json({ version: '1.2.0' }),
  });

  const result = await buildPackageRows({
    root: '/tmp/project',
    manifestText: manifest,
    lockfileText: lockfile,
    registry: PUBLIC,
    resolvedRegistry: { url: PUBLIC, source: 'project-npmrc', scoped: { '@company': PRIVATE } },
    httpClient: client,
    etagStore: new MemoryEtagStore(),
  });

  const registryUrls = client.urls.filter((url) => !url.startsWith('https://api.github.com/'));
  assert.ok(registryUrls.every((url) => !(url.startsWith(PUBLIC) && url.includes('company'))), registryUrls.join('\n'));
  assert.ok(registryUrls.includes(`${PRIVATE}/@company%2fui/latest`));
  assert.ok(registryUrls.includes(`${PRIVATE}/@company%2fui`));
  assert.ok(registryUrls.includes(`${PUBLIC}/clean-pkg/latest`));

  const scoped = result.rows.find((row) => row.name === '@company/ui');
  assert.equal(scoped.wanted, '2.1.0');
  assert.equal(scoped.latest, '3.0.0');
  assert.equal(result.rows.find((row) => row.name === 'clean-pkg').latest, '1.2.0');
  assert.deepEqual(result.availability.unavailableUpdatePackages, []);
});

test('the same package name from two registries never shares a response cache entry', async () => {
  const store = new MemoryEtagStore();
  const client = routedClient({
    [`${PRIVATE}/@company%2fui/latest`]: (options) =>
      options.headers?.['if-none-match'] === '"private"'
        ? { status: 304, headers: {}, body: '', wireBytes: 0 }
        : json({ version: '9.0.0' }, '"private"'),
    [`${OTHER_PRIVATE}/@company%2fui/latest`]: (options) =>
      options.headers?.['if-none-match'] === undefined
        ? json({ version: '1.0.0' }, '"other"')
        : assert.fail('the other registry must not receive the first registry ETag'),
  });

  assert.equal((await fetchLatest(client, store, PRIVATE, '@company/ui')).version, '9.0.0');
  assert.equal((await fetchLatest(client, store, OTHER_PRIVATE, '@company/ui')).version, '1.0.0');
  assert.equal((await fetchLatest(client, store, PRIVATE, '@company/ui')).version, '9.0.0');
  assert.equal(store.get(`${PRIVATE}/@company%2fui/latest`).etag, '"private"');
  assert.equal(store.get(`${OTHER_PRIVATE}/@company%2fui/latest`).etag, '"other"');
});

test('scoped registries are part of the project cache key', () => {
  const unscoped = deriveProjectCacheKey('project', PUBLIC, 'npm');
  assert.equal(deriveProjectCacheKey('project', PUBLIC, 'npm', {}), unscoped);
  const scoped = deriveProjectCacheKey('project', PUBLIC, 'npm', { '@company': PRIVATE });
  assert.notEqual(scoped, unscoped);
  assert.notEqual(deriveProjectCacheKey('project', PUBLIC, 'npm', { '@company': OTHER_PRIVATE }), scoped);
  assert.equal(
    deriveProjectCacheKey('project', PUBLIC, 'npm', { '@b': OTHER_PRIVATE, '@company': PRIVATE }),
    deriveProjectCacheKey('project', PUBLIC, 'npm', { '@company': PRIVATE, '@b': OTHER_PRIVATE })
  );
});

async function loadMember(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-scoped-'));
  const home = await mkdtemp(path.join(tmpdir(), 'packageawy-home-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  const folder = { id: 'folder', name: 'fixture', path: root };
  const platform = {
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => true,
    findFiles: async () => [path.join(root, 'package-lock.json')],
  };
  return loadProject(platform, {
    id: 'member',
    dir: 'packages/web',
    manifestPath: 'packages/web/package.json',
    folder,
  });
}

const WORKSPACE_FILES = {
  'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  'package-lock.json': JSON.stringify({ name: 'root', lockfileVersion: 3, packages: { '': { name: 'root' } } }),
  'packages/web/package.json': JSON.stringify({ name: 'web', version: '1.0.0' }),
};

test('a workspace member inherits the workspace root .npmrc scope', async (t) => {
  const project = await loadMember(t, {
    ...WORKSPACE_FILES,
    '.npmrc': `@company:registry=${PRIVATE}\n`,
  });
  assert.equal(project.importerId, 'packages/web');
  assert.equal(project.registry, PUBLIC);
  assert.deepEqual(project.resolvedRegistry.scoped, { '@company': PRIVATE });
});

test('a workspace member .npmrc overrides the workspace root .npmrc', async (t) => {
  const project = await loadMember(t, {
    ...WORKSPACE_FILES,
    '.npmrc': `@company:registry=${PRIVATE}\n@shared:registry=${PRIVATE}\n`,
    'packages/web/.npmrc': `@company:registry=${OTHER_PRIVATE}\n`,
  });
  assert.deepEqual(project.resolvedRegistry.scoped, { '@company': OTHER_PRIVATE, '@shared': PRIVATE });
});
