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

export type DiagnosticArea = 'version-list' | 'update-check' | 'npm-audit' | 'registry-cache' | 'version-advisories';

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

/**
 * Where an unexpected failure was caught. The log line names the place, never
 * the error's message, which can carry paths, URLs or registry output.
 */
export type RuntimeFailureContext =
  | 'webview-message'
  | 'refresh-after-message'
  | 'unhandled-rejection'
  | 'background-refresh'
  | 'usage-refresh'
  | 'advisory-setting-refresh'
  | 'update-advisories'
  | 'file-reload'
  | 'git-watcher'
  | 'freshness-check'
  | 'reservation-release'
  | 'restore-point-check'
  | 'deferred-changes'
  | 'branch-reconcile'
  | 'open-manifest'
  | 'refresh-command'
  | 'webview-delivery'
  | 'notification'
  | 'open-file'
  | 'open-link'
  | 'open-settings'
  | 'sidebar'
  | 'request-limiter'
  | 'rpc-request';

const RUNTIME_FAILURE_CONTEXTS: ReadonlySet<string> = new Set<RuntimeFailureContext>([
  'webview-message', 'refresh-after-message', 'unhandled-rejection', 'background-refresh', 'usage-refresh',
  'advisory-setting-refresh', 'update-advisories', 'file-reload', 'git-watcher', 'freshness-check',
  'reservation-release', 'restore-point-check', 'deferred-changes', 'branch-reconcile', 'open-manifest',
  'refresh-command', 'webview-delivery', 'notification', 'open-file', 'open-link', 'open-settings', 'sidebar',
  'request-limiter', 'rpc-request',
]);

export function isRuntimeFailureContext(value: unknown): value is RuntimeFailureContext {
  return typeof value === 'string' && RUNTIME_FAILURE_CONTEXTS.has(value);
}

/** Built-in error names are safe to log. A custom name could carry anything, so it is not echoed. */
const SAFE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
  'AggregateError', 'AbortError', 'TimeoutError',
]);

function runtimeErrorKind(error: unknown): string {
  if (error instanceof Error) return SAFE_ERROR_KINDS.has(error.name) ? error.name : 'other error';
  return error === undefined || error === null ? 'no error value' : 'non-error value';
}

/**
 * One log line for an unexpected failure, e.g.
 * "runtime: webview-message failed (TypeError)". Only the place and the
 * built-in error kind appear.
 */
export function runtimeFailureLine(context: RuntimeFailureContext, error: unknown): string {
  const place = isRuntimeFailureContext(context) ? context : 'unknown';
  return `runtime: ${place} failed (${runtimeErrorKind(error)})`;
}

/** The one banner shown after an unexpected failure, with its fixed code. */
export const RUNTIME_ERROR_CODE = 'INTERNAL_ERROR';

export const RUNTIME_ERROR_TEXT =
  'Packageawy hit an internal error. Changes are paused until you close and reopen the Packageawy panel. The Packageawy log has the details.';

/** The sidecar's notification when no panel was open to pause. */
export const RUNTIME_ERROR_WITHOUT_PANEL_TEXT =
  'Packageawy hit an internal error. The Packageawy log has the details.';

/** Code the host attaches to a change it refused because of the failure above. */
export const CHANGES_PAUSED_CODE = 'CHANGES_PAUSED';

export const CHANGES_PAUSED_TEXT =
  'Changes are paused after an internal error. Close and reopen the Packageawy panel, then try again.';

/** The sidecar cannot open the IDE log for the user, so it says where the lines are. */
export const SIDECAR_SHOW_LOG_TEXT =
  'Packageawy writes its details to the IDE log. Open it from the Help menu with Show Log.';

/** Shown once when the editor refuses to open something Packageawy asked it to. */
export function editorActionFailureText(action: 'open-file' | 'open-link' | 'open-settings'): string {
  switch (action) {
    case 'open-file':
      return 'Packageawy could not open the file. The Packageawy log has the details.';
    case 'open-link':
      return 'Packageawy could not open the link. The Packageawy log has the details.';
    case 'open-settings':
      return 'Packageawy could not open Settings. The Packageawy log has the details.';
  }
}
