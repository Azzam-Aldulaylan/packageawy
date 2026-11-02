/**
 * package.json `scripts` block usage detection: a CLI-only dependency
 * (`"lint": "eslint ."`) is real usage the import scanner can never see.
 * Word-boundary text matching, not exact command-name resolution: a script
 * value is a whole shell command line, and this only needs to answer
 * "does this package's name appear in it as a token", which is what a
 * bare CLI invocation, an `npx <pkg>`, or a `<pkg> <args>` pipeline segment
 * all look like.
 */

import { packageNameTokens } from './packageNameMatch.js';

function readScripts(manifestText: string): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(manifestText);
  } catch {
    return {};
  }
  if (typeof json !== 'object' || json === null) return {};
  const scripts = (json as Record<string, unknown>)['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return {};

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ScriptMatch {
  scriptName: string;
  scriptCommand: string;
}

/** Every package.json script whose command line mentions `packageName` as a whole word. */
export function findPackageInScripts(manifestText: string, packageName: string): ScriptMatch[] {
  const scripts = readScripts(manifestText);
  const tokens = packageNameTokens(packageName);
  const pattern = new RegExp(`(?:^|[^\\w@./-])(${tokens.map(escapeForRegex).join('|')})(?:[^\\w./-]|$)`);

  const matches: ScriptMatch[] = [];
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (pattern.test(command)) matches.push({ scriptName, scriptCommand: command });
  }
  return matches;
}
