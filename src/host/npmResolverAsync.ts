/** Cancellable installation discovery shared by audits and dependency operations. */

import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as posixPath from 'node:path/posix';
import { NodePackageManagerProcessRunner } from './packageManagerProcessRunner.js';

import {
  candidateNodePaths,
  LOGIN_SHELL_PROBE_ARGS,
  NPM_ROOT_PROBE_ARGS,
  NPM_VERSION_PROBE_ARG,
  posixNpmCliJsFor,
  prependDirToPath,
  REAL_NODE_PATH_PROBE_ARGS,
  rethrowUnexpectedResolverError,
  windowsNpmCliJsFor,
  type CandidateEnv,
  type NpmInvocation,
  type NpmResolutionResult,
} from './npmResolver.js';

export interface NpmResolverAsyncDeps extends Omit<CandidateEnv, 'listDir'> {
  listDir: (path: string) => string[] | Promise<string[]>;
  exists: (path: string) => boolean | Promise<boolean>;
  isExecutable: (path: string) => boolean | Promise<boolean>;
  resolveRealNodePath: (node: string) => Promise<string | undefined>;
  /** POSIX only. Never called for a Windows candidate. */
  resolveGlobalNpmRoot: (node: string) => Promise<string | undefined>;
  probeVersion: (node: string, npmCliJs: string) => Promise<string | undefined>;
  probeLoginShellNode: () => Promise<string | undefined>;
  signal?: AbortSignal;
}

function abortError(): Error {
  return Object.assign(new Error('Package-manager discovery was cancelled.'), { name: 'AbortError' });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

async function validatePairAsync(node: string, deps: NpmResolverAsyncDeps): Promise<NpmInvocation | undefined> {
  const realNode = await deps.resolveRealNodePath(node);
  throwIfAborted(deps.signal);
  if (realNode === undefined) return undefined;

  let npmCliJs: string;
  if (deps.platform === 'win32') {
    npmCliJs = windowsNpmCliJsFor(realNode);
  } else {
    const npmRoot = await deps.resolveGlobalNpmRoot(node);
    throwIfAborted(deps.signal);
    if (npmRoot === undefined) return undefined;
    npmCliJs = posixNpmCliJsFor(npmRoot);
  }
  if (!await deps.exists(npmCliJs)) return undefined;
  const version = await deps.probeVersion(node, npmCliJs);
  throwIfAborted(deps.signal);
  if (version === undefined) return undefined;
  return { node, npmCliJs, version };
}

/** Rejects with an AbortError when `deps.signal` aborts; otherwise mirrors `resolveNpmInvocation`. */
export async function resolveNpmInvocationAsync(deps: NpmResolverAsyncDeps): Promise<NpmResolutionResult> {
  throwIfAborted(deps.signal);
  for (const node of await candidateNodePathsAsync(deps)) {
    throwIfAborted(deps.signal);
    if (!await deps.exists(node) || !await deps.isExecutable(node)) continue;
    const invocation = await validatePairAsync(node, deps);
    if (invocation !== undefined) return { ok: true, invocation };
  }

  if (deps.platform === 'win32') return { ok: false };

  const probedNode = await deps.probeLoginShellNode();
  throwIfAborted(deps.signal);
  if (probedNode !== undefined && await deps.exists(probedNode) && await deps.isExecutable(probedNode)) {
    const invocation = await validatePairAsync(probedNode, deps);
    if (invocation !== undefined) return { ok: true, invocation };
  }
  return { ok: false };
}

/** Candidate ordering stays in the pure resolver; directory reads yield to the host. */
export async function candidateNodePathsAsync(deps: Omit<CandidateEnv, 'listDir'> & {
  listDir: (path: string) => string[] | Promise<string[]>;
}): Promise<string[]> {
  const directories = new Map<string, string[]>();
  candidateNodePaths({ ...deps, listDir: dir => { directories.set(dir, []); return []; } });
  await Promise.all([...directories.keys()].map(async dir => directories.set(dir, await deps.listDir(dir))));
  return candidateNodePaths({ ...deps, listDir: dir => directories.get(dir) ?? [] });
}

export async function resolverPathExistsAsync(candidate: string, strict = false): Promise<boolean> {
  try { await stat(candidate); return true; }
  catch (cause) { rethrowUnexpectedResolverError(cause, strict); return false; }
}

export async function resolverIsExecutableAsync(candidate: string, strict = false): Promise<boolean> {
  try { await access(candidate, constants.X_OK); return true; }
  catch (cause) { rethrowUnexpectedResolverError(cause, strict); return false; }
}

export async function resolverListDirAsync(candidate: string, strict = false): Promise<string[]> {
  try { return await readdir(candidate); }
  catch (cause) { rethrowUnexpectedResolverError(cause, strict); return []; }
}

/** Probes share the analysis runner's bounded process-tree cancellation lifecycle. */
export async function runFixedProbeAsync(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  strict = false
): Promise<string | undefined> {
  throwIfAborted(options.signal);
  try {
    const result = await new NodePackageManagerProcessRunner({
      description: 'Package-manager discovery', timeoutMs: 5000,
      stdoutLimitBytes: 1_048_576, stdoutPolicy: 'reject',
    }).run({ executable, prefixArgs: [] }, args, options.cwd, options.signal, options.env);
    throwIfAborted(options.signal);
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim() || undefined;
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof Error && cause.name === 'TimeoutError') return undefined;
    rethrowUnexpectedResolverError(cause, strict);
    return undefined;
  }
}

/** Installation probes run asynchronously and stopped by `signal`. */
export function createNodeNpmResolverAsyncDeps(cwd: string, signal?: AbortSignal, strict = false): NpmResolverAsyncDeps {
  const platform = process.platform;
  const probe = (executable: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
    runFixedProbeAsync(executable, args, {
      cwd,
      ...(env === undefined ? {} : { env }),
      ...(signal === undefined ? {} : { signal }),
    }, strict);
  return {
    platform,
    pathEnv: process.env['PATH'],
    homeDir: homedir(),
    fnmDirEnv: process.env['FNM_DIR'],
    exists: candidate => resolverPathExistsAsync(candidate, strict),
    isExecutable: candidate => resolverIsExecutableAsync(candidate, strict),
    listDir: candidate => resolverListDirAsync(candidate, strict),
    resolveRealNodePath: (node) => probe(node, REAL_NODE_PATH_PROBE_ARGS),
    resolveGlobalNpmRoot: async (node) => {
      // POSIX only: the co-located npm wrapper, never npm.cmd.
      const nodeDir = posixPath.dirname(node);
      const npmBin = posixPath.join(nodeDir, 'npm');
      if (!await resolverPathExistsAsync(npmBin, strict)) return undefined;
      const env = { ...process.env, PATH: prependDirToPath(nodeDir, platform, process.env['PATH']) };
      return probe(npmBin, NPM_ROOT_PROBE_ARGS, env);
    },
    probeVersion: async (node, npmCliJs) => (await probe(node, [npmCliJs, NPM_VERSION_PROBE_ARG]))?.slice(0, 100),
    probeLoginShellNode: async () => {
      const shell = process.env['SHELL'] ?? '/bin/zsh';
      const output = await probe(shell, LOGIN_SHELL_PROBE_ARGS);
      return output?.split('\n').pop()?.trim() || undefined;
    },
    ...(signal === undefined ? {} : { signal }),
  };
}
