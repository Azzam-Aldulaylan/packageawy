/**
 * Which unchanged vulnerabilities belong to an upgrade review.
 *
 * Fixed and introduced findings are project-wide because the upgrade caused
 * them. A finding present before and after belongs to the review only when,
 * in the proposed tree, its vulnerable package is still reached through
 * something the upgrade changes: an upgraded manifest dependency, or an
 * installed package whose resolved version the proposed tree changes. Every
 * other finding is untouched by this upgrade and is reported only as a count.
 */

import { resolveNodeAlongPath } from '../core/advisories/securityOutcome.js';
import type { UpgradeProposal } from '../core/compatibility/types.js';
import type { DependencyGraph, DependencyNode } from '../core/types.js';
import type { SecurityIdentityEvidence } from './proposedGraphSecurityImpact.js';

interface Step {
  nodeId: string;
  /** True once the walk has passed through a changed package. */
  through: boolean;
}

export interface UpgradeGraphScope {
  /** Node ids reached through a changed package. */
  affected: ReadonlySet<string>;
  /** Shortest install path, as names, that reaches the node through a changed package. */
  pathTo(nodeId: string): string[] | null;
  /** Whether an install path, as names, passes through a changed package. */
  passesThroughChange(path: readonly string[]): boolean;
}

function identity(node: DependencyNode): string | null {
  return node.version === null ? null : `${node.registryName ?? node.name}@${node.version}`;
}

/**
 * Forward edges, with peer relationships separated. npm gives a declared
 * dependency precedence over a peer of the same name. pnpm records a
 * snapshot's resolved peers as both a runtime and a peer edge, so there any
 * edge whose target is also a peer target is a peer.
 */
function forwardEdges(graph: DependencyGraph, node: DependencyNode): { target: string; peer: boolean }[] {
  const result = new Map<string, boolean>();
  for (const edge of node.edges) {
    if (edge.targetNodeId === null) continue;
    const peer = edge.kind === 'peer';
    const previous = result.get(edge.targetNodeId);
    result.set(edge.targetNodeId, previous === undefined ? peer
      : graph.packageManager === 'pnpm' ? previous || peer : previous && peer);
  }
  return [...result].map(([target, peer]) => ({ target, peer }));
}

/**
 * Whether a peer target is installed by something other than its peer
 * dependents: it is direct, or the installed tree reaches it without any
 * peer edge into it. Packages reached through other peers still count as
 * installers, while a dependency of the peer itself does not.
 */
function independentInstallation(graph: DependencyGraph): (target: string) => boolean {
  const cache = new Map<string, boolean>();
  return (target) => {
    const cached = cache.get(target);
    if (cached !== undefined) return cached;
    let found = graph.nodes.get(target)?.direct === true;
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const node of graph.nodes.values()) {
      if (node.direct && node.path !== target) { seen.add(node.path); queue.push(node.path); }
    }
    for (let head = 0; head < queue.length && !found; head += 1) {
      const node = graph.nodes.get(queue[head] ?? '');
      if (node === undefined) continue;
      for (const edge of forwardEdges(graph, node)) {
        if (edge.target === target) {
          if (!edge.peer) { found = true; break; }
          continue;
        }
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
    cache.set(target, found);
    return found;
  };
}

/**
 * A package instance changed when the other graph holds a different version
 * at the same install location, or holds no copy of that version anywhere
 * when the location itself is new.
 */
function changedInstances(graph: DependencyGraph, other: DependencyGraph): Set<string> {
  const otherIdentities = new Set<string>();
  for (const node of other.nodes.values()) {
    const id = identity(node);
    if (id !== null) otherIdentities.add(id);
  }
  const changed = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.version === null) continue;
    const counterpart = other.nodes.get(node.path);
    const id = identity(node);
    if (counterpart !== undefined ? counterpart.version !== node.version : id !== null && !otherIdentities.has(id)) {
      changed.add(node.path);
    }
  }
  return changed;
}

/**
 * One breadth-first walk over (node, passed a changed package) states. Peers
 * are followed only when nothing else installs them, matching how
 * auto-installed peers exist because of their dependents while an
 * independently installed framework does not.
 */
export function upgradeGraphScope(graph: DependencyGraph, other: DependencyGraph, targetNames: ReadonlySet<string>): UpgradeGraphScope {
  const seeds = changedInstances(graph, other);
  for (const node of graph.nodes.values()) {
    if (node.direct && targetNames.has(node.name)) seeds.add(node.path);
  }
  const independent = independentInstallation(graph);
  // A changed package is always followed. An unchanged peer is followed only
  // when nothing else installs it.
  const follows = (edge: { target: string; peer: boolean }): boolean =>
    !edge.peer || seeds.has(edge.target) || !independent(edge.target);
  const key = (step: Step): string => `${step.through ? '1' : '0'}\u0000${step.nodeId}`;
  const previous = new Map<string, Step | null>();
  const queue: Step[] = [];
  for (const node of graph.nodes.values()) {
    if (!node.direct) continue;
    const step = { nodeId: node.path, through: seeds.has(node.path) };
    if (previous.has(key(step))) continue;
    previous.set(key(step), null);
    queue.push(step);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const step = queue[head];
    const node = step === undefined ? undefined : graph.nodes.get(step.nodeId);
    if (step === undefined || node === undefined) continue;
    for (const edge of forwardEdges(graph, node)) {
      if (!follows(edge)) continue;
      const next = { nodeId: edge.target, through: step.through || seeds.has(edge.target) };
      if (previous.has(key(next))) continue;
      previous.set(key(next), step);
      queue.push(next);
    }
  }
  const affected = new Set<string>();
  for (const step of queue) if (step.through) affected.add(step.nodeId);
  return {
    affected,
    pathTo(nodeId) {
      let step: Step | null | undefined = { nodeId, through: true };
      if (!previous.has(key(step))) return null;
      const names: string[] = [];
      while (step !== null && step !== undefined) {
        names.push(graph.nodes.get(step.nodeId)?.name ?? step.nodeId);
        step = previous.get(key(step));
      }
      return names.reverse();
    },
    passesThroughChange(path) {
      let through = false;
      let parent: DependencyNode | null = null;
      for (let length = 1; length <= path.length; length += 1) {
        const node = resolveNodeAlongPath(graph, path.slice(0, length));
        if (node === null) return false;
        if (parent !== null) {
          const edge = forwardEdges(graph, parent).find((entry) => entry.target === node.path);
          if (edge === undefined || !follows(edge)) return false;
        }
        through ||= seeds.has(node.path);
        parent = node;
      }
      return through;
    },
  };
}

export interface ScopedFinding {
  evidence: SecurityIdentityEvidence;
  /** Path in the proposed tree through a changed package. */
  afterPath: string[];
  afterVersion: string;
  /** Matching path in the installed tree, when the finding was already reached through the target before. */
  beforePath: string[] | null;
  beforeVersion: string | null;
}

function scopedInstance(graph: DependencyGraph, scope: UpgradeGraphScope, flaggedPackage: string, versions: readonly string[]):
  { path: string[]; version: string } | null {
  let best: { path: string[]; version: string } | null = null;
  for (const nodeId of scope.affected) {
    const node = graph.nodes.get(nodeId);
    if (node === undefined || node.version === null || (node.registryName ?? node.name) !== flaggedPackage ||
        !versions.includes(node.version)) continue;
    const path = scope.pathTo(nodeId);
    if (path !== null && (best === null || path.length < best.path.length ||
        (path.length === best.path.length && path.join('\u0000') < best.path.join('\u0000')))) {
      best = { path, version: node.version };
    }
  }
  return best;
}

/** Splits unchanged findings into those this upgrade touches and a count of the rest. */
export function scopeRemainingFindings(
  before: DependencyGraph,
  after: DependencyGraph,
  proposal: UpgradeProposal | undefined,
  remaining: readonly SecurityIdentityEvidence[]
): { scoped: ScopedFinding[]; elsewhere: number; beforeScope: UpgradeGraphScope | null } {
  if (remaining.length === 0) return { scoped: [], elsewhere: 0, beforeScope: null };
  const targetNames = new Set((proposal?.changes ?? []).map((change) => change.packageName));
  if (proposal !== undefined) targetNames.add(proposal.requested.packageName);
  const beforeScope = upgradeGraphScope(before, after, targetNames);
  const afterScope = upgradeGraphScope(after, before, targetNames);
  const scoped: ScopedFinding[] = [];
  for (const evidence of remaining) {
    const afterInstance = scopedInstance(after, afterScope, evidence.flaggedPackage, evidence.afterVersions);
    if (afterInstance === null) continue;
    const beforeInstance = scopedInstance(before, beforeScope, evidence.flaggedPackage, evidence.beforeVersions);
    scoped.push({ evidence, afterPath: afterInstance.path, afterVersion: afterInstance.version,
      beforePath: beforeInstance?.path ?? null, beforeVersion: beforeInstance?.version ?? null });
  }
  return { scoped, elsewhere: remaining.length - scoped.length, beforeScope };
}
