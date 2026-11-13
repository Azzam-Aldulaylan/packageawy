/** Cancellable pnpm discovery with the same installation boundaries as the pure resolver. */
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { rethrowUnexpectedResolverError, type NpmInvocation } from './npmResolver.js';
import { resolverPathExistsAsync, resolverIsExecutableAsync, runFixedProbeAsync, throwIfAborted } from './npmResolverAsync.js';
import { installationDirs, pnpmInvocationCandidates, type PnpmResolverDeps } from './pnpmResolver.js';
import type { PackageManagerInvocation } from './resolverVerifier.js';

export interface PnpmResolverAsyncDeps extends Omit<PnpmResolverDeps, 'exists' | 'realpath' | 'probe' | 'probeLoginShellPath'> {
  exists(path: string): boolean | Promise<boolean>;
  realpath?(path: string): string | Promise<string>;
  probe(executable: string, prefixArgs: readonly string[]): Promise<string | undefined>;
  probeLoginShellPath?(): Promise<string | undefined>;
  signal?: AbortSignal;
}

export async function resolvePnpmInvocationAsync(
  npm: NpmInvocation | null,
  deps: PnpmResolverAsyncDeps
): Promise<PackageManagerInvocation | null> {
  const platform = deps.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = deps.projectRoot ?? deps.cwd;
  const inside = (file: string, directory: string): boolean => {
    const relative = p.relative(directory, file);
    return relative === '' || (!relative.startsWith(`..${p.sep}`) && relative !== '..' && !p.isAbsolute(relative));
  };
  const safe = async (file: string): Promise<boolean> => {
    throwIfAborted(deps.signal);
    if (!p.isAbsolute(file) || (root !== undefined && inside(file, root))) return false;
    try {
      return root === undefined || !inside((await deps.realpath?.(file)) ?? file, (await deps.realpath?.(root)) ?? root);
    } catch (cause) {
      rethrowUnexpectedResolverError(cause, deps.throwOnUnexpectedError === true);
      return false;
    }
  };
  const wanted = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/.exec(deps.packageManager ?? '')?.[1];
  let fallback: PackageManagerInvocation | null = null;
  const seen = new Set<string>();
  const validate = async (candidate: PackageManagerInvocation): Promise<PackageManagerInvocation | null> => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return null;
    seen.add(key);
    const files = [candidate.executable, ...candidate.prefixArgs.slice(0, 1)];
    for (const file of files) if (!await safe(file)) return null;
    const cli = candidate.prefixArgs[0] ?? candidate.executable;
    if (!await deps.exists(cli)) return null;
    const version = await deps.probe(candidate.executable, candidate.prefixArgs);
    throwIfAborted(deps.signal);
    if (version === undefined) return null;
    const result = { ...candidate, version };
    fallback ??= result;
    return wanted === undefined || version === wanted ? result : null;
  };
  if (npm !== null) {
    for (const candidate of pnpmInvocationCandidates(npm, platform)) {
      const result = await validate(candidate);
      if (result !== null) return result;
    }
  }
  const search = async (dirs: readonly string[]): Promise<PackageManagerInvocation | null> => {
    for (const dir of dirs) {
      if (!await safe(dir)) continue;
      // Windows batch wrappers are never executed. Resolve npm's standard
      // pnpm.cmd layout to JS, or use a standalone/manager-owned PE binary.
      const files = platform === 'win32'
        ? [p.join(dir, 'pnpm.exe'), p.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
          p.join(dir, 'pnpm.cjs')]
        : [p.join(dir, 'pnpm')];
      for (const file of files) {
        if (!await safe(file) || !await deps.exists(file)) continue;
        let real: string;
        try { real = (await deps.realpath?.(file)) ?? file; } catch (cause) { rethrowUnexpectedResolverError(cause, deps.throwOnUnexpectedError === true); continue; }
        const candidate = /\.(?:cjs|mjs|js)$/i.test(real)
          ? npm === null ? null : { executable: npm.node, prefixArgs: [real] }
          : { executable: file, prefixArgs: [] };
        if (candidate === null) continue;
        const result = await validate(candidate);
        if (result !== null) return result;
      }
    }
    return null;
  };
  const result = await search(installationDirs({ ...deps, platform }));
  if (result !== null) return result;
  if (platform !== 'win32') {
    const shellPath = await deps.probeLoginShellPath?.();
    throwIfAborted(deps.signal);
    if (shellPath !== undefined) {
      const result = await search(shellPath.split(':'));
      if (result !== null) return result;
    }
  }
  return fallback;
}

export async function resolveInstalledPnpmInvocationAsync(
  npm: NpmInvocation | null,
  cwd: string,
  strict = false,
  signal?: AbortSignal
): Promise<PackageManagerInvocation | null> {
  throwIfAborted(signal);
  let projectRoot = cwd;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (await resolverPathExistsAsync(path.join(dir, 'pnpm-workspace.yaml'), strict) || await resolverPathExistsAsync(path.join(dir, 'pnpm-lock.yaml'), strict)) {
      projectRoot = dir;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  let packageManager: string | undefined;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try {
      const manifest: unknown = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest &&
          typeof manifest.packageManager === 'string') packageManager = manifest.packageManager;
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) rethrowUnexpectedResolverError(cause, strict);
      // A missing or malformed manifest leaves the version preference unset.
    }
    if (packageManager !== undefined || dir === projectRoot || path.dirname(dir) === dir) break;
  }
  // Like npm resolution, validate on every call so changed installs and project pins are reflected.
  return resolvePnpmInvocationAsync(npm, {
    ...(signal === undefined ? {} : { signal }),
    platform: process.platform, cwd, projectRoot, homeDir: homedir(), throwOnUnexpectedError: strict,
    ...(process.env['PATH'] === undefined ? {} : { pathEnv: process.env['PATH'] }),
    ...(process.env['PNPM_HOME'] === undefined ? {} : { pnpmHome: process.env['PNPM_HOME'] }),
    ...(process.env['LOCALAPPDATA'] === undefined ? {} : { localAppData: process.env['LOCALAPPDATA'] }),
    ...(process.env['APPDATA'] === undefined ? {} : { appData: process.env['APPDATA'] }),
    ...(packageManager === undefined ? {} : { packageManager }),
    exists: candidate => resolverPathExistsAsync(candidate, strict),
    realpath,
    probeLoginShellPath: async () => {
      const output = await runFixedProbeAsync(process.env['SHELL'] ?? '/bin/zsh',
        ['-lic', 'printf "%s\\n" "$PATH"'], { cwd, ...(signal === undefined ? {} : { signal }) }, strict);
      return output?.split('\n').pop()?.trim() || undefined;
    },
    async probe(executable, prefixArgs) {
      if (!await resolverIsExecutableAsync(executable, strict)) return undefined;
      return (await runFixedProbeAsync(executable, [...prefixArgs, '--version'],
        { cwd, ...(signal === undefined ? {} : { signal }) }, strict))?.slice(0, 100);
    },
  });
}
