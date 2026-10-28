/**
 * Finds the project(s) the dashboard can render, using the platform's
 * workspace search rather than a recursive filesystem walk.
 *
 * Every decision worth testing already lives in src/core/workspace/scan.ts,
 * this file is the adapter that feeds it raw paths and reads the chosen
 * files off disk. Split in two:
 *   - `discoverProjects` scans every open WorkspaceFolder and returns the
 *     full, host-owned candidate list: cheap, no file content read yet.
 *   - `loadProject` reads one specific candidate's manifest/lockfile and
 *     resolves its registry, given a candidate `discoverProjects` (or a
 *     picker built from it) produced. It never reads anything the caller
 *     didn't already discover.
 * DashboardPanel decides which candidate to load (auto-selected when there's
 * exactly one, chosen via QuickPick when there's more than one): this file
 * has no opinion on selection, only discovery and loading.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { resolvePeerResolutionPolicy, resolveRegistry } from '../core/registry/npmrc.js';
import type { PeerResolutionPolicy } from '../core/registry/npmrc.js';
import { parseManifest } from '../core/manifest/parse.js';
import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { NOOP_PERFORMANCE_RECORDER } from '../core/performance/measurement.js';
import type { PackageManagerKind, ResolvedRegistry } from '../core/types.js';
import type { DiscoveredProjectCandidate, ProjectCandidateSource } from '../core/workspace/scan.js';
import {
  DEFAULT_EXCLUDED_DIRS,
  PACKAGE_LOCK,
  SHRINKWRAP,
  chooseLockfile,
  discoverProjectCandidates,
  dirOf,
  nearestLockfileDir,
  packageManagerForLockfile,
  PNPM_LOCK,
} from '../core/workspace/scan.js';
import type { HostPlatform, WorkspaceFolder } from './platform/hostPlatform.js';

export class NoProjectFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProjectFoundError';
  }
}

/** The picker was shown and the user dismissed it without choosing: distinct from zero candidates existing at all. */
export class NoProjectSelectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProjectSelectedError';
  }
}

export interface ResolvedProject {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  lockfileText: string | null;
  /** Absolute path to the resolved lockfile, or null if none. Used for file-watcher wiring. May live outside `root` for an npm workspace member. */
  lockfilePath: string | null;
  registry: string;
  resolvedRegistry: ResolvedRegistry;
  peerPolicy: PeerResolutionPolicy;
  packageManager: PackageManagerKind;
  lockfileName: 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml' | null;
  lockfileRoot: string;
  /** Lock-root-relative POSIX pnpm importer id. `.` at the lock root. */
  importerId: string;
}

/**
 * A host-owned project candidate: everything needed to load or label it,
 * plus its workspace folder (never serialized to the webview;
 * `SelectedProjectInfo` in webviewProtocol.ts is the webview-safe subset).
 */
export interface DiscoveredProject extends DiscoveredProjectCandidate {
  folder: WorkspaceFolder;
}

const EXCLUDE_GLOB = `**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`;
const LOCKFILE_GLOB = `**/{${PACKAGE_LOCK},${SHRINKWRAP},${PNPM_LOCK}}`;

async function readIfExists(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Workspace-folder-relative, POSIX-separated: the shape src/core/workspace
 * expects. Unlike resolving against whichever workspace folder contains the
 * path (an ambiguous choice when folders overlap), this is computed against
 * the specific `folder` being scanned, and returns null if the path turns
 * out not to actually be inside it: `findFiles` is scoped to one folder by
 * contract, but this cheap, explicit check guarantees that a candidate can
 * never end up attributed to a folder it doesn't actually live in.
 */
function relativeToFolder(folder: WorkspaceFolder, absolutePath: string): string | null {
  const rel = path.relative(folder.path, absolutePath).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * npm workspaces keep a single lockfile at the repo root covering every
 * member, so a member's lockfile is not in its directory: hence the walk
 * up via nearestLockfileDir rather than a lookup at `dir`.
 */
async function findLockfile(
  platform: HostPlatform,
  folder: WorkspaceFolder,
  projectDir: string,
  preferredPackageManager: PackageManagerKind
): Promise<{ dir: string; name: string } | null> {
  const files = await platform.findFiles({ folder, dir: '', include: LOCKFILE_GLOB, exclude: EXCLUDE_GLOB });

  const namesByDir = new Map<string, string[]>();
  for (const file of files) {
    const rel = relativeToFolder(folder, file);
    if (rel === null) continue;
    const dir = dirOf(rel);
    const name = dir === '' ? rel : rel.slice(dir.length + 1);
    namesByDir.set(dir, [...(namesByDir.get(dir) ?? []), name]);
  }

  const dir = nearestLockfileDir(projectDir, [...namesByDir.keys()]);
  if (dir === null) return null;

  const name = chooseLockfile(namesByDir.get(dir) ?? [], preferredPackageManager);
  return name === null ? null : { dir, name };
}

async function resolveRegistryConfiguration(platform: HostPlatform, projectRoot: string): Promise<{
  registry: ResolvedRegistry;
  peerPolicy: PeerResolutionPolicy;
}> {
  // Project .npmrc is attacker-controlled content in a cloned repo. Trust is
  // checked here as well as at activation because this is the read that
  // actually consumes it. See the SECURITY block in core/registry/npmrc.ts.
  const configured = platform.getSetting<boolean>('registry.useProjectNpmrc', true);
  const allowProjectNpmrc = configured && platform.isWorkspaceTrusted();

  const projectNpmrc = allowProjectNpmrc
    ? await readIfExists(path.join(projectRoot, '.npmrc'))
    : undefined;
  const userNpmrc = await readIfExists(path.join(homedir(), '.npmrc'));

  const resolveOptions = {
    allowProjectNpmrc,
    ...(projectNpmrc === undefined ? {} : { projectNpmrc }),
    ...(userNpmrc === undefined ? {} : { userNpmrc }),
  };
  const { registry } = resolveRegistry(resolveOptions);
  return { registry, peerPolicy: resolvePeerResolutionPolicy(resolveOptions) };
}

/**
 * Scans every open WorkspaceFolder for package.json candidates: cheap, no
 * file content read. `findFiles` is scoped per folder, never a raw
 * recursive walk. Returns [] when no folder
 * is open or none contain a package.json. The caller decides what that
 * means (DashboardPanel reports it as the existing "no project" error).
 */
export async function discoverProjects(
  platform: HostPlatform,
  performance: PerformanceRecorder = NOOP_PERFORMANCE_RECORDER
): Promise<DiscoveredProject[]> {
  const endDiscovery = performance.start('project discovery');
  const folders = platform.workspaceFolders();
  const foldersById = new Map<string, WorkspaceFolder>();
  const sources: ProjectCandidateSource[] = [];

  for (const folder of folders) {
    const folderId = folder.id;
    foldersById.set(folderId, folder);
    const manifestFiles = await platform.findFiles({
      folder,
      dir: '',
      include: '**/package.json',
      exclude: EXCLUDE_GLOB,
    });
    const manifestPaths = manifestFiles
      .map((file) => relativeToFolder(folder, file))
      .filter((rel): rel is string => rel !== null);
    sources.push({ folderId, folderName: folder.name, manifestPaths });
  }

  const candidates = discoverProjectCandidates(sources).map((candidate) => {
    const folder = foldersById.get(candidate.folderId);
    // Every id here was derived from a folderId this same loop just put in
    // the map, so this is always found: the assertion documents that
    // invariant rather than papering over a real possibility of failure.
    if (folder === undefined) throw new Error('unreachable: candidate references an unknown workspace folder');
    return { ...candidate, folder };
  });
  endDiscovery({ 'workspace folders': folders.length, candidates: candidates.length });
  return candidates;
}

/** Reads one specific, already-discovered candidate's manifest/lockfile and resolves its registry. Never reads anything not already produced by `discoverProjects`. */
export async function loadProject(
  platform: HostPlatform,
  candidate: DiscoveredProject,
  performance: PerformanceRecorder = NOOP_PERFORMANCE_RECORDER
): Promise<ResolvedProject> {
  const base = candidate.folder.path;
  const root = candidate.dir === '' ? base : path.join(base, candidate.dir);
  const endManifestRead = performance.start('manifest read');
  const manifestText = await readFile(path.join(base, candidate.manifestPath), 'utf8');
  endManifestRead({ bytes: Buffer.byteLength(manifestText) });
  const endManifestParse = performance.start('manifest parse');
  const manifest = parseManifest(manifestText);
  endManifestParse({ dependencies: manifest.dependencies.length });
  const preferredPackageManager = manifest.packageManager?.name ?? 'npm';

  const endLockfileDiscovery = performance.start('lockfile discovery');
  const lockfile = await findLockfile(platform, candidate.folder, candidate.dir, preferredPackageManager);
  endLockfileDiscovery({ found: lockfile !== null });
  const lockfilePath = lockfile === null ? null : path.join(base, lockfile.dir, lockfile.name);
  const endLockfileRead = performance.start('lockfile read');
  const lockfileText = lockfilePath === null ? null : ((await readIfExists(lockfilePath)) ?? null);
  endLockfileRead({ bytes: lockfileText === null ? 0 : Buffer.byteLength(lockfileText) });
  const packageManager =
    (lockfile === null ? null : packageManagerForLockfile(lockfile.name)) ?? preferredPackageManager;
  const lockfileRoot = lockfile === null ? root : path.join(base, lockfile.dir);
  const importerRelative = path.relative(lockfileRoot, root).split(path.sep).join('/');
  const importerId = importerRelative === '' ? '.' : importerRelative;

  const configuration = await resolveRegistryConfiguration(platform, root);
  return {
    root,
    manifestText,
    lockfileText,
    lockfilePath,
    registry: configuration.registry.url,
    resolvedRegistry: configuration.registry,
    peerPolicy: configuration.peerPolicy,
    packageManager,
    lockfileName:
      lockfile === null
        ? null
        : (lockfile.name as 'package-lock.json' | 'npm-shrinkwrap.json' | 'pnpm-lock.yaml'),
    lockfileRoot,
    importerId,
  };
}
