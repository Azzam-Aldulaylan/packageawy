import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { buildPnpmGraph } from '../out/core/lockfile/pnpm.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { buildInstallPathIndex, pathsToNodes } from '../out/core/graph/paths.js';

test('an 18-hop pnpm chain with runtime and peer edges reconstructs one path in a few ms', () => {
  const packages = {};
  const snapshots = {};
  const keys = [];
  for (let i = 18; i >= 0; i--) {
    keys[i] = `pkg-${i}@1.0.0${i < 18 ? `(${keys[i + 1]})` : ''}`;
    packages[`pkg-${i}@1.0.0`] = i < 18 ? { peerDependencies: { [`pkg-${i + 1}`]: '*' } } : {};
    snapshots[keys[i]] = i < 18 ? { dependencies: { [`pkg-${i + 1}`]: keys[i + 1].slice(`pkg-${i + 1}@`.length) } } : {};
  }
  const graph = buildPnpmGraph({ root: '/fixture', manifest: parseManifest(JSON.stringify({ dependencies: { 'pkg-0': '1.0.0' } })),
    lockfileText: JSON.stringify({ lockfileVersion: '9.0',
      importers: { '.': { dependencies: { 'pkg-0': { version: keys[0].slice('pkg-0@'.length) } } } }, packages, snapshots }) });
  const start = performance.now();
  const index = buildInstallPathIndex(graph, { includeInstalledPeers: true });
  const result = pathsToNodes(graph, index, new Set([`pnpm:${keys[18]}`]));
  const elapsed = performance.now() - start;
  assert.deepEqual(result, { paths: [Array.from({ length: 19 }, (_, i) => `pkg-${i}`)], totalPaths: 1, truncated: false });
  assert.ok(elapsed < 50, `path reconstruction took ${elapsed.toFixed(1)} ms`);
  for (const parents of index.predecessors.values()) assert.equal(parents.length, new Set(parents).size);
});

test('duplicated name chains hit the reconstruction step budget even when only one distinct path completes', () => {
  const nodes = new Map();
  for (let level = 0; level < 9; level++) {
    for (let copy = 0; copy < 2; copy++) {
      const path = `${level}:${copy}`;
      const edges = level === 8 ? [] : [0, 1].flatMap(target => ['runtime', 'peer'].map(kind => ({
        name: `pkg-${level + 1}`, kind, targetNodeId: `${level + 1}:${target}`, optional: false, requestedRange: '*',
      })));
      nodes.set(path, { path, name: `pkg-${level}`, direct: level === 0, version: '1.0.0',
        range: '*', dev: false, deps: edges.map(edge => edge.name), edges });
    }
  }
  const graph = { root: '/fixture', packageManager: 'pnpm', lockfileVersion: '9.0', nodes };
  const index = buildInstallPathIndex(graph, { includeInstalledPeers: true });
  let lookups = 0;
  const get = nodes.get.bind(nodes);
  nodes.get = id => { lookups++; return get(id); };
  const result = pathsToNodes(graph, index, new Set(['8:0', '8:1']), { maxExplored: 40 });
  assert.equal(result.truncated, true, 'duplicate completed names cannot bypass the work budget');
  assert.equal(result.totalPaths, 1);
  assert.ok(lookups <= 80, `bounded reconstruction performed ${lookups} node lookups`);
});
