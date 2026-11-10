import { buildVulnerabilityContexts } from '../core/advisories/vulnerabilityContext.js';
import type { UpgradeProposal } from '../core/compatibility/types.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from '../core/advisories/bulk.js';
import { resolveNodeAlongPath } from '../core/advisories/securityOutcome.js';
import type { HttpClient } from '../core/registry/http.js';
import type { AttributedAdvisory, DependencyGraph } from '../core/types.js';
import { compareProposedGraphSecurityImpact } from './proposedGraphSecurityImpact.js';
import type { SecurityIdentityEvidence } from './proposedGraphSecurityImpact.js';
import { scopeRemainingFindings } from './upgradeReviewSecurityScope.js';
import type { UpgradeGraphScope } from './upgradeReviewSecurityScope.js';
import type { SecurityOutcome } from './webviewProtocol.js';

type VulnerabilityContext = NonNullable<SecurityOutcome['contexts']>[number];

/**
 * Before evidence for an unchanged finding keeps only the paths through a
 * changed package, always including the selected one. A finding with none
 * has no Before evidence to show.
 */
function scopedContext(context: VulnerabilityContext, scope: UpgradeGraphScope, graph: DependencyGraph,
  selected: string[] | null): VulnerabilityContext | null {
  const names = (path: VulnerabilityContext['paths'][number]) => path.nodes.map((node) => node.packageName);
  const paths = context.paths.filter((path) => scope.passesThroughChange(names(path)));
  if (selected !== null && !paths.some((path) => names(path).join('\u0000') === selected.join('\u0000'))) {
    const nodes = selected.map((_, index) => {
      const node = resolveNodeAlongPath(graph, selected.slice(0, index + 1));
      return { packageName: node?.name ?? selected[index] ?? '', version: node?.version ?? null };
    });
    paths.unshift({ nodes });
  }
  const primaryPath = paths[0];
  if (primaryPath === undefined) return null;
  const roots = new Map<string, VulnerabilityContext['directRoots'][number]>();
  for (const path of paths) {
    const root = path.nodes[0];
    if (root === undefined) continue;
    const key = `${root.packageName}\u0000${root.version ?? ''}`;
    const existing = roots.get(key);
    if (existing === undefined) roots.set(key, { packageName: root.packageName, version: root.version, pathCount: 1 });
    else existing.pathCount += 1;
  }
  return { ...context, primaryPath, paths,
    directRoots: [...roots.values()].sort((left, right) => left.packageName.localeCompare(right.packageName)) };
}

export function unavailableUpgradeSecurity(off = false): SecurityOutcome {
  return { status: off ? 'not-applicable' : 'unknown', checkState: off ? 'off' : 'unavailable',
    resolvedAdvisories: [], remaining: [], introduced: [] };
}

/** A fresh union request covers versions which the installed dashboard never queried. */
export async function auditUpgradeReview(input: {
  before: DependencyGraph;
  proposal?: UpgradeProposal;
  after: DependencyGraph | undefined;
  client: HttpClient;
  enabled: () => boolean;
  signal: AbortSignal;
}): Promise<SecurityOutcome> {
  if (!input.enabled()) return unavailableUpgradeSecurity(true);
  if (input.after === undefined || input.signal.aborted) return unavailableUpgradeSecurity();
  const afterGraph = input.after;
  try {
    const body = buildBulkRequestBody(input.before);
    for (const [name, versions] of Object.entries(buildBulkRequestBody(input.after))) {
      body[name] = [...new Set([...(body[name] ?? []), ...versions])];
    }
    // Read the setting at dispatch, including after resolver work has finished.
    if (!input.enabled()) return unavailableUpgradeSecurity(true);
    const advisories = await fetchBulkAdvisories(input.client, body, input.signal, input.enabled);
    if (!input.enabled()) return unavailableUpgradeSecurity(true);
    const impact = compareProposedGraphSecurityImpact(
      { graph: input.before, advisoriesByName: advisories, advisories: 'complete' },
      { graph: input.after, advisoriesByName: advisories, advisories: 'complete' }
    );
    if (impact.status !== 'complete') return unavailableUpgradeSecurity();
    const attributed = (evidence: SecurityIdentityEvidence, before: boolean, scopedPath?: string[] | null): AttributedAdvisory => {
      const advisory = (advisories.get(evidence.flaggedPackage) ?? []).find((entry) =>
        entry.severity === evidence.severity && entry.title === evidence.title &&
        evidence.aliases.includes(`NPM:${String(entry.id).toUpperCase()}`));
      if (advisory === undefined) throw new Error('Missing advisory evidence.');
      const path = scopedPath ?? (before ? evidence.beforePaths : evidence.afterPaths)[0] ?? [evidence.flaggedPackage];
      return { advisory, flaggedPackage: evidence.flaggedPackage,
        path,
        flaggedVersion: resolveNodeAlongPath(before ? input.before : afterGraph, path)?.version ?? null,
        patchedVersion: { status: 'unknown' } };
    };
    const remaining = (evidence: SecurityIdentityEvidence, scopedPath?: string[]) => {
      const { flaggedVersion, ...entry } = attributed(evidence, false, scopedPath);
      return { ...entry, status: 'remains' as const, resolvedVersion: flaggedVersion };
    };
    // Fixed and introduced findings are project-wide. Unchanged findings count
    // only when the proposed tree still reaches them through a changed package.
    const { scoped, elsewhere: unaffectedElsewhereCount, beforeScope } =
      scopeRemainingFindings(input.before, afterGraph, input.proposal, impact.remaining);
    const resolvedAdvisories = impact.fixed.map((entry) => attributed(entry, true));
    const proposed = input.proposal === undefined ? {} : { proposed: { graph: afterGraph, proposal: input.proposal } };
    const resolvedContexts = buildVulnerabilityContexts({ graph: input.before,
      attributedAdvisories: resolvedAdvisories.slice(0, 500), ...proposed });
    // Before evidence for an unchanged finding lists only the paths through a changed package.
    const remainingContexts = buildVulnerabilityContexts({ graph: input.before,
      attributedAdvisories: scoped.map((entry) => attributed(entry.evidence, true, entry.beforePath))
        .slice(0, Math.max(0, 500 - resolvedContexts.length)), ...proposed,
    }).flatMap((context) => {
      if (beforeScope === null) return [context];
      const selected = scoped.find((entry) => entry.evidence.flaggedPackage === context.flaggedPackage &&
        entry.beforeVersion === context.flaggedVersion && entry.beforePath !== null &&
        attributed(entry.evidence, true, entry.beforePath).advisory.id === context.advisory.id)?.beforePath ?? null;
      const result = scopedContext(context, beforeScope, input.before, selected);
      return result === null ? [] : [result];
    });
    return {
      contexts: [...resolvedContexts, ...remainingContexts].slice(0, 500),
      status: scoped.length + impact.introduced.length > 0 ? 'remains'
        : impact.fixed.length > 0 ? 'resolved' : 'not-applicable',
      checkState: 'complete',
      resolvedAdvisories,
      remaining: scoped.map((entry) => remaining(entry.evidence, entry.afterPath)),
      introduced: impact.introduced.map((entry) => remaining(entry)),
      ...(unaffectedElsewhereCount > 0 ? { unaffectedElsewhereCount } : {}),
    };
  } catch {
    return unavailableUpgradeSecurity(!input.enabled());
  }
}
