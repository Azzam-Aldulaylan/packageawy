import { buildDependencyGraph } from '../../out/core/lockfile/build.js';
import { parseManifest } from '../../out/core/manifest/parse.js';
import { auditUpgradeReview } from '../../out/host/upgradeReviewSecurity.js';

export function peerGraph(upgraded = false) {
  const manifest = { dependencies: { app: upgraded ? '2.0.0' : '1.0.0' } };
  const packages = { '': manifest, 'node_modules/app': {
    version: manifest.dependencies.app,
    ...(upgraded ? { peerDependencies: { peer: '^3', absent: '^1' },
      peerDependenciesMeta: { absent: { optional: true } } } : {}),
  }, ...(upgraded ? {
    'node_modules/peer': { version: '3.0.0', peer: true, dependencies: { child: '4.0.0' } },
    'node_modules/child': { version: '4.0.0' },
    'node_modules/orphan': { version: '5.0.0' },
  } : {}) };
  return buildDependencyGraph({ root: '/fixture', packageManager: 'npm',
    manifest: parseManifest(JSON.stringify(manifest)), lockfileText: JSON.stringify({ lockfileVersion: 3, packages }) });
}

export const peerAdvisories = Object.fromEntries(['peer', 'child', 'orphan', 'absent'].map((name, index) => [name, [{
  id: index + 1, severity: index === 1 ? 'critical' : 'high', title: `${name} vulnerability`,
  url: `https://example.com/advisory/${name}`, vulnerable_versions: '*',
}]]));

export function auditInstalledPeer() {
  return auditUpgradeReview({ before: peerGraph(), after: peerGraph(true), enabled: () => true,
    signal: new AbortController().signal,
    client: { post: async () => ({ status: 200, body: JSON.stringify(peerAdvisories) }) } });
}
