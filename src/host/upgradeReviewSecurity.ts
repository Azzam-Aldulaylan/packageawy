import { buildVulnerabilityContexts } from '../core/advisories/vulnerabilityContext.js';
import type { UpgradeProposal } from '../core/compatibility/types.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from '../core/advisories/bulk.js';
import { resolveNodeAlongPath } from '../core/advisories/securityOutcome.js';
import type { HttpClient } from '../core/registry/http.js';
import type { AttributedAdvisory, DependencyGraph } from '../core/types.js';
import { compareProposedGraphSecurityImpact } from './proposedGraphSecurityImpact.js';
import type { SecurityIdentityEvidence } from './proposedGraphSecurityImpact.js';
import type { SecurityOutcome } from './webviewProtocol.js';

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
    const advisories = await fetchBulkAdvisories(input.client, body, input.signal);
    if (!input.enabled()) return unavailableUpgradeSecurity(true);
    const impact = compareProposedGraphSecurityImpact(
      { graph: input.before, advisoriesByName: advisories, advisories: 'complete' },
      { graph: input.after, advisoriesByName: advisories, advisories: 'complete' }
    );
    if (impact.status !== 'complete') return unavailableUpgradeSecurity();
    const attributed = (evidence: SecurityIdentityEvidence, before: boolean): AttributedAdvisory => {
      const advisory = (advisories.get(evidence.flaggedPackage) ?? []).find((entry) =>
        entry.severity === evidence.severity && entry.title === evidence.title &&
        evidence.aliases.includes(`NPM:${String(entry.id).toUpperCase()}`));
      if (advisory === undefined) throw new Error('Missing advisory evidence.');
      const path = (before ? evidence.beforePaths : evidence.afterPaths)[0] ?? [evidence.flaggedPackage];
      return { advisory, flaggedPackage: evidence.flaggedPackage,
        path,
        flaggedVersion: resolveNodeAlongPath(before ? input.before : afterGraph, path)?.version ?? null,
        patchedVersion: { status: 'unknown' } };
    };
    const remaining = (evidence: SecurityIdentityEvidence) => {
      const { flaggedVersion, ...entry } = attributed(evidence, false);
      return { ...entry, status: 'remains' as const, resolvedVersion: flaggedVersion };
    };
    const resolvedAdvisories = impact.fixed.map((entry) => attributed(entry, true));
    return {
      contexts: buildVulnerabilityContexts({ graph: input.before,
        attributedAdvisories: [...resolvedAdvisories, ...impact.remaining.map((entry) => attributed(entry, true))].slice(0, 500),
        ...(input.proposal === undefined ? {} : { proposed: { graph: input.after, proposal: input.proposal } }),
      }),
      status: impact.remaining.length + impact.introduced.length > 0 ? 'remains'
        : impact.fixed.length > 0 ? 'resolved' : 'not-applicable',
      checkState: 'complete',
      resolvedAdvisories,
      remaining: impact.remaining.map(remaining),
      introduced: impact.introduced.map(remaining),
    };
  } catch {
    return unavailableUpgradeSecurity(!input.enabled());
  }
}
