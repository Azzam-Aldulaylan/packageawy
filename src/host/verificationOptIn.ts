/**
 * One-click verification opt-in. When `upgrade.verificationScripts` selects
 * nothing, an analysis offers suggested scripts as unchecked choices. The
 * webview may echo back a subset at confirm time. This module decides which
 * of those names the host accepts. The webview's list is only ever a filter
 * over host-computed suggestions, never a source of script names.
 */

import type { HostPlatform } from './platform/hostPlatform.js';
import { selectVerificationScripts } from './verificationPolicy.js';
import type { VerificationScript } from './verificationPolicy.js';

export const VERIFICATION_SCRIPTS_SETTING = 'upgrade.verificationScripts';

/** Upper bound on the names a confirm message may carry. */
export const MAX_REQUESTED_VERIFICATION_SCRIPTS = 8;

/** The optional fields a confirm message may add. */
export interface VerificationOptInRequest {
  verificationScripts?: string[];
  rememberVerificationScripts?: boolean;
}

/** The stored-analysis fields the opt-in reads and updates. */
export interface VerificationOptInTarget {
  verificationScripts: VerificationScript[];
  suggestedScriptNames: readonly string[];
}

export interface VerificationOptInDecision {
  scripts: VerificationScript[];
  remember: boolean;
}

export interface ResolveVerificationOptInInput {
  /** Scripts the analysis selected from the setting. */
  configured: readonly VerificationScript[];
  /** The setting's raw value right now. A value set since the analysis wins over any opt-in. */
  currentSetting: readonly unknown[];
  suggestedScriptNames: readonly string[];
  /** The manifest the host just re-read for this confirm. */
  manifestText: string;
  request: VerificationOptInRequest;
  trusted: boolean;
}

/**
 * Accepts a requested name only when nothing is configured, the workspace
 * is trusted, the analysis suggested that name, and the manifest still
 * defines it. Everything else is ignored.
 */
export function resolveVerificationOptIn(input: ResolveVerificationOptInInput): VerificationOptInDecision {
  const unchanged = { scripts: [...input.configured], remember: false };
  const requested = input.request.verificationScripts;
  if (input.configured.length > 0 || requested === undefined || requested.length === 0 || !input.trusted) {
    return unchanged;
  }
  if (selectVerificationScripts(input.manifestText, input.currentSetting).length > 0) return unchanged;
  const wanted = new Set(requested.slice(0, MAX_REQUESTED_VERIFICATION_SCRIPTS));
  const names = input.suggestedScriptNames.filter((name) => wanted.has(name));
  const scripts = selectVerificationScripts(input.manifestText, names);
  return { scripts, remember: input.request.rememberVerificationScripts === true && scripts.length > 0 };
}

/**
 * Applies an accepted opt-in to a stored analysis that is already detached
 * from the host's store, so the run that follows uses it exactly like
 * configured scripts. Persists the names as the project's setting when
 * asked. A failed save is reported but never blocks the change itself.
 */
export async function applyVerificationOptIn(
  platform: HostPlatform,
  target: VerificationOptInTarget,
  options: { currentSetting: readonly unknown[]; manifestText: string; request: VerificationOptInRequest }
): Promise<void> {
  if (options.request.verificationScripts === undefined || options.request.verificationScripts.length === 0) return;
  const decision = resolveVerificationOptIn({
    configured: target.verificationScripts,
    currentSetting: options.currentSetting,
    suggestedScriptNames: target.suggestedScriptNames,
    manifestText: options.manifestText,
    request: options.request,
    trusted: platform.isWorkspaceTrusted(),
  });
  target.verificationScripts = decision.scripts;
  if (!decision.remember) return;
  try {
    await platform.updateWorkspaceSetting(
      VERIFICATION_SCRIPTS_SETTING,
      decision.scripts.map((script) => script.scriptName)
    );
  } catch {
    platform.showWarningMessage('Packageawy could not save the verification scripts for this project. They still run for this change.');
  }
}
