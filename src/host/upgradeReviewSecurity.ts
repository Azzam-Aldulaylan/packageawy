import { buildVulnerabilityContexts } from '../core/advisories/vulnerabilityContext.js';
import type { UpgradeProposal } from '../core/compatibility/types.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from '../core/advisories/bulk.js';
import { resolveNodeAlongPath } from '../core/advisories/securityOutcome.js';
import type { HttpClient } from '../core/registry/http.js';
import type { AttributedAdvisory, DependencyGraph } from '../core/types.js';
import { compareProposedGraphSecurityImpact } from './proposedGraphSecurityImpact.js';
import type { SecurityIdentityEvidence } from './proposedGraphSecurityImpact.js';
import { scopeUnchangedFindings } from './upgradeReviewSecurityScope.js';
import type { SecurityOutcome } from './webviewProtocol.js';

type VulnerabilityContext = NonNullable<SecurityOutcome['contexts']>[number];
type ContextPath = VulnerabilityContext['paths'][number];

/**
 * Before evidence for an unchanged finding keeps only the paths that start
 * at a target. Filtering never adds paths, so the protocol bound holds. When
 * the bounded enumeration held none, the selected path stands alone and the
 * list is marked truncated. A selected path longer than the protocol allows
 * leaves the finding counted but without path evidence.
 */
const MAX_CONTEXT_PATH_NODES = 100;

function targetContext(context: VulnerabilityContext, targetNames: ReadonlySet<string>, selected: ContextPath): VulnerabilityContext | null {
  const filtered = context.paths.filter((path) => targetNames.has(path.nodes[0]?.packageName ?? '') &&
    path.nodes.length <= MAX_CONTEXT_PATH_NODES);
  if (filtered.length === 0 && selected.nodes.length > MAX_CONTEXT_PATH_NODES) return null;
  const paths = filtered.length > 0 ? filtered : [selected];
  const roots = new Map<string, VulnerabilityContext['directRoots'][number]>();
  for (const path of paths) {
    const root = path.nodes[0];
    if (root === undefined) continue;
    const key = `${root.packageName}\u0000${root.version ?? ''}`;
    const existing = roots.get(key);
    if (existing === undefined) roots.set(key, { packageName: root.packageName, version: root.version, pathCount: 1 });
    else existing.pathCount += 1;
  }
  const { pathsTruncated: _, ...rest } = context;
  const truncated = filtered.length === 0 || context.pathsTruncated === true;
  return { ...rest, primaryPath: paths[0] ?? selected, paths,
    ...(truncated ? { pathsTruncated: true } : {}),
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
    // Fixed and introduced findings are project-wide. Unchanged findings are
    // scoped to paths that start at a target, separately in each graph.
    const scope = scopeUnchangedFindings(input.before, afterGraph, input.proposal, impact.remaining);
    const unaffectedElsewhereCount = scope.elsewhere;
    const resolvedAdvisories = impact.fixed.map((entry) => attributed(entry, true));
    const proposed = input.proposal === undefined ? {} : { proposed: { graph: afterGraph, proposal: input.proposal } };
    const contexts = buildVulnerabilityContexts({ graph: input.before,
      attributedAdvisories: resolvedAdvisories.slice(0, 500), ...proposed });
    for (const entry of scope.before) {
      if (contexts.length >= 500) break;
      const [context] = buildVulnerabilityContexts({ graph: input.before,
        attributedAdvisories: [attributed(entry.evidence, true, entry.path)], ...proposed });
      if (context === undefined) continue;
      const selected = { nodes: entry.path.map((_, index) => {
        const node = resolveNodeAlongPath(input.before, entry.path.slice(0, index + 1));
        return { packageName: node?.name ?? entry.path[index] ?? '', version: node?.version ?? null };
      }) };
      const scopedContext = targetContext(context, scope.beforeScope.targetNames, selected);
      if (scopedContext !== null) contexts.push(scopedContext);
    }
    const beforeCount = resolvedAdvisories.length + scope.before.length;
    return {
      contexts,
      status: scope.remaining.length + impact.introduced.length > 0 ? 'remains'
        : beforeCount > 0 ? 'resolved' : 'not-applicable',
      checkState: 'complete',
      resolvedAdvisories,
      remaining: scope.remaining.map((entry) => remaining(entry.evidence, entry.path)),
      introduced: impact.introduced.map((entry) => remaining(entry)),
      beforeCount,
      ...(unaffectedElsewhereCount > 0 ? { unaffectedElsewhereCount } : {}),
    };
  } catch {
    return unavailableUpgradeSecurity(!input.enabled());
  }
}
