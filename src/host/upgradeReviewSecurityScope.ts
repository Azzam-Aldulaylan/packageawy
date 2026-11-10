/**
 * Which findings belong to an upgrade review.
 *
 * The targets are the direct dependencies the review upgrades: the requested
 * package and every package in a bulk or coordinated plan. A finding is in
 * scope for a graph when at least one dependency path to it starts at a
 * target. Peer edges count where the graph models them. Before and Remaining
 * are each computed from their own graph.
 */

import type { UpgradeProposal } from '../core/compatibility/types.js';
import type { DependencyGraph } from '../core/types.js';
import type { SecurityIdentityEvidence } from './proposedGraphSecurityImpact.js';

export interface TargetScope {
  targetNames: ReadonlySet<string>;
  /** Shortest path, as names, from a target to the flagged package at one of the versions. */
  pathTo(flaggedPackage: string, versions: readonly string[]): { path: string[]; version: string } | null;
}

export function upgradeTargetNames(proposal: UpgradeProposal | undefined, graph: DependencyGraph): Set<string> {
  if (proposal === undefined) {
    return new Set([...graph.nodes.values()].filter((node) => node.direct).map((node) => node.name));
  }
  return new Set([proposal.requested.packageName, ...proposal.changes.map((change) => change.packageName)]);
}

/** One breadth-first walk from the target direct dependencies over every resolved edge. */
export function targetScope(graph: DependencyGraph, targetNames: ReadonlySet<string>): TargetScope {
  const previous = new Map<string, string | null>();
  const queue: string[] = [];
  for (const node of graph.nodes.values()) {
    if (node.direct && targetNames.has(node.name) && !previous.has(node.path)) {
      previous.set(node.path, null);
      queue.push(node.path);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const nodeId = queue[head] ?? '';
    for (const edge of graph.nodes.get(nodeId)?.edges ?? []) {
      if (edge.targetNodeId === null || previous.has(edge.targetNodeId)) continue;
      previous.set(edge.targetNodeId, nodeId);
      queue.push(edge.targetNodeId);
    }
  }
  return {
    targetNames,
    pathTo(flaggedPackage, versions) {
      // Breadth-first order makes the first match the shortest path.
      for (const nodeId of queue) {
        const node = graph.nodes.get(nodeId);
        if (node === undefined || node.version === null || (node.registryName ?? node.name) !== flaggedPackage ||
            !versions.includes(node.version)) continue;
        const path: string[] = [];
        for (let step: string | null | undefined = nodeId; step !== null && step !== undefined; step = previous.get(step)) {
          path.push(graph.nodes.get(step)?.name ?? step);
        }
        return { path: path.reverse(), version: node.version };
      }
      return null;
    },
  };
}

export interface ScopedFinding {
  evidence: SecurityIdentityEvidence;
  path: string[];
  version: string;
}

export interface ReviewScope {
  /** Findings present before and after, reached from a target in the installed tree. */
  before: ScopedFinding[];
  /** Findings present before and after, reached from a target in the proposed tree. */
  remaining: ScopedFinding[];
  /** Findings present before and after that are in neither list. */
  elsewhere: number;
}

function scoped(scope: TargetScope, evidence: SecurityIdentityEvidence, versions: readonly string[]): ScopedFinding | null {
  const found = scope.pathTo(evidence.flaggedPackage, versions);
  return found === null ? null : { evidence, ...found };
}

export function scopeUnchangedFindings(
  before: DependencyGraph,
  after: DependencyGraph,
  proposal: UpgradeProposal | undefined,
  unchanged: readonly SecurityIdentityEvidence[]
): ReviewScope & { beforeScope: TargetScope } {
  const targetNames = upgradeTargetNames(proposal, before);
  const beforeScope = targetScope(before, targetNames);
  const afterScope = targetScope(after, targetNames);
  const result: ReviewScope = { before: [], remaining: [], elsewhere: 0 };
  for (const evidence of unchanged) {
    const inBefore = scoped(beforeScope, evidence, evidence.beforeVersions);
    const inAfter = scoped(afterScope, evidence, evidence.afterVersions);
    if (inBefore !== null) result.before.push(inBefore);
    if (inAfter !== null) result.remaining.push(inAfter);
    if (inBefore === null && inAfter === null) result.elsewhere += 1;
  }
  return { ...result, beforeScope };
}
