import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

const PUBLIC = 'https://registry.npmjs.org/';
const OTHER = 'https://registry.fixture.invalid/';
const json = (value) => {
  const body = JSON.stringify(value);
  return { status: 200, headers: {}, body, wireBytes: Buffer.byteLength(body) };
};

function optionsFor(range = '1.2.3', installed = '1.2.3', name = 'pkg') {
  const dependencies = { [name]: range };
  return {
    root: '/fixture', registry: PUBLIC,
    manifestText: JSON.stringify({ dependencies }),
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies }, [`node_modules/${name}`]: { version: installed },
    } }),
    auditUnavailableWhenOmitted: false,
  };
}

function clientFor(versions = ['1.2.3', '2.0.0']) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const path = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.startsWith('https://api.github.com/')) return json([]);
      if (path[1] === 'latest') return json({ version: '2.0.0', license: 'MIT', description: 'Recorded package' });
      if (path.length === 2) return json({ name: path[0], version: path[1] });
      return json({ versions: Object.fromEntries(versions.map((version) => [version, {}])), 'dist-tags': { latest: '2.0.0' } });
    },
    async post() { return json({}); },
  };
}
const scan = (options, client = clientFor()) => buildPackageRows({ ...options, httpClient: client, etagStore: new MemoryEtagStore() });

for (const registry of [PUBLIC, PUBLIC.slice(0, -1)]) {
  test(`pipeline makes canonical public pin eligible with registry ${registry}`, async () => {
    const client = clientFor();
    const options = optionsFor();
    const baseline = await scan({ ...options, registry: OTHER });
    assert.deepEqual(await scan({ ...options, registry }, client), baseline);
    assert.equal(client.calls[1], `${registry.replace(/\/$/, '')}/pkg/1.2.3`);
  });
}

test('scoped pin routed to public npm is eligible after routing', async () => {
  const client = clientFor();
  const options = { ...optionsFor('1.2.3', '1.2.3', '@scope/pkg'), registry: OTHER,
    resolvedRegistry: { url: OTHER, source: 'default', scoped: { '@scope': PUBLIC } } };
  assert.deepEqual(await scan(options, client), await scan({ ...options, resolvedRegistry: { url: OTHER, source: 'default', scoped: {} } }));
  assert.deepEqual(client.calls, [`${PUBLIC}@scope%2fpkg/latest`, `${PUBLIC}@scope%2fpkg/1.2.3`]);
});

const ineligible = [
  ['other registry', { registry: OTHER }],
  ['scoped routing', { name: '@scope/pkg', resolvedRegistry: { url: PUBLIC, scoped: { '@scope': OTHER }, source: 'default' } }],
  ['alias', { range: 'npm:pkg@1.2.3', name: 'compat' }],
  ['catalog', { range: 'catalog:' }],
  ['workspace', { range: 'workspace:*' }],
  ['file', { range: 'file:../pkg' }],
  ['git', { range: 'git+https://github.com/example/pkg.git' }],
  ['prerelease', { range: '1.2.3-beta.1', installed: '1.2.3-beta.1' }],
  ['equals prefix', { range: '=1.2.3' }],
  ['v prefix', { range: 'v1.2.3' }],
  ['whitespace', { range: ' 1.2.3' }],
  ['build metadata', { range: '1.2.3+meta', installed: '1.2.3+meta' }],
  ['different installed', { installed: '1.2.2' }],
];
for (const [label, { range, installed, name, ...extra }] of ineligible) {
  test(`pipeline keeps ${label} on today's path`, async () => {
    const client = clientFor();
    const options = { ...optionsFor(range, installed, name), ...extra };
    const baseline = await scan({ ...options, registry: OTHER,
      ...(extra.resolvedRegistry ? { resolvedRegistry: { ...extra.resolvedRegistry, url: OTHER } } : {}) });
    assert.deepEqual(await scan(options, client), baseline);
    assert.ok(client.calls.every((url) => !/\/(?:1\.2\.[23]|1\.2\.3-beta\.1|1\.2\.3%2Bmeta)$/.test(url)));
    if (label === 'scoped routing') assert.ok(client.calls.every((url) => url.startsWith(OTHER)));
  });
}

test('approved build-metadata case stays on the packument path on a non-npm registry', async () => {
  const client = clientFor(['1.2.3+meta', '1.2.3', '2.0.0']);
  const options = { ...optionsFor(), registry: OTHER };
  const result = await scan(options, client);
  assert.deepEqual(result, await scan(options, clientFor(['1.2.3+meta', '1.2.3', '2.0.0'])));
  assert.deepEqual(client.calls, [`${OTHER}pkg/latest`, `${OTHER}pkg`]);
  assert.equal(result.rows[0].wanted, '1.2.3+meta');
});

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const npmManifest = { dependencies: { react: '^18.2.0', 'legacy-thing': '^1.0.0' }, devDependencies: { typescript: '^5.4.0' } };
const cases = [
  ...[1, 2, 3].map((version) => ({ name: `lock-v${version}.json`, manifest: npmManifest })),
  { name: 'security-alias-npm.json', manifest: { dependencies: { compat: 'npm:lodash@4.17.20', '@isaacs/cliui': '^8.0.2' } } },
  { name: 'security-alias-pnpm.yaml', packageManager: 'pnpm', manifest: { dependencies: { compat: 'npm:lodash@4.17.20', lodash: '4.17.20', '@isaacs/cliui': '^8.0.2' } } },
  { name: 'pnpm-lock-v9.yaml', packageManager: 'pnpm', manifest: { dependencies: { react: '^19.0.0', 'peer-user': '^5.0.0', 'missing-peer': '^1.0.0', 'optional-peer': '^1.0.0' }, devDependencies: { typescript: '^5.4.0' }, optionalDependencies: { 'optional-root': '^2.0.0' } } },
  { name: 'pnpm-lock-v9-workspace.yaml', packageManager: 'pnpm', importerId: 'packages/app', manifest: { dependencies: { '@ws/lib': 'workspace:*', lodash: '^4.17.0' } } },
];
for (const entry of cases) {
  test(`pipeline equality with recorded registry responses over ${entry.name}`, async () => {
    const versions = ['1.0.0', '1.2.3', '2.0.0', '3.0.2', '4.0.0', '4.2.0', '4.17.20', '4.17.21', '5.0.0', '5.4.5', '8.0.2', '18.2.0', '19.0.0'];
    const options = { root: '/fixture', registry: PUBLIC, manifestText: JSON.stringify(entry.manifest), lockfileText: fixture(entry.name),
      ...(entry.packageManager ? { packageManager: entry.packageManager } : {}), ...(entry.importerId ? { importerId: entry.importerId } : {}) };
    // The alternate registry forces the established packument path with the
    // same recorded bodies, without adding a production feature switch.
    const baseline = await scan({ ...options, registry: OTHER }, clientFor(versions));
    const client = clientFor(versions);
    assert.deepEqual(await scan(options, client), baseline);
  });
}
