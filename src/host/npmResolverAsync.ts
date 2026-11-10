/**
 * Asynchronous, cancellable twin of `resolveNpmInvocation` (npmResolver.ts),
 * for callers on a hot path such as the dashboard scan's npm audit. The
 * candidate order (`candidateNodePaths`), the npm-cli.js derivation, the
 * fixed probe arguments and the Windows "never run npm.cmd" rule are the
 * same; only the probes run through async `execFile` with a timeout and an
 * AbortSignal, so they never block the event loop. Existence checks stay
 * synchronous: they are single stat calls.
 *
 * The synchronous resolver and its callers are unchanged.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as posixPath from 'node:path/posix';

import {
  candidateNodePaths,
  LOGIN_SHELL_PROBE_ARGS,
  NPM_ROOT_PROBE_ARGS,
  NPM_VERSION_PROBE_ARG,
  posixNpmCliJsFor,
  prependDirToPath,
  REAL_NODE_PATH_PROBE_ARGS,
  realIsExecutable,
  realListDir,
  windowsNpmCliJsFor,
  type CandidateEnv,
  type NpmInvocation,
  type NpmResolutionResult,
} from './npmResolver.js';

export interface NpmResolverAsyncDeps extends CandidateEnv {
  exists: (path: string) => boolean;
  isExecutable: (path: string) => boolean;
  resolveRealNodePath: (node: string) => Promise<string | undefined>;
  /** POSIX only. Never called for a Windows candidate. */
  resolveGlobalNpmRoot: (node: string) => Promise<string | undefined>;
  probeVersion: (node: string, npmCliJs: string) => Promise<string | undefined>;
  probeLoginShellNode: () => Promise<string | undefined>;
  signal?: AbortSignal;
}

function abortError(): Error {
  return Object.assign(new Error('npm resolution was cancelled.'), { name: 'AbortError' });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
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
  if (!deps.exists(npmCliJs)) return undefined;
  const version = await deps.probeVersion(node, npmCliJs);
  throwIfAborted(deps.signal);
  if (version === undefined) return undefined;
  return { node, npmCliJs, version };
}

/** Rejects with an AbortError when `deps.signal` aborts; otherwise mirrors `resolveNpmInvocation`. */
export async function resolveNpmInvocationAsync(deps: NpmResolverAsyncDeps): Promise<NpmResolutionResult> {
  throwIfAborted(deps.signal);
  for (const node of candidateNodePaths(deps)) {
    if (!deps.exists(node) || !deps.isExecutable(node)) continue;
    const invocation = await validatePairAsync(node, deps);
    if (invocation !== undefined) return { ok: true, invocation };
  }

  if (deps.platform === 'win32') return { ok: false };

  const probedNode = await deps.probeLoginShellNode();
  throwIfAborted(deps.signal);
  if (probedNode !== undefined && deps.exists(probedNode) && deps.isExecutable(probedNode)) {
    const invocation = await validatePairAsync(probedNode, deps);
    if (invocation !== undefined) return { ok: true, invocation };
  }
  return { ok: false };
}

function runFixedProbeAsync(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout) => {
        const trimmed = error ? '' : stdout.trim();
        resolve(trimmed.length > 0 ? trimmed : undefined);
      }
    );
  });
}

/** Same probes as `createNodeNpmResolverDeps`, run asynchronously and stopped by `signal`. */
export function createNodeNpmResolverAsyncDeps(cwd: string, signal?: AbortSignal): NpmResolverAsyncDeps {
  const platform = process.platform;
  const probe = (executable: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
    runFixedProbeAsync(executable, args, {
      cwd,
      ...(env === undefined ? {} : { env }),
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    platform,
    pathEnv: process.env['PATH'],
    homeDir: homedir(),
    fnmDirEnv: process.env['FNM_DIR'],
    exists: existsSync,
    isExecutable: realIsExecutable,
    listDir: realListDir,
    resolveRealNodePath: (node) => probe(node, REAL_NODE_PATH_PROBE_ARGS),
    resolveGlobalNpmRoot: async (node) => {
      // POSIX only: the co-located npm wrapper, never npm.cmd.
      const nodeDir = posixPath.dirname(node);
      const npmBin = posixPath.join(nodeDir, 'npm');
      if (!existsSync(npmBin)) return undefined;
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
