import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildPnpmGraph } from '../out/core/lockfile/pnpm.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { attributeAdvisories } from '../out/core/advisories/attribution.js';
import { auditUpgradeReview } from '../out/host/upgradeReviewSecurity.js';

const manifest = parseManifest(JSON.stringify({ dependencies: { 'plugin-bar': '1.0.0' } }));
const lockfileText = readFileSync(new URL('./fixtures/pnpm-absent-optional-peer.yaml', import.meta.url), 'utf8');
const graph = text => buildPnpmGraph({ root: '/fixture', manifest, lockfileText: text });
const advisory = { id: 1, severity: 'high', title: 'bar vulnerability',
  url: 'https://example.com/bar', vulnerableVersions: '*' };

test('dashboard excludes an absent pnpm optional peer installed only by another importer', () => {
  const installed = graph(lockfileText);
  assert.deepEqual(attributeAdvisories(installed, new Map([['bar', [advisory]]])).get('plugin-bar'), undefined);
  assert.equal(installed.nodes.get('pnpm:plugin-bar@1.0.0').edges[0].targetNodeId, null);
});

test('review excludes an absent pnpm optional peer installed only by another importer', async () => {
  const installed = graph(lockfileText);
  const security = await auditUpgradeReview({ before: installed, after: installed, enabled: () => true,
    signal: new AbortController().signal, client: { post: async () => ({ status: 200,
      body: JSON.stringify({ bar: [{ ...advisory, vulnerable_versions: '*' }] }) }) } });
  assert.equal(security.checkState, 'complete');
  assert.deepEqual(security.remaining, []);
  assert.deepEqual(security.introduced, []);
  assert.deepEqual(security.resolvedAdvisories, []);
});

for (const relationship of ['dependencies', 'context']) {
  test(`pnpm peers use the explicit snapshot ${relationship} including nested and scoped contexts`, () => {
    const context = '(@scope/bar@1.0.0(child@2.0.0))';
    const key = `plugin-bar@1.0.0${relationship === 'context' ? context : ''}`;
    const installed = graph(JSON.stringify({ lockfileVersion: '9.0',
      importers: { '.': { dependencies: { 'plugin-bar': { version: key.slice('plugin-bar@'.length) } } } },
      packages: { 'plugin-bar@1.0.0': { peerDependencies: { '@scope/bar': '^1', child: '*' } },
        '@scope/bar@1.0.0': {}, 'child@2.0.0': {} },
      snapshots: { [key]: relationship === 'dependencies' ? { dependencies: { '@scope/bar': '1.0.0(child@2.0.0)' } } : {},
        '@scope/bar@1.0.0(child@2.0.0)': { dependencies: { child: '2.0.0' } }, 'child@2.0.0': {} },
    }));
    const peers = installed.nodes.get(`pnpm:${key}`).edges.filter(edge => edge.kind === 'peer');
    assert.equal(peers[0].targetNodeId, 'pnpm:@scope/bar@1.0.0(child@2.0.0)');
    assert.equal(peers[1].targetNodeId, null, 'nested peer context belongs to the peer snapshot');
  });
}
