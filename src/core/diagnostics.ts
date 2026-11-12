/**
 * Safe, user-facing failure reasons and troubleshooting log lines.
 *
 * Everything shown to the user or written to the log is built here from
 * allowlisted codes, the registry host name and a bounded package name.
 * Raw error messages, full URLs (whose paths or query strings can carry
 * tokens), file paths, stacks and subprocess output never pass through.
 *
 * Nothing here may import 'vscode' or host modules. See types.ts.
 */

/** Why the upgrade review's version list could not be loaded. */
export type VersionListFailure =
  | 'timeout'
  | 'network'
  | 'registry-error'
  | 'sign-in'
  | 'rate-limited'
  | 'not-found'
  | 'bad-data'
  | 'insecure-registry'
  | 'project-changed'
  | 'checking'
  | 'scan-incomplete'
  | 'no-upgrade'
  | 'unknown';

const VERSION_LIST_FAILURES: ReadonlySet<string> = new Set<VersionListFailure>([
  'timeout',
  'network',
  'registry-error',
  'sign-in',
  'rate-limited',
  'not-found',
  'bad-data',
  'insecure-registry',
  'project-changed',
  'checking',
  'scan-incomplete',
  'no-upgrade',
  'unknown',
]);

export function isVersionListFailure(value: unknown): value is VersionListFailure {
  return typeof value === 'string' && VERSION_LIST_FAILURES.has(value);
}

/** Why `npm audit` could not run. */
export type AuditUnavailableReason = 'no-lockfile' | 'npm-not-found' | 'timeout' | 'failed';

const AUDIT_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<AuditUnavailableReason>([
  'no-lockfile',
  'npm-not-found',
  'timeout',
  'failed',
]);

export function isAuditUnavailableReason(value: unknown): value is AuditUnavailableReason {
  return typeof value === 'string' && AUDIT_UNAVAILABLE_REASONS.has(value);
}

/** The registry's host name only, or undefined when the URL cannot be parsed. */
export function registryHost(registryUrl: string | undefined): string | undefined {
  if (registryUrl === undefined) return undefined;
  try {
    const host = new URL(registryUrl).hostname;
    return /^[a-z0-9.-]{1,253}$/i.test(host) ? host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function isHttpRegistry(registryUrl: string | undefined): boolean {
  if (registryUrl === undefined) return false;
  try {
    return new URL(registryUrl).protocol === 'http:';
  } catch {
    return false;
  }
}

/** npm package names are at most 214 characters from a small alphabet. Anything else is not echoed. */
export function safePackageName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return name.length <= 214 && /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) ? name : undefined;
}

/**
 * Maps a FetchError code (src/core/registry/http.ts) to a version list
 * failure. Takes the code as a string so callers can pass any error's code
 * without this module importing the HTTP layer.
 */
export function versionListFailureFromFetch(code: string, registryUrl?: string): VersionListFailure {
  switch (code) {
    case 'TIMEOUT':
      return 'timeout';
    case 'NETWORK':
      return 'network';
    case 'REGISTRY_5XX':
    case 'TOO_MANY_REDIRECTS':
      return 'registry-error';
    case 'REGISTRY_AUTH_REQUIRED':
      return 'sign-in';
    case 'RATE_LIMITED':
      return 'rate-limited';
    case 'REGISTRY_404':
      return 'not-found';
    case 'PARSE_ERROR':
    case 'TOO_LARGE':
      return 'bad-data';
    case 'BAD_URL':
      return isHttpRegistry(registryUrl) ? 'insecure-registry' : 'unknown';
    default:
      return 'unknown';
  }
}

/** Maps an upgrade eligibility rejection (src/core/upgrade/validate.ts) to a version list failure. */
export function versionListFailureFromEligibility(reason: string): VersionListFailure {
  switch (reason) {
    case 'scan-running':
      return 'checking';
    case 'incomplete-scan':
      return 'scan-incomplete';
    case 'revalidating':
    case 'stale-target':
    case 'no-scan-result':
    case 'unknown-package':
    case 'not-declared':
      return 'project-changed';
    case 'no-eligible-upgrade':
    case 'NO_ELIGIBLE_UPGRADE':
      return 'no-upgrade';
    default:
      return 'unknown';
  }
}

/** Short sentence shown under the version list. */
export function versionListFailureText(failure: VersionListFailure, registryUrl?: string): string {
  const host = registryHost(registryUrl);
  const registry = host === undefined ? 'the registry' : host;
  switch (failure) {
    case 'timeout':
      return `Could not reach ${registry} in time.`;
    case 'network':
      return `Could not connect to ${registry}.`;
    case 'registry-error':
      return `${host ?? 'The registry'} returned an error.`;
    case 'sign-in':
      return `${host ?? 'The registry'} needs you to sign in.`;
    case 'rate-limited':
      return `${host ?? 'The registry'} is limiting requests. Try again in a minute.`;
    case 'not-found':
      return `${host ?? 'The registry'} has no version list for this package.`;
    case 'bad-data':
      return `${host ?? 'The registry'} sent a version list that could not be read.`;
    case 'insecure-registry':
      return `${host ?? 'The registry'} uses http. Packageawy only connects to registries over https.`;
    case 'project-changed':
      return 'The project changed. Refresh the dashboard, then try again.';
    case 'checking':
      return 'The dashboard is still checking the project. The list loads when it finishes.';
    case 'scan-incomplete':
      return 'Upgrades are paused because the last scan could not check every package. Refresh to scan again.';
    case 'no-upgrade':
      return 'No upgrade is available for this package any more.';
    case 'unknown':
      return 'Published versions could not be loaded.';
  }
}

/** Whether Retry should refresh the dashboard first instead of reloading the list. */
export function versionListFailureNeedsRefresh(failure: VersionListFailure): boolean {
  return failure === 'project-changed' || failure === 'no-upgrade' || failure === 'scan-incomplete';
}

/** Codes that may appear in a log line or a user-facing error. Anything else becomes UNKNOWN. */
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  'NETWORK', 'TIMEOUT', 'TOO_LARGE', 'TOO_MANY_REDIRECTS', 'BAD_URL', 'REGISTRY_404', 'REGISTRY_AUTH_REQUIRED',
  'REGISTRY_5XX', 'RATE_LIMITED', 'PARSE_ERROR', 'CANCELLED', 'UNKNOWN',
  ...VERSION_LIST_FAILURES, ...AUDIT_UNAVAILABLE_REASONS,
]);

export function safeDiagnosticCode(code: string): string {
  return DIAGNOSTIC_CODES.has(code) ? code : 'UNKNOWN';
}

export type DiagnosticArea = 'version-list' | 'update-check' | 'npm-audit' | 'registry-cache';

/**
 * One log line, e.g.
 * "version-list: @react-router/dev via registry.npmjs.org failed (TIMEOUT)".
 * `code` must be an allowlisted code (a FetchError code, a failure or reason
 * name above); anything else is logged as UNKNOWN.
 */
export function diagnosticLine(entry: {
  area: DiagnosticArea;
  code: string;
  packageName?: string;
  registryUrl?: string;
  detail?: 'recovered' | 'fallback-used' | 'fallback-failed';
}): string {
  // An http registry is refused before any request; name that instead of BAD_URL.
  const code = entry.code === 'BAD_URL' && isHttpRegistry(entry.registryUrl)
    ? 'insecure-registry (only https registries are used)'
    : safeDiagnosticCode(entry.code);
  const name = safePackageName(entry.packageName);
  const host = registryHost(entry.registryUrl);
  const subject = [name, host === undefined ? undefined : `via ${host}`].filter((part) => part !== undefined).join(' ');
  const detail = entry.detail === undefined ? '' : `, ${entry.detail}`;
  return `${entry.area}: ${subject === '' ? '' : `${subject} `}failed (${code}${detail})`;
}
