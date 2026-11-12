/**
 * The answer that ends a webview request whose handler failed with an
 * internal error, or that the host refused after one.
 *
 * Each answer is the error status the webview already settles that request
 * on, correlated by the request's own package or request id, so its loading
 * or busy state ends. Requests with no pending state in the webview (cancels,
 * opens, settings, refresh) get nothing: the banner covers them. Nothing
 * here touches a running transaction: an error status only clears the
 * webview's state for that one request.
 */

import { INTERNAL_REQUEST_FAILURE_TEXT } from '../core/diagnostics.js';
import type { HostToWebviewMessage, ProtocolError, WebviewToHostMessage } from './webviewProtocol.js';

/**
 * `changeTarget` is the package a change-starting message is about, looked up
 * by the coordinator from the review it names, captured before the handler
 * ran. `error` defaults to the internal error answer.
 */
export function failedRequestSettlement(
  message: WebviewToHostMessage,
  changeTarget?: string,
  error?: ProtocolError
): HostToWebviewMessage | undefined {
  // A read-only request failed before it changed anything.
  const failed = error ?? { code: 'INTERNAL_ERROR', message: INTERNAL_REQUEST_FAILURE_TEXT };
  // A change may have stopped part way. UNKNOWN makes Smart Cleanup report an
  // incomplete run instead of saying nothing changed.
  const changeFailed = error ?? { code: 'UNKNOWN', message: INTERNAL_REQUEST_FAILURE_TEXT };
  switch (message.type) {
    case 'load-upgrade-targets':
      // `unknown` is the version list's own failure code for an unexplained error.
      return {
        status: 'upgrade-targets-error',
        package: message.package,
        requestId: message.requestId,
        error: error ?? { code: 'unknown', message: INTERNAL_REQUEST_FAILURE_TEXT },
      };
    case 'upgrade':
      return { status: 'upgrade-error', package: message.package, error: failed };
    case 'bulk-upgrade':
      return { status: 'upgrade-error', package: message.changes[0]?.package ?? 'unknown', error: failed };
    case 'confirm-upgrade':
    case 'use-smart-plan':
      return { status: 'upgrade-error', package: changeTarget ?? 'unknown', error: changeFailed };
    case 'bulk-remove':
      return { status: 'remove-error', package: message.changes[0]?.package ?? 'unknown', error: failed };
    case 'smart-cleanup-remove':
      return { status: 'remove-error', package: message.packages[0] ?? 'Smart Cleanup', error: failed };
    case 'confirm-remove':
    case 'restore-smart-cleanup':
      return { status: 'remove-error', package: changeTarget ?? 'unknown', error: changeFailed };
    case 'analyze-remediation':
      return { status: 'remediation-error', package: message.package, error: failed };
    case 'analyze-remediations':
      return { status: 'remediation-batch-error', error: failed };
    case 'confirm-remediation':
    case 'retry-remediation':
      return changeTarget === undefined
        ? undefined
        : { status: 'remediation-error', package: changeTarget, error: changeFailed };
    case 'retry-upgrade-enrichment':
      return changeTarget === undefined
        ? undefined
        : { status: 'upgrade-enrichment-result', refreshId: message.refreshId, package: changeTarget, outcome: 'failed', error: failed };
    case 'where-used':
    case 'reanalyze-usage':
      return { status: 'usage-error', package: message.package, error: failed };
    case 'analyze-cleanup':
      return { status: 'cleanup-error', error: failed };
    case 'analyze-smart-cleanup-metadata':
      return { status: 'smart-cleanup-metadata-error', requestId: message.requestId, error: failed };
    case 'analyze-removal-impact':
      return {
        status: 'removal-impact-error',
        requestId: message.requestId,
        packages: [...message.packages].sort((left, right) => left.localeCompare(right)),
        error: failed,
      };
    default:
      return undefined;
  }
}
