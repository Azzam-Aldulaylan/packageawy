import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

import { buildPackageRows } from '../out/core/pipeline.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { resolveDependency, directNodes } from '../out/core/lockfile/parse.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { severityDisplay } from '../out/host/severityDisplay.js';
import { toHostToWebviewMessage } from '../out/host/dashboardData.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { validateUpgradeRequest, validateRemoveRequest } from '../out/core/upgrade/validate.js';
import { buildStagedManifestForRemoval } from '../out/core/upgrade/stagedManifest.js';
import { compareProposedGraphSecurityImpact } from '../out/host/proposedGraphSecurityImpact.js';
import { buildVulnerabilityContexts } from '../out/core/advisories/vulnerabilityContext.js';

// Render the shipped table, including its badge props, with one React runtime.
const renderDir = mkdtempSync(join(tmpdir(), 'packageawy-security-table-'));
after(() => rmSync(renderDir, { recursive: true, force: true }));
buildSync({
  stdin: {
    contents: `import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { PackageTable } from './webview/src/components/PackageTable.tsx';
      export const renderTable = (props) => renderToStaticMarkup(createElement(PackageTable, props));`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(renderDir, 'table.cjs'),
  logLevel: 'silent',
});
const { renderTable } = createRequire(import.meta.url)(join(renderDir, 'table.cjs'));
const tableHtml = (rows) => renderTable({
  rows, unavailableUpdatePackages: new Set(), advisoriesAvailable: true,
  searchQuery: '', sortState: { column: 'package', direction: 'asc' },
  onSort() {}, onOpenAdvisory() {}, onOpenManage() {}, hygieneFindings: [],
});

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const manifestText = JSON.stringify({ dependencies: { compat: 'npm:lodash@4.17.20', '@isaacs/cliui': '^8.0.2' } });
const response = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: 0 });
const advisory = (name) => ({ id: name, title: `${name} advisory`, severity: 'high', url: 'https://example.test/advisory', vulnerable_versions: '*' });

async function scan(overrides = {}) {
  const gets = [];
  const posts = [];
  const result = await buildPackageRows({
    root: '/app', manifestText, lockfileText: fixture('security-alias-npm.json'),
    registry: 'https://registry.npmjs.org', etagStore: new MemoryEtagStore(),
    auditUnavailableWhenOmitted: false,
    httpClient: {
      async get(url) {
        gets.push(url);
        if (url.startsWith('https://api.github.com/')) return response([]);
        return response({ version: '4.17.21', 'dist-tags': { latest: '4.17.21' }, versions: { '4.17.20': {}, '4.17.21': {} } });
      },
      async post(url, body) {
        posts.push(JSON.parse(body));
        return response({ lodash: [advisory('lodash')], 'string-width': [advisory('string-width')] });
      },
    },
    ...overrides,
  });
  return { ...result, gets, posts };
}

test('npm direct alias uses registry identity for advisories and metadata and installed identity for edits', async () => {
  const result = await scan();
  assert.deepEqual(result.posts[0].lodash, ['4.17.20']);
  assert.equal(result.posts[0].compat, undefined);
  const row = result.rows.find((row) => row.name === 'compat');
  assert.equal(row.current, '4.17.20');
  assert.equal(row.worstSeverity, 'high');
  assert.equal(row.upgradeTo, null, 'ordinary install commands must preserve alias declarations');
  assert.equal(row.advisories[0].flaggedPackage, 'lodash');
  assert.deepEqual(row.advisories[0].path, ['compat']);
  assert.ok(result.gets.includes('https://registry.npmjs.org/lodash/latest'));
  assert.ok(!result.gets.some((url) => url.includes('/compat')));
  const declared = parseManifest(manifestText).dependencies;
  const eligible = validateUpgradeRequest([{ ...row, upgradeTo: '4.17.21', upgradeReason: 'update' }], declared, { package: 'compat', target: '4.17.21' });
  assert.equal(eligible.packageName, 'compat');
  const removal = validateRemoveRequest(result.rows, declared, { package: 'compat' });
  assert.equal(removal.packageName, 'compat');
  const edited = JSON.parse(buildStagedManifestForRemoval(manifestText, [removal]));
  assert.equal(edited.dependencies.compat, undefined);
  assert.equal(edited.dependencies['@isaacs/cliui'], '^8.0.2');
});

test('npm transitive alias resolves identity from npm spec and keeps the installed attribution path', async () => {
  const result = await scan();
  assert.deepEqual(result.posts[0]['string-width'], ['4.2.0']);
  assert.equal(result.posts[0]['string-width-cjs'], undefined);
  const row = result.rows.find((row) => row.name === '@isaacs/cliui');
  assert.equal(row.worstSeverity, 'high');
  assert.equal(row.advisories[0].flaggedPackage, 'string-width');
  assert.deepEqual(row.advisories[0].path, ['@isaacs/cliui', 'string-width-cjs']);
});

test('pnpm aliases retain resolved versions and edges alongside the real direct dependency', async () => {
  const options = { packageManager: 'pnpm', lockfileText: fixture('security-alias-pnpm.yaml'), manifestText: JSON.stringify({ dependencies: { ...JSON.parse(manifestText).dependencies, lodash: '4.17.20' } }) };
  const result = await scan(options);
  const alias = result.rows.find((row) => row.name === 'compat');
  assert.equal(alias.current, '4.17.20');
  assert.equal(alias.worstSeverity, 'high');
  assert.ok(result.rows.some((row) => row.name === 'lodash'));
  assert.deepEqual(result.posts[0].lodash, ['4.17.20']);
  assert.equal(result.posts[0].compat, undefined);
  assert.deepEqual(result.rows.find((row) => row.name === '@isaacs/cliui').advisories[0].path, ['@isaacs/cliui', 'string-width-cjs']);
  const graph = buildDependencyGraph({ root: '/app', manifest: parseManifest(options.manifestText), ...options });
  const node = directNodes(graph).find((node) => node.name === 'compat');
  assert.equal(resolveDependency(graph, node.path, 'helper').version, '1.0.0');
});

for (const packageManager of ['npm', 'pnpm']) {
  test(`${packageManager} without a lockfile reports partial coverage and every row is Not checked`, async () => {
    const result = await scan({ packageManager, manifestText: fixture('security-no-lockfile/package.json'), lockfileText: null });
    assert.equal(result.availability.advisories, 'partial');
    assert.equal(result.posts.length, 0);
    for (const row of result.rows) {
      assert.equal(row.advisoryCoverage, 'partial');
      const display = severityDisplay(row.worstSeverity, true, row.current !== null);
      assert.equal(display.label, 'Not checked');
      assert.equal(display.className, 'info');
      assert.equal(display.reason, 'Install dependencies to check this package');
    }
    const html = tableHtml(result.rows);
    assert.doesNotMatch(html, />Safe</);
    assert.equal((html.match(/>Not checked</g) ?? []).length, result.rows.length);
    assert.match(html, /title="Install dependencies to check this package"/);
    const message = toHostToWebviewMessage(result, { isEmpty: false, isStale: false }, { id: 'id:app', label: 'app', manifestPath: '/app/package.json' }, false, { extensionVersion: 'test', builtAt: 'test' });
    assert.equal(message.status, 'partial-error');
    assert.equal(isHostToWebviewMessage(message), true);
  });
}

test('an unknown transitive version makes its root partial while checked findings remain visible', async () => {
  const lock = JSON.parse(fixture('security-alias-npm.json'));
  delete lock.packages['node_modules/string-width-cjs'].version;
  const result = await scan({ lockfileText: JSON.stringify(lock) });
  assert.equal(result.availability.advisories, 'partial');
  assert.equal(result.rows.find((row) => row.name === '@isaacs/cliui').advisoryCoverage, 'partial');
  assert.equal(result.rows.find((row) => row.name === 'compat').worstSeverity, 'high');
  const html = tableHtml(result.rows);
  assert.match(html, />High</);
  assert.match(html, />Not checked</);
  assert.doesNotMatch(html, />Safe</);
});

test('npm v1 alias specs supply the real registry name and exact resolved version', async () => {
  const result = await scan({
    manifestText: JSON.stringify({ dependencies: { compat: 'npm:@scope/real@^1.0.0' } }),
    lockfileText: JSON.stringify({ lockfileVersion: 1, dependencies: { compat: { version: 'npm:@scope/real@1.2.3' } } }),
  });
  assert.deepEqual(result.posts[0]['@scope/real'], ['1.2.3']);
  assert.equal(result.posts[0].compat, undefined);
  assert.equal(result.rows[0].current, '1.2.3');
});

test('npm direct alias falls back to the manifest npm spec when lockfile name is absent', async () => {
  const lock = JSON.parse(fixture('security-alias-npm.json'));
  delete lock.packages['node_modules/compat'].name;
  const result = await scan({ lockfileText: JSON.stringify(lock) });
  assert.deepEqual(result.posts[0].lodash, ['4.17.20']);
  assert.equal(result.rows.find((row) => row.name === 'compat').worstSeverity, 'high');
});

test('pnpm resolves npm-prefixed direct and transitive alias references', async () => {
  const result = await scan({ packageManager: 'pnpm', lockfileText: fixture('security-alias-pnpm.yaml')
    .replace('version: lodash@4.17.20', 'version: npm:lodash@4.17.20')
    .replace('string-width-cjs: string-width@4.2.0', 'string-width-cjs: npm:string-width@4.2.0') });
  assert.equal(result.rows.find((row) => row.name === 'compat').current, '4.17.20');
  assert.equal(result.rows.find((row) => row.name === '@isaacs/cliui').worstSeverity, 'high');
});

test('a missing direct version stays Not checked alongside a checked clean package', async () => {
  const result = await scan({
    manifestText: JSON.stringify({ dependencies: { clean: '^1.0.0', missing: '^1.0.0' } }),
    lockfileText: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/clean': { version: '1.0.0' } } }),
  });
  assert.equal(result.availability.advisories, 'partial');
  assert.equal(result.rows.find((row) => row.name === 'clean').advisoryCoverage, 'complete');
  assert.equal(result.rows.find((row) => row.name === 'missing').advisoryCoverage, 'partial');
  const html = tableHtml(result.rows);
  assert.equal((html.match(/>Safe</g) ?? []).length, 1);
  assert.equal((html.match(/>Not checked</g) ?? []).length, 1);
});

test('security comparisons and vulnerability details match aliases by registry identity', async () => {
  const result = await scan();
  const graph = buildDependencyGraph({ root: '/app', packageManager: 'npm', manifest: parseManifest(manifestText), lockfileText: fixture('security-alias-npm.json') });
  const row = result.rows.find((row) => row.name === '@isaacs/cliui');
  const snapshot = { graph, advisories: 'complete', advisoriesByName: new Map([['string-width', [row.advisories[0].advisory]]]) };
  const impact = compareProposedGraphSecurityImpact(snapshot, snapshot);
  assert.equal(impact.status, 'complete');
  assert.equal(impact.remaining[0].flaggedPackage, 'string-width');
  assert.deepEqual(impact.remaining[0].beforePaths, [['@isaacs/cliui', 'string-width-cjs']]);
  const contexts = buildVulnerabilityContexts({ graph, attributedAdvisories: row.advisories });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].flaggedPackage, 'string-width');
});

test('workspace links, file dependencies and missing optional platform packages keep coverage complete', async () => {
  const result = await scan({
    manifestText: JSON.stringify({ dependencies: { local: 'file:../local', member: '*', clean: '^1.0.0' } }),
    lockfileText: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { local: 'file:../local', member: '*', clean: '^1.0.0' } },
        'node_modules/local': { resolved: '../local', link: true },
        'node_modules/member': { resolved: 'packages/member', link: true },
        'node_modules/clean': { version: '1.0.0', optionalDependencies: { 'other-platform-binary': '1.0.0' } },
      },
    }),
  });
  assert.equal(result.availability.advisories, 'complete');
  for (const row of result.rows) assert.equal(row.advisoryCoverage, 'complete', row.name);
  assert.doesNotMatch(tableHtml(result.rows), />Not checked</);
});
