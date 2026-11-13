/** Host-owned selection of package scripts explicitly enabled for verification. */

import { SAFE_SCRIPT_NAME, suggestVerificationScripts } from '../core/upgrade/verificationSuggestions.js';

export interface VerificationScript {
  id: string;
  scriptName: string;
}

function manifestScripts(manifestText: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const scripts = (parsed as Record<string, unknown>)['scripts'];
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return undefined;
  return scripts as Record<string, unknown>;
}

/** Script names offered as unchecked opt-in choices when nothing is configured. */
export function suggestVerificationScriptNames(manifestText: string): string[] {
  const scripts = manifestScripts(manifestText);
  return scripts === undefined ? [] : suggestVerificationScripts(scripts);
}

export function selectVerificationScripts(
  manifestText: string,
  configured: readonly unknown[]
): VerificationScript[] {
  const scripts = manifestScripts(manifestText);
  if (scripts === undefined) return [];

  const selected: VerificationScript[] = [];
  const seen = new Set<string>();
  for (const raw of configured) {
    if (typeof raw !== 'string' || !SAFE_SCRIPT_NAME.test(raw) || seen.has(raw)) continue;
    if (!Object.hasOwn(scripts, raw) || typeof (scripts as Record<string, unknown>)[raw] !== 'string') {
      continue;
    }
    seen.add(raw);
    selected.push({ id: `package-script:${raw}`, scriptName: raw });
  }
  return selected;
}

export function buildVerificationScriptArgs(
  packageManager: 'npm' | 'pnpm',
  scriptName: string
): string[] {
  if (!SAFE_SCRIPT_NAME.test(scriptName)) throw new Error('Unsafe verification script name.');
  return packageManager === 'npm' ? ['run-script', scriptName] : ['run', scriptName];
}
