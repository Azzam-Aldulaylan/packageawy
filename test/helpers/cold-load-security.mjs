import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { parseManifest } from '../../out/core/manifest/parse.js';
import { buildDependencyGraph } from '../../out/core/lockfile/build.js';
import { directNodes } from '../../out/core/lockfile/parse.js';
import { fetchAllVersions, fetchPackument, MemoryEtagStore } from '../../out/core/registry/versions.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from '../../out/core/advisories/bulk.js';
import { enrichAdvisoriesWithGitHubIdentifiers } from '../../out/core/advisories/githubIdentifiers.js';
import { advisoryCoverageByRoot, attributeAdvisories } from '../../out/core/advisories/attribution.js';
import { attachPatchedVersions, distinctFlaggedPackages } from '../../out/core/advisories/remediation.js';
import { worstSeverity, resolveUpgradeTarget } from '../../out/core/advisories/aggregate.js';
import { runNpmAudit, mapFixAvailableToDirectDependencies } from '../../out/core/audit/npmAudit.js';
import { resolveUpgradeCandidate } from '../../out/core/upgrade/candidate.js';
import { computeGraphHygieneFindings } from '../../out/core/hygiene/index.js';

export const PUBLIC = 'https://registry.npmjs.org/';
export const PACKUMENT_ONLY = 'https://registry.fixture.invalid/';
const recorded = JSON.parse(readFileSync(new URL('../fixtures/cold-load-security.json', import.meta.url), 'utf8'));
export const securityOptions = {
  root: '/fixture', registry: PUBLIC,
  manifestText: JSON.stringify(recorded.manifest), lockfileText: JSON.stringify(recorded.lockfile),
};
const json = value => ({ status: 200, headers: {}, body: JSON.stringify(value), wireBytes: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));

export function securityClient(timing = 'early') {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (url.startsWith('https://api.github.com/')) return json(recorded.github);
      const [name, route] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
      const packument = recorded.registry[name];
      assert.ok(packument, `recorded package: ${url}`);
      if (route === 'latest' && timing === 'early') await tick();
      const body = route === undefined ? packument : packument.versions[route === 'latest' ? packument['dist-tags'].latest : route];
      assert.ok(body, `recorded route: ${url}`);
      return json(body);
    },
    async post(_url, body) {
      if (timing === 'late') await tick();
      const requested = JSON.parse(body);
      // The same response records serve installed-tree and offered-version
      // checks. npm omits advisories that match none of the requested versions.
      return json(Object.fromEntries(Object.entries(recorded.bulk).filter(([name, advisories]) =>
        requested[name]?.some(version => advisories.some(a => semver.satisfies(version, a.vulnerable_versions))))));
    },
    async run() { return { stdout: JSON.stringify(recorded.audit), exitCode: 1 }; },
  };
}

/**
 * Reference composition from 0f0a515 for this resolved npm fixture. It runs
 * version resolution without exactPinEligible, then attribution, patched
 * versions, audit and fallback in order. It never calls buildPackageRows or
 * prefetches from the bulk response, so A1 and A2 cannot change its schedule.
 */
export async function packumentSecurityReference(client = securityClient()) {
  const manifest = parseManifest(securityOptions.manifestText);
  const graph = buildDependencyGraph({ ...securityOptions, manifest, packageManager: 'npm' });
  const roots = directNodes(graph);
  const coverage = advisoryCoverageByRoot(graph);
  const store = new MemoryEtagStore();
  const packuments = new Map();
  const load = name => {
    if (!packuments.has(name)) packuments.set(name, fetchPackument(client, store, PUBLIC, name));
    return packuments.get(name);
  };
  const versions = await fetchAllVersions({ client, store, registry: PUBLIC, packumentLoader: load },
    roots.map(node => ({ name: node.name, range: node.range, installed: node.version })));
  assert.ok(versions.every(result => result.ok));
  const bulk = await fetchBulkAdvisories(client, buildBulkRequestBody(graph));
  const enriched = await enrichAdvisoriesWithGitHubIdentifiers(client, store, bulk);
  let attributed = attributeAdvisories(graph, enriched);
  const patched = new Map();
  for (const name of distinctFlaggedPackages(attributed)) patched.set(name, (await load(name)).versions);
  attributed = attachPatchedVersions(attributed, patched);
  const fixes = mapFixAvailableToDirectDependencies(await runNpmAudit(client, securityOptions.root), new Set(roots.map(node => node.name)));
  const rows = [];
  for (const [index, node] of roots.entries()) {
    const info = versions[index].value;
    const advisories = attributed.get(node.name) ?? [];
    const fixAvailable = fixes.get(node.name);
    const needsFallback = advisories.some(a => a.path.length === 1) && (fixAvailable === undefined || fixAvailable === true);
    const securityTarget = resolveUpgradeTarget({ installed: node.version, range: node.range, advisories,
      availableVersions: needsFallback ? (await load(node.name)).versions : [],
      ...(fixAvailable === undefined ? {} : { fixAvailable }) });
    const candidate = resolveUpgradeCandidate({ securityTarget, current: node.version, wanted: info.wanted, latest: info.latest });
    rows.push({ name: node.name, current: node.version, wanted: info.wanted, latest: info.latest,
      dev: node.dev, optional: false, range: node.range, advisories, advisoryCoverage: coverage.get(node.name),
      worstSeverity: worstSeverity(advisories), upgradeTo: candidate?.target ?? null, upgradeReason: candidate?.reason ?? null,
      ...Object.fromEntries(['description', 'license', 'deprecated'].filter(key => info[key] !== undefined).map(key => [key, info[key]])) });
  }
  return { rows, availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    hygieneFindings: computeGraphHygieneFindings(rows) };
}
