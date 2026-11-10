/**
 * Registries that ask for sign-in (401/403): a distinct error carrying only
 * the host, grouped in scan availability, and rendered as one info banner per
 * host plus a short label in the Available cell.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

import { buildPackageRows } from '../out/core/pipeline.js';
import { errorForStatus, registryErrorForStatus } from '../out/core/registry/http.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { isScanDataAvailability } from '../out/core/validation.js';
import { isPersistedProjectCacheCollection } from '../out/core/cache/schema.js';
import { registrySignInBannerText, signInHostsByPackage } from '../out/host/registrySignIn.js';

const renderDir = mkdtempSync(join(tmpdir(), 'packageawy-sign-in-'));
after(() => rmSync(renderDir, { recursive: true, force: true }));
buildSync({
  stdin: {
    contents: `import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { PackageTable } from './webview/src/components/PackageTable.tsx';
      import { RegistrySignInBanners } from './webview/src/components/RegistrySignInBanners.tsx';
      export const renderTable = (props) => renderToStaticMarkup(createElement(PackageTable, props));
      export const renderBanners = (groups) => renderToStaticMarkup(createElement(RegistrySignInBanners, { groups }));`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(renderDir, 'sign-in.cjs'),
  logLevel: 'silent',
});
const { renderTable, renderBanners } = createRequire(import.meta.url)(join(renderDir, 'sign-in.cjs'));

test('401 and 403 map to REGISTRY_AUTH_REQUIRED with the host and no credentials', () => {
  for (const status of [401, 403]) {
    const error = registryErrorForStatus(status, 'https://user:s3cret@npm.corp.example:8443/private/@corp%2fui/latest');
    assert.equal(error.code, 'REGISTRY_AUTH_REQUIRED');
    assert.equal(error.status, status);
    assert.equal(error.registryHost, 'npm.corp.example:8443');
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /user|s3cret|private|corp%2f/);
  }
});

test('404 and other statuses keep their existing codes', () => {
  assert.equal(registryErrorForStatus(404, 'https://r.example/x').code, 'REGISTRY_404');
  assert.equal(registryErrorForStatus(429, 'https://r.example/x').code, 'RATE_LIMITED');
  assert.equal(registryErrorForStatus(503, 'https://r.example/x').code, 'REGISTRY_5XX');
  assert.equal(registryErrorForStatus(418, 'https://r.example/x').code, 'NETWORK');
  // The shared mapper used by the public advisory endpoints is unchanged.
  assert.equal(errorForStatus(401, 'u').code, 'NETWORK');
  assert.equal(errorForStatus(403, 'u').code, 'NETWORK');
});

const MANIFEST = JSON.stringify({
  name: 'app', version: '1.0.0',
  dependencies: { '@corp/ui': '^1.0.0', '@corp/api': '^1.0.0', '@other/kit': '^1.0.0', lodash: '^4.0.0', missing: '^1.0.0' },
});
const LOCKFILE = JSON.stringify({
  name: 'app', lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0' },
    'node_modules/@corp/ui': { version: '1.0.0' },
    'node_modules/@corp/api': { version: '1.0.0' },
    'node_modules/@other/kit': { version: '1.0.0' },
    'node_modules/lodash': { version: '4.17.21' },
    'node_modules/missing': { version: '1.0.0' },
  },
});
const json = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: 1 });
const status = (code) => ({ status: code, headers: {}, body: '', wireBytes: 1 });

test('a scan groups sign-in failures by registry host and leaves 404 generic', async () => {
  const resolvedRegistry = {
    url: 'https://registry.npmjs.org', source: 'project-npmrc',
    scoped: { '@corp': 'https://token:abc@npm.corp.example/', '@other': 'https://other.example/npm/' },
  };
  const result = await buildPackageRows({
    root: '/app', manifestText: MANIFEST, lockfileText: LOCKFILE,
    registry: 'https://registry.npmjs.org', resolvedRegistry,
    etagStore: new MemoryEtagStore(), publicAdvisoryCheck: false,
    httpClient: {
      async get(url) {
        if (url.startsWith('https://token:abc@npm.corp.example/')) return status(401);
        if (url.startsWith('https://other.example/')) return status(403);
        if (url === 'https://registry.npmjs.org/lodash/latest') return json({ version: '4.17.21' });
        return status(404);
      },
      async post() { return json({}); },
    },
  });

  assert.equal(result.availability.updates, 'partial');
  assert.deepEqual(new Set(result.availability.unavailableUpdatePackages), new Set(['@corp/ui', '@corp/api', '@other/kit', 'missing']));
  const groups = Object.fromEntries(result.availability.signInRequired.map((g) => [g.registryHost, new Set(g.packages)]));
  assert.deepEqual(groups, {
    'npm.corp.example': new Set(['@corp/ui', '@corp/api']),
    'other.example': new Set(['@other/kit']),
  });
  assert.doesNotMatch(JSON.stringify(result.availability), /token|abc/);
  assert.equal(isScanDataAvailability(result.availability), true);
});

test('validation accepts the sign-in shape, absent or present, and rejects inconsistent groups', () => {
  const base = { updates: 'partial', advisories: 'complete', unavailableUpdatePackages: ['a', 'b'] };
  assert.equal(isScanDataAvailability(base), true, 'older payloads without the field stay valid');
  assert.equal(isScanDataAvailability({ ...base, signInRequired: [{ registryHost: 'r.example', packages: ['a'] }] }), true);
  for (const signInRequired of [
    [],
    [{ registryHost: '', packages: ['a'] }],
    [{ registryHost: 'r.example', packages: [] }],
    [{ registryHost: 'r.example', packages: ['c'] }],
    [{ registryHost: 'r.example', packages: ['a'] }, { registryHost: 'r.example', packages: ['b'] }],
    [{ registryHost: 'r.example', packages: ['a'] }, { registryHost: 's.example', packages: ['a'] }],
    'r.example',
  ]) {
    assert.equal(isScanDataAvailability({ ...base, signInRequired }), false, JSON.stringify(signInRequired));
  }
});

test('the project cache rejects snapshots from before sign-in grouping', () => {
  assert.equal(isPersistedProjectCacheCollection({ schemaVersion: 9, entries: [] }), false);
  assert.equal(isPersistedProjectCacheCollection({ schemaVersion: 10, entries: [] }), false);
  assert.equal(isPersistedProjectCacheCollection({ schemaVersion: 11, entries: [] }), true);
});

test('the dashboard shows one info banner per host with plain wording', () => {
  const groups = [
    { registryHost: 'registry.example.com', packages: ['a', 'b', 'c', 'd'] },
    { registryHost: 'npm.corp.example', packages: ['e'] },
  ];
  assert.equal(
    registrySignInBannerText(groups[0]),
    'registry.example.com asks for sign-in, so update information for 4 packages is not shown. Packageawy does not send registry sign-in details.'
  );
  assert.match(registrySignInBannerText(groups[1]), /for 1 package is not shown/);
  const html = renderBanners(groups);
  assert.equal(html.match(/banner--info/g)?.length, 2);
  assert.match(html, /registry\.example\.com asks for sign-in/);
  assert.match(html, /npm\.corp\.example asks for sign-in/);
  assert.doesNotMatch(html, /[–—]/);
  assert.equal(renderBanners(undefined), '');
});

test('sign-in rows show a short label with a tooltip; other unavailable rows keep the generic label', () => {
  const row = (name) => ({
    name, range: '^1.0.0', current: '1.0.0', wanted: null, latest: null, dev: false, optional: false,
    advisories: [], upgradeTo: null, upgradeReason: null, worstSeverity: null,
  });
  const availability = {
    updates: 'partial', advisories: 'complete', unavailableUpdatePackages: ['@corp/ui', 'missing'],
    signInRequired: [{ registryHost: 'npm.corp.example', packages: ['@corp/ui'] }],
  };
  const html = renderTable({
    rows: [row('@corp/ui'), row('missing')],
    unavailableUpdatePackages: new Set(availability.unavailableUpdatePackages),
    signInHosts: signInHostsByPackage(availability),
    advisoriesAvailable: true, searchQuery: '', sortState: { column: 'package', direction: 'asc' },
    onSort() {}, onOpenAdvisory() {}, onOpenManage() {}, hygieneFindings: [],
  });
  assert.match(html, /title="npm\.corp\.example asks for sign-in\. Packageawy does not send registry sign-in details\."[^>]*>Sign-in needed</);
  assert.equal(html.match(/>Unavailable</g)?.length, 1);
});

test('packages that only need sign-in do not hold back upgrades for the rest of the project', async () => {
  const { updatesSettled } = await import('../out/host/registrySignIn.js');
  const signIn = [{ registryHost: 'npm.corp.example', packages: ['@corp/a', '@corp/b'] }];
  assert.equal(updatesSettled({ updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] }), true);
  assert.equal(updatesSettled({ updates: 'partial', advisories: 'complete', unavailableUpdatePackages: ['@corp/a', '@corp/b'], signInRequired: signIn }), true);
  assert.equal(updatesSettled({ updates: 'partial', advisories: 'complete', unavailableUpdatePackages: ['@corp/a', 'lodash'], signInRequired: signIn }), false);
  assert.equal(updatesSettled({ updates: 'partial', advisories: 'complete', unavailableUpdatePackages: ['lodash'] }), false);
});
