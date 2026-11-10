import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { attributeAdvisories } from '../out/core/advisories/attribution.js';
import { distinctFlaggedPackages } from '../out/core/advisories/remediation.js';
import { enrichAdvisoriesWithGitHubIdentifiers } from '../out/core/advisories/githubIdentifiers.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const GHSA = 'GHSA-aaaa-bbbb-cccc';
async function check(graph, expected) {
  const names = new Set([...graph.nodes.values()].map((node) => node.registryName ?? node.name));
  names.add('unreachable-finding');
  const npm = new Map([...names].map((name, id) => [name, [{ id, severity: 'high', title: 'Recorded finding',
    url: `https://github.com/advisories/${GHSA}`, vulnerableVersions: '<5.0.0' }]]));
  let requests = 0;
  const enriched = await enrichAdvisoriesWithGitHubIdentifiers({ async get() {
    requests += 1;
    const body = JSON.stringify([{ ghsa_id: GHSA, cve_id: 'CVE-2026-1234', identifiers: [{ type: 'GHSA', value: GHSA }, { type: 'CVE', value: 'CVE-2026-1234' }] }]);
    return { status: 200, headers: {}, body, wireBytes: body.length };
  } }, new MemoryEtagStore(), npm);
  assert.ok(requests > 0);
  assert.ok([...enriched.values()].some((entries) => entries[0].identifiers?.some((identifier) => identifier.type === 'CVE')));
  const before = distinctFlaggedPackages(attributeAdvisories(graph, npm));
  const after = distinctFlaggedPackages(attributeAdvisories(graph, enriched));
  assert.deepEqual(after, before);
  assert.equal(after.has('unreachable-finding'), false);
  if (expected) assert.deepEqual([...after].sort(), [...expected].sort());
  return attributeAdvisories(graph, npm);
}

for (const [name, packageManager, dependencies] of [
  ['security-alias-npm.json', 'npm', { compat: 'npm:lodash@4.17.20', '@isaacs/cliui': '^8.0.2' }],
  ['security-alias-pnpm.yaml', 'pnpm', { compat: 'npm:lodash@4.17.20', lodash: '4.17.20', '@isaacs/cliui': '^8.0.2' }],
  ['lock-v3.json', 'npm', { react: '^18.2.0', 'legacy-thing': '^1.0.0' }],
  ['pnpm-lock-v9.yaml', 'pnpm', { react: '^19.0.0', 'peer-user': '^5.0.0', 'missing-peer': '^1.0.0', 'optional-peer': '^1.0.0' }],
]) {
  test(`npm and enriched flagged sets agree over ${name}`, async () => {
    const graph = buildDependencyGraph({ root: '/fixture', packageManager, manifest: parseManifest(JSON.stringify({ dependencies })), lockfileText: fixture(name) });
    await check(graph);
  });
}

test('flagged sets preserve alias identity, installed peers, multiple versions, cycles and unreachable findings', async () => {
  const dependencies = { compat: 'npm:real@1.0.0', app: '^1.0.0' };
  const graph = buildDependencyGraph({ root: '/fixture', packageManager: 'npm', manifest: parseManifest(JSON.stringify({ dependencies })), lockfileText: JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies },
    'node_modules/compat': { name: 'real', version: '1.0.0', dependencies: { leaf: '^1.0.0' } },
    'node_modules/compat/node_modules/leaf': { version: '1.0.0' },
    'node_modules/app': { version: '1.0.0', dependencies: { cycle: '^1.0.0', leaf: '^5.0.0' }, peerDependencies: { peer: '^1.0.0' } },
    'node_modules/leaf': { version: '5.0.0' },
    'node_modules/cycle': { version: '1.0.0', dependencies: { app: '^1.0.0' } },
    'node_modules/peer': { version: '1.0.0', dependencies: { 'peer-child': '^1.0.0' } },
    'node_modules/peer-child': { version: '1.0.0' },
    'node_modules/unreachable': { version: '1.0.0' },
  } }) });
  const attributed = await check(graph, ['real', 'leaf', 'app', 'cycle', 'peer', 'peer-child']);
  assert.equal(attributed.get('compat')[0].flaggedPackage, 'real');
  assert.ok(attributed.get('compat').some((entry) => entry.flaggedPackage === 'leaf' && entry.flaggedVersion === '1.0.0'));
  assert.ok(attributed.get('app').every((entry) => entry.flaggedPackage !== 'leaf'));
  assert.ok(attributed.get('app').some((entry) => entry.path.join('/') === 'app/peer/peer-child'));
});
