/**
 * The dashboard's "Showing partial results" banner text. Pure, so it can be
 * tested without rendering and shared by every host.
 *
 * See severityDisplay.ts for why this lives under src/host rather than
 * webview/src.
 *
 * Each symptom gets one sentence naming its actual cause, so a missing
 * lockfile is reported once rather than as both "unknown versions" and a
 * failed npm audit.
 */

import type { DashboardData } from './webviewProtocol.js';

const AUDIT_SENTENCES = {
  'npm-not-found': 'npm was not found, so vulnerability fixes are estimated.',
  timeout: 'npm audit timed out, so vulnerability fixes are estimated.',
  failed: 'npm audit could not run, so vulnerability fixes are estimated.',
} as const;

function lockfileNameFor(data: DashboardData): string | undefined {
  if (data.packageManager === 'pnpm') return 'pnpm-lock.yaml';
  if (data.packageManager === 'npm') return 'package-lock.json';
  return undefined;
}

function installStep(data: DashboardData): string {
  return data.packageManager === undefined
    ? 'Install dependencies, then refresh.'
    : `Run ${data.packageManager} install, then refresh.`;
}

/**
 * Banner text as complete sentences, each ending with a period, or null when
 * nothing is missing. The caller adds only its "Showing partial results:"
 * prefix.
 */
export function partialResultsText(data: DashboardData): string | null {
  const sentences: string[] = [];
  if (data.availability.updates === 'partial') {
    // Sign-in registries get their own info banner, so only count the rest here.
    const signIn = (data.availability.signInRequired ?? []).reduce((sum, group) => sum + group.packages.length, 0);
    const unavailable = data.availability.unavailableUpdatePackages.length - signIn;
    if (unavailable > 0) {
      sentences.push(
        `${unavailable} package update check${unavailable === 1 ? '' : 's'} unavailable. See the Packageawy log for the reason.`
      );
    }
  }
  if (data.advisoriesError !== undefined) {
    sentences.push(`Vulnerability data is unavailable (${data.advisoriesError.code}).`);
  }

  const auditUnavailable = data.auditUnavailable === true;
  const lockfileMissing =
    data.lockfileMissing === true || (auditUnavailable && data.auditUnavailableReason === 'no-lockfile');
  const advisoriesPartial = data.availability.advisories === 'partial';
  const lockfileName = lockfileNameFor(data);

  if (lockfileMissing && (advisoriesPartial || auditUnavailable)) {
    // Covers both unknown versions and audit: neither can work without a lockfile.
    sentences.push(
      lockfileName === undefined ? 'No lockfile found. Install dependencies, then refresh.' : `No ${lockfileName} found. ${installStep(data)}`
    );
  } else if (advisoriesPartial) {
    sentences.push(`Some packages are missing from ${lockfileName ?? 'the lockfile'}. ${installStep(data)}`);
  }
  if (auditUnavailable && !lockfileMissing) {
    const reason = data.auditUnavailableReason;
    sentences.push(AUDIT_SENTENCES[reason === 'npm-not-found' || reason === 'timeout' ? reason : 'failed']);
  }
  return sentences.length === 0 ? null : sentences.join(' ');
}
