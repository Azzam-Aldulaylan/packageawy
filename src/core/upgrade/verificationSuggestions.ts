/**
 * Suggests package.json scripts a user could run as post-install
 * verification. Nothing here runs a script. The host offers the result as
 * unchecked choices and still revalidates every name at confirm time.
 *
 * The rules are deliberately conservative. A script is only suggested when
 * it looks like a one-shot check that exits on its own. Anything that might
 * watch files, start a server, run in the background, or always fail is
 * left out, because running it after an install would hang or report a
 * false failure.
 */

import { lexInvocations } from '../projectCompatibility/scripts.js';
import type { ShellInvocation } from '../projectCompatibility/scripts.js';

/** The only script names the host will ever pass to a package manager. */
export const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export const MAX_VERIFICATION_SUGGESTIONS = 4;

/** Priority order. Within a group the first name present wins. */
const CANDIDATE_GROUPS: readonly (readonly string[])[] = [
  ['typecheck', 'type-check'],
  ['build'],
  ['test'],
  ['lint'],
];

/** Executables that start a server, a watcher, or other scripts we cannot inspect. */
const ALWAYS_LONG_RUNNING = new Set([
  'nodemon',
  'webpack-dev-server',
  'http-server',
  'serve',
  'live-server',
  'browser-sync',
  'ts-node-dev',
  'karma',
  'concurrently',
  'npm-run-all',
  'run-p',
  'run-s',
]);

/** Subcommands that start a dev server or a watcher in common CLIs. */
const LONG_RUNNING_SUBCOMMANDS = new Set(['dev', 'develop', 'serve', 'start', 'watch', 'preview']);

/** Executables whose test command watches by default unless told otherwise. */
const WATCHING_TEST_RUNNERS = new Set(['ng', 'react-scripts', 'craco', 'react-app-rewired']);

/** Invocations that only print or exit, so they never check anything. */
const NO_OP_EXECUTABLES = new Set(['echo', 'printf', 'exit', 'true', 'false', ':']);

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_RUN_COMMANDS = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_TEST_ALIASES = new Set(['test', 't', 'tst']);
const MAX_SCRIPT_DEPTH = 4;
/** Flags that run scripts of other workspace packages, which are not in this manifest. */
const WORKSPACE_FLAG = /^(-r|--recursive|-F|--filter(=.*)?|--workspaces?(=.*)?|-ws|--include-workspace-root)$/;

export function isSafeScriptName(name: string): boolean {
  return SAFE_SCRIPT_NAME.test(name);
}

/**
 * Returns up to four script names in priority order: typecheck, build, test,
 * lint. `scripts` is the parsed `scripts` field of package.json. Anything
 * that is not a plain object yields no suggestions.
 */
export function suggestVerificationScripts(scripts: unknown): string[] {
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return [];
  const table = scripts as Record<string, unknown>;
  const suggestions: string[] = [];
  for (const group of CANDIDATE_GROUPS) {
    const name = group.find((candidate) => Object.hasOwn(table, candidate));
    if (name === undefined || !isSafeScriptName(name)) continue;
    if (!looksLikeOneShotCheck(table, name, new Set())) continue;
    suggestions.push(name);
    if (suggestions.length >= MAX_VERIFICATION_SUGGESTIONS) break;
  }
  return suggestions;
}

function scriptText(table: Record<string, unknown>, name: string): string | undefined {
  if (!Object.hasOwn(table, name)) return undefined;
  const value = table[name];
  return typeof value === 'string' ? value : undefined;
}

function looksLikeOneShotCheck(table: Record<string, unknown>, name: string, visiting: Set<string>): boolean {
  if (visiting.has(name) || visiting.size >= MAX_SCRIPT_DEPTH) return false;
  const script = scriptText(table, name);
  if (script === undefined || script.trim().length === 0) return false;
  if (isPlaceholderScript(script) || runsInBackground(script)) return false;

  const invocations = lexInvocations(script);
  if (invocations.length === 0) return false;
  if (invocations.every((invocation) => NO_OP_EXECUTABLES.has(baseName(invocation.executable)))) return false;

  visiting.add(name);
  try {
    for (const invocation of invocations) {
      if (invocationLooksLongRunning(invocation) || runsOtherWorkspaces(invocation)) return false;
      const referenced = referencedScript(table, invocation);
      if (referenced !== undefined && !looksLikeOneShotCheck(table, referenced, visiting)) return false;
    }
    return true;
  } finally {
    visiting.delete(name);
  }
}

/** npm's generated `echo "Error: no test specified" && exit 1` and variants of it. */
function isPlaceholderScript(script: string): boolean {
  if (/no tests? (specified|configured|yet)/i.test(script)) return true;
  return lexInvocations(script).some(
    (invocation) => baseName(invocation.executable) === 'exit' && invocation.args.some((arg) => arg !== '0')
  );
}

/** A single `&` sends a command to the background. `&&`, `>&` and `&>` do not. */
function runsInBackground(script: string): boolean {
  return /(?<![&>|])&(?![&>])/.test(script);
}

function baseName(executable: string): string {
  const slash = Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\'));
  return executable.slice(slash + 1).toLowerCase();
}

function isWatchFlag(arg: string): boolean {
  if (arg === '-w') return true;
  const match = /^--(watch|watchall|watch-all)(?:=(.*))?$/i.exec(arg);
  if (match === null) return false;
  return match[2] === undefined || match[2].toLowerCase() !== 'false';
}

function disablesWatch(arg: string): boolean {
  return /^--(watch|watchall|watch-all)=false$/i.test(arg) || arg === '--no-watch' || arg === '--single-run';
}

function invocationLooksLongRunning(invocation: ShellInvocation): boolean {
  const executable = baseName(invocation.executable);
  const { args } = invocation;
  if (ALWAYS_LONG_RUNNING.has(executable)) return true;
  if (args.some(isWatchFlag)) return true;
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional.some((arg) => LONG_RUNNING_SUBCOMMANDS.has(arg))) return true;

  const subcommand = positional[0];
  if (executable === 'vitest') {
    // Vitest watches by default in an interactive terminal.
    return subcommand !== 'run' && !args.includes('--run');
  }
  if (executable === 'vite' || executable === 'parcel') return subcommand !== 'build';
  if (WATCHING_TEST_RUNNERS.has(executable) && subcommand === 'test') return !args.some(disablesWatch);
  return false;
}

function runsOtherWorkspaces(invocation: ShellInvocation): boolean {
  return PACKAGE_MANAGERS.has(baseName(invocation.executable)) && invocation.args.some((arg) => WORKSPACE_FLAG.test(arg));
}

/** The local script a package-manager invocation runs, when one can be named. */
function referencedScript(table: Record<string, unknown>, invocation: ShellInvocation): string | undefined {
  const executable = baseName(invocation.executable);
  if (!PACKAGE_MANAGERS.has(executable)) return undefined;
  const positional = invocation.args.filter((arg) => !arg.startsWith('-'));
  const first = positional[0];
  if (first === undefined) return undefined;
  if (NPM_RUN_COMMANDS.has(first)) return positional[1];
  if (executable === 'npm') return NPM_TEST_ALIASES.has(first) ? 'test' : undefined;
  // pnpm, yarn and bun run a script when its name is the first argument.
  return scriptText(table, first) === undefined ? undefined : first;
}
