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

/**
 * `requireCheck` is false for npm's pre and post hooks. A hook only has to
 * finish on its own, so `postbuild: "echo done"` does not hide `build`.
 */
function looksLikeOneShotCheck(
  table: Record<string, unknown>,
  name: string,
  visiting: Set<string>,
  requireCheck = true
): boolean {
  if (visiting.has(name) || visiting.size >= MAX_SCRIPT_DEPTH) return false;
  const script = scriptText(table, name);
  if (script === undefined || script.trim().length === 0) return false;
  if (isPlaceholderScript(script) || runsInBackground(script) || hidesRunnerCommand(script)) return false;

  const unwrapped = lexInvocations(script).map(unwrapInvocation);
  if (unwrapped.length === 0) return false;
  // A wrapper whose command cannot be found might start anything.
  if (unwrapped.some((invocation) => invocation === null)) return false;
  const invocations = unwrapped as ShellInvocation[];
  if (requireCheck && invocations.every((invocation) => NO_OP_EXECUTABLES.has(baseName(invocation.executable)))) {
    return false;
  }

  visiting.add(name);
  try {
    for (const invocation of invocations) {
      if (invocationLooksLongRunning(invocation) || runsOtherWorkspaces(invocation)) return false;
      const referenced = referencedScript(table, invocation);
      if (referenced === null) return false;
      if (referenced !== undefined && !looksLikeOneShotCheck(table, referenced, visiting)) return false;
    }
    // npm also runs the matching pre and post scripts, so they must pass too.
    for (const hook of [`pre${name}`, `post${name}`]) {
      if (Object.hasOwn(table, hook) && !looksLikeOneShotCheck(table, hook, visiting, false)) return false;
    }
    return true;
  } finally {
    visiting.delete(name);
  }
}

/** Executables that only set the environment and then run the rest of their arguments. */
const ENV_WRAPPERS = new Set(['cross-env', 'env']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Shells and command runners whose real command is inside a string or argument list we do not parse. */
const OPAQUE_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh',
  'eval', 'exec', 'xargs', 'time', 'nice', 'nohup', 'timeout',
]);
const MAX_UNWRAP_DEPTH = 4;

function withoutLeadingFlags(args: readonly string[]): readonly string[] {
  const first = args.findIndex((arg) => !arg.startsWith('-'));
  return first < 0 ? [] : args.slice(first);
}

/**
 * The command a wrapper such as `cross-env NODE_ENV=test ng test` really
 * runs, so the watch and server rules see `ng test`. Returns null when the
 * wrapped command cannot be found, which callers treat as unsafe.
 */
function unwrapInvocation(invocation: ShellInvocation): ShellInvocation | null {
  let current = invocation;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const executable = baseName(current.executable);
    let rest: readonly string[];
    if (ENV_WRAPPERS.has(executable)) {
      let index = 0;
      while (index < current.args.length && (ENV_ASSIGNMENT.test(current.args[index] ?? '') || (current.args[index] ?? '').startsWith('-'))) {
        // These env flags take a value, which would be mistaken for the command.
        if (/^(-[uCS]|--(unset|chdir|split-string))/.test(current.args[index] ?? '')) return null;
        index += 1;
      }
      rest = current.args.slice(index);
    } else if (executable === 'cross-env-shell' || OPAQUE_EXECUTABLES.has(executable)) {
      return null;
    } else if (executable === 'dotenv') {
      // dotenv-cli options can take values, so only `--` marks the command reliably.
      const separator = current.args.indexOf('--');
      if (separator < 0) return null;
      rest = current.args.slice(separator + 1);
    } else if (executable === 'npx' || executable === 'bunx' || executable === 'pnpx') {
      rest = withoutLeadingFlags(current.args);
    } else if ((executable === 'pnpm' || executable === 'yarn') && current.args[0] === 'dlx') {
      rest = withoutLeadingFlags(current.args.slice(1));
    } else {
      return current;
    }
    const [next, ...args] = rest;
    if (next === undefined) return null;
    current = { executable: next, args };
  }
  return null;
}

/** npm's generated `echo "Error: no test specified" && exit 1` and variants of it. */
function isPlaceholderScript(script: string): boolean {
  if (/no tests? (specified|configured|yet)/i.test(script)) return true;
  return lexInvocations(script).some(
    (invocation) => baseName(invocation.executable) === 'exit' && invocation.args.some((arg) => arg !== '0')
  );
}

/**
 * The shared lexer drops npx and exec options, so `npx --package @angular/cli
 * ng test` would look like it runs `@angular/cli`. Options that take a package
 * or a command string hide what really runs.
 */
function hidesRunnerCommand(script: string): boolean {
  return /(^|[\s;&|])(npx|pnpx|bunx|exec|dlx)\s+(?:[^;&|]*\s)?(-p|--package|-c|--call)(?=[\s=]|$)/.test(script);
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
  // Bundled short flags such as rollup's `-cw` include watch mode.
  if (/^-[A-Za-z]*w[A-Za-z]*$/.test(arg)) return true;
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

/** Package-manager flags known to take no value, so they can be skipped safely. */
const VALUELESS_PACKAGE_MANAGER_FLAGS = new Set(['-s', '--silent', '-q', '--quiet', '--if-present', '--no-color']);

/** Index of the first argument after the valueless flags at `start`, or -1 when a flag may take a value. */
function skipValuelessFlags(args: readonly string[], start: number): number {
  let index = start;
  while ((args[index] ?? '').startsWith('-')) {
    if (!VALUELESS_PACKAGE_MANAGER_FLAGS.has(args[index] ?? '')) return -1;
    index += 1;
  }
  return index;
}

/**
 * The local script a package-manager invocation runs. Undefined when it runs
 * no script. Null when a flag that may take a value hides which script runs.
 */
function referencedScript(table: Record<string, unknown>, invocation: ShellInvocation): string | undefined | null {
  const executable = baseName(invocation.executable);
  if (!PACKAGE_MANAGERS.has(executable)) return undefined;
  const { args } = invocation;
  const commandIndex = skipValuelessFlags(args, 0);
  if (commandIndex < 0) return null;
  const first = args[commandIndex];
  if (first === undefined) return undefined;
  if (NPM_RUN_COMMANDS.has(first)) {
    const nameIndex = skipValuelessFlags(args, commandIndex + 1);
    return nameIndex < 0 ? null : args[nameIndex] ?? null;
  }
  if (executable === 'npm') return NPM_TEST_ALIASES.has(first) ? 'test' : undefined;
  // pnpm, yarn and bun run a script when its name is the first argument.
  return scriptText(table, first) === undefined ? undefined : first;
}
