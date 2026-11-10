/**
 * Attribution of bulk-advisory results onto direct dependencies.
 *
 * Attribution is computed here from the lockfile graph, not from `npm audit`'s `effects`/`via`. `effects` is a
 * one-hop reverse edge (points only at the immediate parent), not a path
 * chain, and it is a fix-blame graph: it only links a node when the
 * vulnerability can't be fixed in place, so it is incomplete by
 * construction. We already build a normalized graph for "Current Version";
 * walking it ourselves is strictly better and doesn't depend on audit being
 * reachable at all.
 *
 * For each direct dependency we BFS over resolved `deps` edges (npm's own
 * node_modules lookup rule, via `resolveFrom`) and record the shortest path
 * to every package version that the bulk endpoint flagged.
 */

import semver from 'semver';

import type { AttributedAdvisory, Advisory, DependencyGraph, DependencyNode, PackageRow } from '../types.js';
import { directNodes, resolveDependency } from '../lockfile/parse.js';

/** Advisories keyed by package name, as returned by the bulk endpoint. */
export type AdvisoriesByName = ReadonlyMap<string, readonly Advisory[]>;

/** Advisories that actually apply to the version resolved at this node. */
function applicableAdvisories(node: DependencyNode, byName: AdvisoriesByName): Advisory[] {
  if (node.version === null) return [];
  const advisories = byName.get(node.registryName ?? node.name);
  if (advisories === undefined) return [];
  return advisories.filter((a) => {
    try {
      return semver.satisfies(node.version as string, a.vulnerableVersions, {
        includePrerelease: true,
      });
    } catch {
      // A malformed range from the registry shouldn't take down attribution
      // for every other package.
      return false;
    }
  });
}

/**
 * BFS from a single direct dependency, recording the first (shortest) chain
 * of package names down to each flagged node in its subtree.
 */
function attributeFromRoot(
  graph: DependencyGraph,
  root: DependencyNode,
  byName: AdvisoriesByName
): AttributedAdvisory[] {
  const out: AttributedAdvisory[] = [];
  const visited = new Set<string>([root.path]);
  const queue: Array<{ node: DependencyNode; chain: readonly string[] }> = [
    { node: root, chain: [root.name] },
  ];

  let i = 0;
  while (i < queue.length) {
    const current = queue[i];
    i += 1;
    if (current === undefined) continue;
    const { node, chain } = current;

    for (const advisory of applicableAdvisories(node, byName)) {
      // `patchedVersion` starts as the safe placeholder here: attribution has
      // no registry access and can't compute it. `attachPatchedVersions` (see
      // advisories/remediation.ts) is the only place that fills it in, once
      // per unique flagged package, after this map is built. `flaggedVersion`
      // is this node's resolved version: the actual vulnerable version
      // in the tree, never the root direct dependency's version for a
      // transitive advisory, and is known here for free from the graph walk.
      out.push({
        advisory,
        flaggedPackage: node.registryName ?? node.name,
        path: [...chain],
        flaggedVersion: node.version,
        patchedVersion: { status: 'unknown' },
      });
    }

    for (const depName of node.deps) {
      const depNode = resolveDependency(graph, node.path, depName, ['runtime', 'optional']);
      if (depNode === null || visited.has(depNode.path)) continue;
      visited.add(depNode.path);
      queue.push({ node: depNode, chain: [...chain, depName] });
    }
  }

  return out;
}

/**
 * Attribute bulk-advisory results onto every direct dependency that has at
 * least one reachable flagged package in its subtree. Direct dependencies
 * with nothing attributed are omitted from the result.
 */
export function attributeAdvisories(
  graph: DependencyGraph,
  byName: AdvisoriesByName
): Map<string, AttributedAdvisory[]> {
  const result = new Map<string, AttributedAdvisory[]>();
  for (const root of directNodes(graph)) {
    const attributed = attributeFromRoot(graph, root, byName);
    if (attributed.length > 0) result.set(root.name, attributed);
  }
  return result;
}

const NOT_REGISTRY: ReadonlySet<string> = new Set(['workspace-link', 'file', 'git', 'tarball']);

/** A clean advisory response proves nothing for nodes without a version. */
export function advisoryCoverageByRoot(graph: DependencyGraph): Map<string, 'complete' | 'partial'> {
  const result = new Map<string, 'complete' | 'partial'>();
  for (const root of directNodes(graph)) {
    const visited = new Set<string>();
    const queue = [root];
    let complete = true;
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      if (node === undefined || visited.has(node.path)) continue;
      visited.add(node.path);
      // Workspace links and file:, git: or tarball dependencies have no
      // registry version by design. Only a version that should be known and
      // is not (no lockfile, nothing installed) leaves coverage partial.
      const outsideRegistry = node.unresolvable !== undefined && NOT_REGISTRY.has(node.unresolvable);
      if (!outsideRegistry && (node.version === null || semver.valid(node.version) === null)) complete = false;
      for (const name of node.deps) {
        const target = resolveDependency(graph, node.path, name, ['runtime', 'optional']);
        if (target !== null) {
          if (!visited.has(target.path)) queue.push(target);
        } else if (node.edges.some((edge) => edge.name === name && edge.kind === 'runtime')) {
          // A missing optional dependency (another platform's binary) is normal.
          complete = false;
        }
      }
    }
    result.set(root.name, complete ? 'complete' : 'partial');
  }
  return result;
}

/**
 * Reconstructs an `AdvisoriesByName` map from the host's already-attributed
 * scan results, for re-attributing against a different graph (a proposed
 * post-upgrade tree. See evaluateSecurityOutcome in securityOutcome.ts)
 * without a second bulk-advisory fetch. This only knows about advisories the
 * last scan actually saw somewhere in the tree. A package newly introduced by
 * the proposed upgrade and never seen before simply has no entry, same
 * caveat as the rest of this codebase's "we only flag what we can prove"
 * posture, never a reason to claim a version is safe, only a reason a
 * security outcome can come back `unknown` instead of `resolved`.
 */
export function advisoriesByNameFromRows(rows: readonly PackageRow[]): AdvisoriesByName {
  const byName = new Map<string, Advisory[]>();
  for (const row of rows) {
    for (const entry of row.advisories) {
      const existing = byName.get(entry.flaggedPackage);
      if (existing === undefined) {
        byName.set(entry.flaggedPackage, [entry.advisory]);
      } else if (!existing.some((a) => a.id === entry.advisory.id)) {
        existing.push(entry.advisory);
      }
    }
  }
  return byName;
}
