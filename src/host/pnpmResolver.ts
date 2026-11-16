/** Discover installation-owned pnpm entry points without a shell or workspace binaries. */

import * as path from 'node:path';

import { rethrowUnexpectedResolverError, type NpmInvocation } from './npmResolver.js';
import type { PackageManagerInvocation } from './resolverVerifier.js';

export const PNPM_NOT_FOUND_MESSAGE =
  'Packageawy searched npm global packages, Corepack, PATH, PNPM_HOME, common installation folders and the login-shell PATH for pnpm. Install pnpm or set PNPM_HOME.';

export interface PnpmResolverDeps {
  platform?: NodeJS.Platform;
  cwd?: string;
  /** Lock/workspace root, also excluding sibling workspace members. */
  projectRoot?: string;
  pathEnv?: string;
  homeDir?: string;
  pnpmHome?: string;
  localAppData?: string;
  appData?: string;
  packageManager?: string;
  throwOnUnexpectedError?: boolean;
  exists(path: string): boolean;
  realpath?(path: string): string;
  probe(executable: string, prefixArgs: readonly string[]): string | undefined;
  probeLoginShellPath?(): string | undefined;
}

export function pnpmInvocationCandidates(
  npm: NpmInvocation,
  platform: NodeJS.Platform = process.platform
): PackageManagerInvocation[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const globalRoot = p.dirname(p.dirname(p.dirname(npm.npmCliJs)));
  return [
    { executable: npm.node, prefixArgs: [p.join(globalRoot, 'pnpm', 'bin', 'pnpm.cjs')] },
    { executable: npm.node, prefixArgs: [p.join(globalRoot, 'corepack', 'dist', 'corepack.js'), 'pnpm'] },
    { executable: npm.node, prefixArgs: [p.join(globalRoot, 'corepack', 'dist', 'corepack.cjs'), 'pnpm'] },
  ];
}

export function installationDirs(deps: Pick<PnpmResolverDeps, 'platform' | 'pathEnv' | 'pnpmHome' | 'homeDir' | 'localAppData' | 'appData'>): string[] {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const dirs = [...(deps.pathEnv ?? '').split(deps.platform === 'win32' ? ';' : ':')];
  if (deps.pnpmHome) dirs.push(deps.pnpmHome);
  if (deps.homeDir) {
    const home = deps.homeDir;
    if (deps.platform === 'win32') {
      const local = deps.localAppData ?? p.join(home, 'AppData', 'Local');
      dirs.push(p.join(local, 'pnpm'), p.join(local, 'Microsoft', 'WinGet', 'Links'),
        p.join(deps.appData ?? p.join(home, 'AppData', 'Roaming'), 'npm'),
        p.join(home, 'scoop', 'shims'));
    } else {
      dirs.push(p.join(home, 'Library', 'pnpm'), p.join(home, '.local', 'share', 'pnpm'),
        p.join(home, '.local', 'bin'), p.join(home, '.local', 'share', 'mise', 'shims'),
        p.join(home, '.asdf', 'shims'));
    }
    dirs.push(p.join(home, '.volta', 'bin'));
  }
  if (deps.platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return [...new Set(dirs)];
}

export function resolvePnpmInvocation(
  npm: NpmInvocation | null,
  deps: PnpmResolverDeps
): PackageManagerInvocation | null {
  const platform = deps.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = deps.projectRoot ?? deps.cwd;
  const inside = (file: string, directory: string): boolean => {
    const relative = p.relative(directory, file);
    return relative === '' || (!relative.startsWith(`..${p.sep}`) && relative !== '..' && !p.isAbsolute(relative));
  };
  const safe = (file: string): boolean => {
    if (!p.isAbsolute(file) || (root !== undefined && inside(file, root))) return false;
    try {
      return root === undefined || !inside(deps.realpath?.(file) ?? file, deps.realpath?.(root) ?? root);
    } catch (cause) {
      rethrowUnexpectedResolverError(cause, deps.throwOnUnexpectedError === true);
      return false;
    }
  };
  const wanted = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/.exec(deps.packageManager ?? '')?.[1];
  let fallback: PackageManagerInvocation | null = null;
  const seen = new Set<string>();
  const validate = (candidate: PackageManagerInvocation): PackageManagerInvocation | null => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return null;
    seen.add(key);
    const files = [candidate.executable, ...candidate.prefixArgs.slice(0, 1)];
    if (!files.every(safe)) return null;
    const cli = candidate.prefixArgs[0] ?? candidate.executable;
    if (!deps.exists(cli)) return null;
    const version = deps.probe(candidate.executable, candidate.prefixArgs);
    if (version === undefined) return null;
    const result = { ...candidate, version };
    fallback ??= result;
    return wanted === undefined || version === wanted ? result : null;
  };
  if (npm !== null) {
    for (const candidate of pnpmInvocationCandidates(npm, platform)) {
      const result = validate(candidate);
      if (result !== null) return result;
    }
  }
  const search = (dirs: readonly string[]): PackageManagerInvocation | null => {
    for (const dir of dirs) {
      if (!safe(dir)) continue;
      // Windows batch wrappers are never executed. Resolve npm's standard
      // pnpm.cmd layout to JS, or use a standalone/manager-owned PE binary.
      const files = platform === 'win32'
        ? [p.join(dir, 'pnpm.exe'), p.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
          p.join(dir, 'pnpm.cjs')]
        : [p.join(dir, 'pnpm')];
      for (const file of files) {
        if (!safe(file) || !deps.exists(file)) continue;
        let real: string;
        try { real = deps.realpath?.(file) ?? file; } catch (cause) { rethrowUnexpectedResolverError(cause, deps.throwOnUnexpectedError === true); continue; }
        const candidate = /\.(?:cjs|mjs|js)$/i.test(real)
          ? npm === null ? null : { executable: npm.node, prefixArgs: [real] }
          : { executable: file, prefixArgs: [] };
        if (candidate === null) continue;
        const result = validate(candidate);
        if (result !== null) return result;
      }
    }
    return null;
  };
  const result = search(installationDirs({ ...deps, platform }));
  if (result !== null) return result;
  if (platform !== 'win32') {
    const shellPath = deps.probeLoginShellPath?.();
    if (shellPath !== undefined) {
      const result = search(shellPath.split(':'));
      if (result !== null) return result;
    }
  }
  return fallback;
}
