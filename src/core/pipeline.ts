/**
 * The composition root for the table's data.
 *
 * Chains the manifest and lockfile graph, version fetching, and the advisory
 * stages (bulk advisories, attribution, severity, fixAvailable) into
 * PackageRow[]. Each stage is already written to fail per-item rather than
 * per-batch. This file's job is to keep that property end to end, so that a
 * dead registry, an unreachable npm, or a single 404 degrades one column
 * instead of emptying the table.
 *
 * Nothing here may import 'vscode'. See types.ts.
 */

import type { AuditRunner } from './audit/npmAudit.js';
import { runNpmAudit, mapFixAvailableToDirectDependencies } from './audit/npmAudit.js';
import { worstSeverity, resolveUpgradeTarget } from './advisories/aggregate.js';
import { advisoryCoverageByRoot, attributeAdvisories } from './advisories/attribution.js';
import { attachPatchedVersions, distinctFlaggedPackages } from './advisories/remediation.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from './advisories/bulk.js';
import { enrichAdvisoriesWithGitHubIdentifiers, GITHUB_ADVISORIES_API } from './advisories/githubIdentifiers.js';
import { directNodes } from './lockfile/parse.js';
import { buildDependencyGraph } from './lockfile/build.js';
import { npmAlias } from './lockfile/identity.js';
import { computeGraphHygieneFindings } from './hygiene/index.js';
import type { DependencyFinding } from './hygiene/index.js';
import { isCatalogSpecifier, parseManifest } from './manifest/parse.js';
import type { PerformanceRecorder } from './performance/measurement.js';
import { NOOP_PERFORMANCE_RECORDER } from './performance/measurement.js';
import type { HttpClient } from './registry/http.js';
import { FetchError } from './registry/http.js';
import type { EtagStore, VersionRequest } from './registry/versions.js';
import { fetchAllVersions, fetchPackument } from './registry/versions.js';
import type { PackumentDoc } from './registry/versions.js';
import { DEFAULT_CONCURRENCY, runPool } from './registry/pool.js';
import { registryForPackage } from './registry/npmrc.js';
import { resolveUpgradeCandidate } from './upgrade/candidate.js';
import type { Advisory, AttributedAdvisory, FixAvailable, PackageRow, ScanDataAvailability, VersionInfo } from './types.js';
import type { PackageManagerKind, ResolvedRegistry } from './types.js';

export interface BuildPackageRowsOptions {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  /** Raw lockfile text, or null when no lockfile exists. */
  lockfileText: string | null;
  packageManager?: PackageManagerKind;
  importerId?: string;
  /** Resolved from .npmrc: version data only. Advisories always go to npm. */
  registry: string;
  /**
   * Full .npmrc routing, including `@scope:registry` overrides. When given,
   * every registry metadata request in the scan goes to the package's own
   * registry, so scoped names never reach the default registry.
   */
  resolvedRegistry?: ResolvedRegistry;
  httpClient: HttpClient;
  etagStore: EtagStore;
  /** Omit entirely to skip the optional `npm audit` enrichment. */
  auditRunner?: AuditRunner;
  /**
   * Defaults to true so an accidentally omitted npm runner remains visible as
   * degraded coverage. Set false only when npm audit is genuinely not
   * applicable, currently the pnpm host path.
   */
  auditUnavailableWhenOmitted?: boolean;
  /**
   * Defaults to true. False means the project turned the public advisory
   * check off: no package names go to the bulk advisory endpoint or GitHub,
   * npm audit does not run, and availability reports advisories as 'off'.
   */
  publicAdvisoryCheck?: boolean;
  /** Re-read immediately before each advisory chunk is dispatched. */
  publicAdvisoryCheckEnabled?: () => boolean;
  concurrency?: number;
  signal?: AbortSignal;
  /** Local diagnostics only. The default recorder is a zero-allocation no-op. */
  performance?: PerformanceRecorder;
  /** Real, observable progress only. Never a fabricated percentage. */
  onProgress?: (progress: ScanProgress) => void;
}

export type ScanProgressStage =
  | 'manifest'
  | 'dependency-graph'
  | 'versions'
  | 'advisories'
  | 'patched-versions'
  | 'npm-audit'
  | 'rows';

export interface ScanProgress {
  stage: ScanProgressStage;
  completed?: number;
  total?: number;
}

export interface BuildPackageRowsResult {
  rows: PackageRow[];
  /** Completeness of the update/advisory facts represented by these rows. */
  availability: ScanDataAvailability;
  /** Set when the bulk fetch failed outright. Rows are still returned, without advisory data. */
  advisoriesError?: FetchError;
  /** True when no runner was given, or audit failed / returned unparseable output. */
  auditUnavailable?: boolean;
  /**
   * Deprecated findings: deterministic, and
   * therefore cheap enough to compute on every scan (see
   * src/core/hygiene/index.ts). Likely-unused findings are never included
   * here. They require an on-demand workspace scan (see src/core/usage/).
   */
  hygieneFindings: DependencyFinding[];
}

/**
 * Cancellation is not a degraded-data case like a dead registry or missing
 * npm: it means the caller no longer wants a result at all. Every other
 * failure here is swallowed into `advisoriesError`/`auditUnavailable` so rows
 * still render. An abort instead stops the whole call, checked at each stage
 * boundary so a signal firing mid-run doesn't let later stages keep going and
 * hand back rows built from a mix of fresh and abandoned work.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new FetchError('CANCELLED', 'buildPackageRows was aborted');
  }
}

function instrumentEtagStore(store: EtagStore, recorder: PerformanceRecorder): EtagStore {
  if (!recorder.enabled) return store;
  return {
    get(key) {
      const value = store.get(key);
      if (value !== undefined) recorder.increment('ETag cache hits');
      return value;
    },
    set(key, value) {
      store.set(key, value);
    },
  };
}

function instrumentHttpClient(client: HttpClient, recorder: PerformanceRecorder): HttpClient {
  if (!recorder.enabled) return client;
  return {
    async get(url, options) {
      const isGitHubAdvisory =
        url.startsWith(`${GITHUB_ADVISORIES_API}/`) || url.startsWith(`${GITHUB_ADVISORIES_API}?`);
      recorder.increment(isGitHubAdvisory ? 'GitHub advisory requests' : 'registry requests');
      if (!isGitHubAdvisory) recorder.increment(url.endsWith('/latest') ? '/latest requests' : 'packument requests');
      const response = await client.get(url, options);
      recorder.increment(isGitHubAdvisory ? 'GitHub advisory response wire bytes' : 'registry response wire bytes', response.wireBytes);
      if (response.status === 304) recorder.increment('304 responses');
      return response;
    },
    async post(url, body, options) {
      recorder.increment('registry requests');
      recorder.increment('bulk advisory requests');
      recorder.increment('bulk advisory request bytes', Buffer.byteLength(body));
      const response = await client.post(url, body, options);
      recorder.increment('registry response wire bytes', response.wireBytes);
      if (response.status === 304) recorder.increment('304 responses');
      return response;
    },
  };
}

export async function buildPackageRows(
  options: BuildPackageRowsOptions
): Promise<BuildPackageRowsResult> {
  const { root, manifestText, lockfileText, registry, signal } = options;
  const recorder = options.performance ?? NOOP_PERFORMANCE_RECORDER;
  const httpClient = instrumentHttpClient(options.httpClient, recorder);
  const etagStore = instrumentEtagStore(options.etagStore, recorder);
  const resolvedRegistry = options.resolvedRegistry;
  const registryFor = (name: string): string =>
    resolvedRegistry === undefined ? registry : registryForPackage(resolvedRegistry, name);
  throwIfAborted(signal);

  options.onProgress?.({ stage: 'manifest' });
  const endManifest = recorder.start('manifest parse');
  const manifest = parseManifest(manifestText);
  endManifest({ 'direct dependencies': manifest.dependencies.length });
  recorder.setMetadata('direct dependencies', manifest.dependencies.length);

  options.onProgress?.({ stage: 'dependency-graph' });
  const graph = buildDependencyGraph({
    root,
    manifest,
    lockfileText,
    packageManager: options.packageManager ?? 'npm',
    ...(options.importerId === undefined ? {} : { importerId: options.importerId }),
    performance: recorder,
  });
  const roots = directNodes(graph);
  const advisoryCoverage = advisoryCoverageByRoot(graph);
  recorder.setMetadata('graph nodes', graph.nodes.size);

  const packumentPromises = new Map<string, Promise<PackumentDoc>>();
  const loadPackument = (
    name: string,
    reason: 'version resolution' | 'patched version' | 'upgrade-target fallback',
    requestSignal?: AbortSignal
  ): Promise<PackumentDoc> => {
    const cached = packumentPromises.get(name);
    if (cached !== undefined) {
      recorder.increment('scan-local packument hits');
      return cached;
    }
    recorder.increment(`packument requests for ${reason}`);
    const pending = fetchPackument(httpClient, etagStore, registryFor(name), name, requestSignal);
    packumentPromises.set(name, pending);
    return pending;
  };

  // npm audit is subprocess-bound and independent of registry metadata. Start
  // it as soon as the normalized graph provides the direct-name allow-list,
  // then consume its optional fixAvailable enrichment at the original stage.
  const advisoryEnabled = (): boolean => options.publicAdvisoryCheck !== false && (options.publicAdvisoryCheckEnabled?.() ?? true);
  const advisoryCheckOff = !advisoryEnabled();
  const auditPromise: Promise<{ fixes: Map<string, FixAvailable>; unavailable: boolean }> = (() => {
    // npm audit sends the same inventory to the registry, so it follows the advisory setting.
    if (advisoryCheckOff) return Promise.resolve({ fixes: new Map(), unavailable: false });
    if (options.auditRunner === undefined) {
      return Promise.resolve({
        fixes: new Map(),
        unavailable: options.auditUnavailableWhenOmitted ?? true,
      });
    }
    options.onProgress?.({ stage: 'npm-audit' });
    const endAudit = recorder.start('npm audit');
    recorder.increment('package-manager subprocesses');
    return runNpmAudit(options.auditRunner, root, signal)
      .then((vulnerabilities) => ({
        fixes: mapFixAvailableToDirectDependencies(vulnerabilities, new Set(roots.map((node) => node.name))),
        unavailable: false,
      }))
      .catch(() => ({ fixes: new Map<string, FixAvailable>(), unavailable: true }))
      .finally(() => {
        endAudit();
      });
  })();

  // The bulk advisory request depends only on the normalized graph. Start it
  // alongside version metadata instead of placing its network latency behind
  // every /latest request. This adds one bounded request (to npm's advisory
  // endpoint) while the registry pool is active. Patched-version work still
  // waits for attribution and therefore cannot amplify that overlap.
  let advisoryRequestSettled = advisoryCheckOff;
  if (!advisoryCheckOff) options.onProgress?.({ stage: 'advisories' });
  const advisoryPromise: Promise<{ advisoriesByName: Map<string, Advisory[]>; advisoriesError?: FetchError }> = (async () => {
    if (advisoryCheckOff) return { advisoriesByName: new Map<string, Advisory[]>() };
    const bulkRequestBody = buildBulkRequestBody(graph);
    const endAdvisoryRequest = recorder.start('bulk advisory request');
    let advisoriesByName = new Map<string, Advisory[]>();
    let advisoriesError: FetchError | undefined;
    try {
      const npmAdvisories = await fetchBulkAdvisories(httpClient, bulkRequestBody, signal, advisoryEnabled);
      advisoriesByName = await enrichAdvisoriesWithGitHubIdentifiers(httpClient, etagStore, npmAdvisories, signal);
    } catch (cause) {
      advisoriesError =
        cause instanceof FetchError
          ? cause
          : new FetchError('NETWORK', cause instanceof Error ? cause.message : String(cause));
    } finally {
      advisoryRequestSettled = true;
    }
    endAdvisoryRequest({ packages: advisoriesByName.size });
    recorder.setMetadata('advisory packages', advisoriesByName.size);
    return advisoriesError === undefined ? { advisoriesByName } : { advisoriesByName, advisoriesError };
  })();

  // --- versions -------------------------------------------------------
  // Unresolvable nodes (workspace links, file:/git: specifiers, no lockfile)
  // have no registry entry. Asking would be a guaranteed 404 presented to the
  // user as an error on a perfectly healthy dependency.
  const versionNodes = roots.filter((node) => node.unresolvable === undefined ||
    (node.unresolvable === 'alias' && node.registryName !== undefined && node.version !== null));
  const requests: VersionRequest[] = versionNodes.map((node) => ({
    name: node.registryName ?? node.name,
    range: npmAlias(node.range)?.range ?? node.range,
    installed: node.version,
  }));

  const fetchOptions: Parameters<typeof fetchAllVersions>[0] = {
    client: httpClient,
    store: etagStore,
    registry,
    registryFor,
    packumentLoader: (name, requestSignal) => loadPackument(name, 'version resolution', requestSignal),
  };
  if (options.concurrency !== undefined) fetchOptions.limit = options.concurrency;
  if (signal !== undefined) fetchOptions.signal = signal;
  let resolvedVersions = 0;
  fetchOptions.onSettled = () => {
    resolvedVersions += 1;
    options.onProgress?.({ stage: 'versions', completed: resolvedVersions, total: requests.length });
  };

  options.onProgress?.({ stage: 'versions', completed: 0, total: requests.length });
  const endVersions = recorder.start('version metadata resolution');
  const settled = await fetchAllVersions(fetchOptions, requests);
  endVersions({ requests: requests.length });
  const versionsByName = new Map<string, VersionInfo>();
  const unavailableUpdatePackages: string[] = [];
  const signInPackagesByHost = new Map<string, string[]>();
  versionNodes.forEach((node, i) => {
    const result = settled[i];
    // A per-package failure is simply an absent entry: that row renders with
    // null wanted/latest and doesn't disturb any other row.
    if (result?.ok === true) {
      versionsByName.set(node.name, result.value);
      return;
    }
    unavailableUpdatePackages.push(node.name);
    const host = result?.error.code === 'REGISTRY_AUTH_REQUIRED' ? result.error.registryHost : undefined;
    if (host !== undefined) {
      const packages = signInPackagesByHost.get(host) ?? [];
      packages.push(node.name);
      signInPackagesByHost.set(host, packages);
    }
  });
  throwIfAborted(signal);

  // --- advisories -----------------------------------------------------
  // If versions won the race, make the remaining wait explicit in the
  // loading UI instead of leaving it at "versions N of N".
  if (!advisoryRequestSettled) options.onProgress?.({ stage: 'advisories' });
  const { advisoriesByName, advisoriesError } = await advisoryPromise;
  throwIfAborted(signal);

  const endAttribution = recorder.start('advisory attribution');
  let attributed = attributeAdvisories(graph, advisoriesByName);
  endAttribution();

  // --- patched-version remediation ---------------------------------------
  // One packument fetch per distinct flagged package (not per row: a
  // transitive advisory's flagged package is rarely a direct dependency), so
  // this scales with how many packages actually carry a vulnerability, never
  // with the size of the dependency tree. Cached through the same EtagStore
  // as every other registry call. A failed fetch simply leaves that
  // package's advisories at the `unknown` placeholder attribution already set.
  const flaggedPackages = distinctFlaggedPackages(attributed);
  if (flaggedPackages.size > 0) {
    const packumentsByPackage = new Map<string, string[]>();
    const names = [...flaggedPackages];
    let completed = 0;
    options.onProgress?.({ stage: 'patched-versions', completed, total: names.length });
    const endPatchedVersions = recorder.start('patched-version metadata');
    const patchedSettled = await runPool(
      names,
      (name, poolSignal) => loadPackument(name, 'patched version', poolSignal),
      {
        limit: options.concurrency ?? DEFAULT_CONCURRENCY,
        ...(signal === undefined ? {} : { signal }),
        onSettled: () => {
          completed += 1;
          options.onProgress?.({ stage: 'patched-versions', completed, total: names.length });
        },
      }
    );
    names.forEach((name, index) => {
      const result = patchedSettled[index];
      if (result?.ok === true) packumentsByPackage.set(name, result.value.versions);
    });
    endPatchedVersions({ packages: names.length });
    attributed = attachPatchedVersions(attributed, packumentsByPackage);
  }
  throwIfAborted(signal);

  // --- audit enrichment (optional) -------------------------------------
  const audit = await auditPromise;
  const fixes = audit.fixes;
  const auditUnavailable = audit.unavailable;
  throwIfAborted(signal);

  // --- packument escalation, only where the fallback will use it --------
  // Version fetching is designed to avoid fetching the packument for every package
  // (31x the wire bytes, 54x the parse cost). The self-computed fallback needs
  // the full version list, but only for a direct dependency that is itself
  // flagged AND has no usable fixAvailable: usually a handful of packages,
  // and none at all when audit is healthy.
  const availableVersions = new Map<string, string[]>();
  const fallbackNodes = roots.filter((node) => {
    if (node.unresolvable !== undefined) return false;
    const own = attributed.get(node.name)?.some((a) => a.path.length === 1) ?? false;
    const fix = fixes.get(node.name);
    // An object names an explicit version and `false` says no fix exists, so
    // neither needs a version-list lookup. Boolean `true` names no version;
    // verify a clean candidate ourselves just as we do when audit is absent.
    const needsSelfComputedFix = fix === undefined || fix === true;
    return own && needsSelfComputedFix;
  });
  const fallbackSettled = await runPool(
    fallbackNodes,
    (node, poolSignal) => loadPackument(node.registryName ?? node.name, 'upgrade-target fallback', poolSignal),
    {
      limit: options.concurrency ?? DEFAULT_CONCURRENCY,
      ...(signal === undefined ? {} : { signal }),
    }
  );
  fallbackNodes.forEach((node, index) => {
    const result = fallbackSettled[index];
    availableVersions.set(node.name, result?.ok === true ? result.value.versions : []);
  });
  throwIfAborted(signal);

  // --- rows ------------------------------------------------------------
  options.onProgress?.({ stage: 'rows' });
  const endRows = recorder.start('row composition');
  const declaredByName = new Map(manifest.dependencies.map((dependency) => [dependency.name, dependency]));
  const rows: PackageRow[] = roots.map((node) => {
    const info = versionsByName.get(node.name);
    const advisories: AttributedAdvisory[] = attributed.get(node.name) ?? [];
    const fixAvailable = fixes.get(node.name);

    const securityTarget = resolveUpgradeTarget({
      installed: node.version,
      range: node.range,
      availableVersions: availableVersions.get(node.name) ?? [],
      advisories,
      ...(fixAvailable === undefined ? {} : { fixAvailable }),
    });
    const catalogOwned = isCatalogSpecifier(node.range);
    const candidate = resolveUpgradeCandidate({
      securityTarget,
      current: node.version,
      wanted: info?.wanted ?? null,
      latest: info?.latest ?? null,
    });

    const row: PackageRow = {
      name: node.name,
      ...(node.registryName === undefined ? {} : { registryName: node.registryName }),
      current: node.version,
      wanted: info?.wanted ?? null,
      latest: info?.latest ?? null,
      dev: node.dev,
      optional: declaredByName.get(node.name)?.optional ?? false,
      range: node.range,
      advisories,
      advisoryCoverage: advisoryCoverage.get(node.name) ?? 'partial',
      worstSeverity: worstSeverity(advisories),
      // A catalog specifier is owned by pnpm-workspace.yaml, and an npm:
      // alias would lose its declaration in an ordinary install. Neither is
      // offered an upgrade here.
      upgradeTo: catalogOwned || node.registryName !== undefined ? null : (candidate?.target ?? null),
      upgradeReason: catalogOwned || node.registryName !== undefined ? null : (candidate?.reason ?? null),
    };
    if (info?.description !== undefined) row.description = info.description;
    if (info?.license !== undefined) row.license = info.license;
    if (info?.deprecated !== undefined) row.deprecated = info.deprecated;
    if (node.unresolvable !== undefined) row.unresolvable = node.unresolvable;
    return row;
  });

  const hygieneFindings = computeGraphHygieneFindings(rows);
  endRows({ rows: rows.length, 'hygiene findings': hygieneFindings.length });

  const availability: ScanDataAvailability = {
    updates: unavailableUpdatePackages.length === 0 ? 'complete' : 'partial',
    advisories: advisoryCheckOff ? 'off'
      : advisoriesError !== undefined ? 'unavailable'
      : [...advisoryCoverage.values()].includes('partial') ? 'partial' : 'complete',
    unavailableUpdatePackages,
  };
  if (signInPackagesByHost.size > 0) {
    availability.signInRequired = [...signInPackagesByHost]
      .map(([registryHost, packages]) => ({ registryHost, packages }));
  }
  const result: BuildPackageRowsResult = { rows, availability, hygieneFindings };
  if (advisoriesError !== undefined) result.advisoriesError = advisoriesError;
  if (auditUnavailable) result.auditUnavailable = true;
  return result;
}
