import { isFsError } from './expectedFsError.js';
/**
 * Decides, once, which directory and which lockfile a dependency change
 * writes, and refuses when that cannot be established safely.
 *
 * Every mutation consumer (the project lock, analysis, the transaction file
 * allowlist, removal, transitive fixes, Smart Cleanup restore, watchers and
 * the cache fingerprint) reads this one answer, so no consumer can invent a
 * lockfile next to package.json while the package manager writes another.
 *
 * Commands still run in the selected project directory. Only ownership (the
 * lock key, snapshot, restore and allowlist) moves to the workspace root.
 *
 * Filesystem reads only. Nothing here starts a process.
 */

import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { load as loadYaml, YAMLException } from 'js-yaml';

import { isRecord } from '../core/validation.js';
import { matchWorkspacePatterns } from '../core/workspace/patterns.js';
import { PACKAGE_LOCK, PNPM_LOCK, SHRINKWRAP } from '../core/workspace/scan.js';
import { candidateNodePaths, realListDir, rethrowUnexpectedResolverError } from './npmResolver.js';
import { canonicalPath, isMissingPathError, relatePaths, segmentsBelow } from './pathIdentity.js';
import {
  findPnpmLockfileOverride,
  LOCKFILE_UNDETERMINED_REASON,
  type PnpmSettingsEnvironment,
} from './pnpmLockfileSettings.js';

export const OUTSIDE_FOLDER_REASON =
  'Dependency changes would write outside this opened folder. Open the workspace root to enable changes.';
export const PATH_ESCAPES_REASON =
  'Dependency file paths use a symbolic link or leave this opened folder. Changes are unavailable.';

export type MutationRefusalCode =
  | 'OUTSIDE_FOLDER'
  | 'PATH_ESCAPES'
  | 'LOCKFILE_UNDETERMINED'
  | 'PNPMFILE'
  | 'PNPM_CONFIG_DEPENDENCIES';

export interface MutationRefusal {
  code: MutationRefusalCode;
  reason: string;
}

export interface MutationTarget {
  /** The directory that owns the lockfile, spelled under the opened folder's path. */
  root: string;
  /** Exact lockfile path, whether or not the file exists yet. */
  lockfilePath: string;
  lockfileName: typeof PACKAGE_LOCK | typeof SHRINKWRAP | typeof PNPM_LOCK;
  lockfileExists: boolean;
  packageManager: 'npm' | 'pnpm';
  /** Root-relative POSIX path of the project, `.` at the root. */
  importerId: string;
  /** The root is an npm or pnpm workspace above the project directory. */
  workspaceMember: boolean;
}

export type MutationTargetResolution =
  | { ok: true; target: MutationTarget; identity: string }
  | { ok: false; refusal: MutationRefusal; identity: string };

export type MutationTargetEnvironment = PnpmSettingsEnvironment;

export interface ResolveMutationTargetInput {
  /** Absolute project directory (where package.json is). */
  projectDir: string;
  /** The workspace folder the project was discovered in. Never a union of folders. */
  folderPath: string;
  packageManager: 'npm' | 'pnpm';
  environment?: MutationTargetEnvironment;
  /** Recovery must fence unexpected resolution failures instead of reporting a safe skip. */
  throwOnUnexpectedError?: boolean;
}

function nodePrefixes(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, homeDir: string, strict: boolean): string[] {
  const prefixes = new Set<string>();
  const candidates = candidateNodePaths({
    platform,
    pathEnv: env['PATH'],
    homeDir,
    fnmDirEnv: env['FNM_DIR'],
    listDir: candidate => realListDir(candidate, strict),
  });
  for (const candidate of candidates) {
    try {
      const real = realpathSync.native(candidate);
      prefixes.add(platform === 'win32' ? path.dirname(real) : path.dirname(path.dirname(real)));
    } catch (cause) {
      rethrowUnexpectedResolverError(cause, strict);
      // Not installed there.
    }
  }
  return [...prefixes];
}

/** The real host: process environment, home directory and every Node installation a task could pick. */
export function defaultMutationTargetEnvironment(strict = false): MutationTargetEnvironment {
  const env = { ...process.env };
  const homeDir = homedir();
  return { env, homeDir, platform: process.platform, nodePrefixes: nodePrefixes(process.platform, env, homeDir, strict) };
}

function refused(code: MutationRefusalCode, reason: string): MutationTargetResolution {
  return { ok: false, refusal: { code, reason }, identity: JSON.stringify(['refused', code, reason]) };
}

function undetermined(detail?: string): MutationTargetResolution {
  return refused('LOCKFILE_UNDETERMINED', detail === undefined ? LOCKFILE_UNDETERMINED_REASON : `${LOCKFILE_UNDETERMINED_REASON} ${detail}`);
}

/**
 * Workspace patterns are matched with a strict subset of glob syntax, so
 * anything outside it is refused by name rather than guessed.
 */
function unsupportedPattern(pattern: string): MutationTargetResolution {
  return undetermined(`Workspace pattern not supported: ${pattern}`);
}

type ReadResult = { status: 'absent' } | { status: 'read'; text: string } | { status: 'unreadable' };

async function readText(filePath: string, strict = false): Promise<ReadResult> {
  try {
    return { status: 'read', text: await readFile(filePath, 'utf8') };
  } catch (cause) {
    if (!(strict ? isMissingPathError(cause) : isFsError(cause))) throw cause;
    return isMissingPathError(cause) ? { status: 'absent' } : { status: 'unreadable' };
  }
}

async function exists(filePath: string, strict = false): Promise<boolean | 'unreadable'> {
  try {
    await lstat(filePath);
    return true;
  } catch (cause) {
    if (!(strict ? isMissingPathError(cause) : isFsError(cause))) throw cause;
    return isMissingPathError(cause) ? false : 'unreadable';
  }
}

/** True when the folder itself or any directory from it down to `dir` is a symbolic link. */
async function hasSymlinkFrom(folder: string, segments: readonly string[]): Promise<boolean> {
  let current = folder;
  for (const segment of ['', ...segments]) {
    if (segment !== '') current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function posixRelative(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

type Membership = { root: string; workspaceManifest: Record<string, unknown> | null } | { refusal: MutationTargetResolution };

/**
 * npm: the nearest ancestor whose package.json `workspaces` includes the
 * project, as npm 8.5 and later find it from a member directory. An
 * ancestor that does not include the project never captures it.
 */
async function npmMembership(project: string, strict: boolean): Promise<Membership> {
  for (let dir = path.dirname(project); ; dir = path.dirname(dir)) {
    const source = await readText(path.join(dir, 'package.json'), strict);
    if (source.status === 'unreadable') return { refusal: undetermined() };
    if (source.status === 'read') {
      let manifest: unknown;
      try {
        manifest = JSON.parse(source.text);
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        // npm cannot use a broken manifest either, but one that names
        // workspaces might have been meant to own this project.
        if (source.text.includes('"workspaces"')) return { refusal: undetermined() };
        manifest = undefined;
      }
      const workspaces = isRecord(manifest) ? manifest['workspaces'] : undefined;
      if (workspaces !== undefined) {
        const patterns = Array.isArray(workspaces)
          ? workspaces
          : isRecord(workspaces) && Array.isArray(workspaces['packages']) ? workspaces['packages'] : null;
        if (patterns === null || !patterns.every((entry): entry is string => typeof entry === 'string')) {
          return { refusal: undetermined() };
        }
        const match = matchWorkspacePatterns(patterns, posixRelative(dir, project));
        if (match.result === 'unsupported') return { refusal: unsupportedPattern(match.pattern) };
        if (match.result === 'included') return { root: dir, workspaceManifest: null };
      }
    }
    if (path.dirname(dir) === dir) return { root: project, workspaceManifest: null };
  }
}

/**
 * pnpm: the nearest pnpm-workspace.yaml at or above the project is the
 * workspace, whatever its `packages` say, because some pnpm versions do not
 * check membership. A file that does not list the project is refused: the
 * lockfile written then depends on the pnpm version.
 */
async function pnpmMembership(project: string, strict: boolean): Promise<Membership> {
  for (let dir = project; ; dir = path.dirname(dir)) {
    const misnamed = await exists(path.join(dir, 'pnpm-workspace.yml'), strict);
    if (misnamed !== false) return { refusal: undetermined() };
    const source = await readText(path.join(dir, 'pnpm-workspace.yaml'), strict);
    if (source.status === 'unreadable') return { refusal: undetermined() };
    if (source.status === 'read') {
      let document: unknown;
      try {
        document = loadYaml(source.text);
      } catch (cause) {
        if (!(cause instanceof YAMLException)) throw cause;
        return { refusal: undetermined() };
      }
      if (document === null || document === undefined) document = {};
      if (!isRecord(document)) return { refusal: undetermined() };
      if (dir !== project) {
        const packages = document['packages'];
        if (!Array.isArray(packages) || !packages.every((entry): entry is string => typeof entry === 'string')) {
          return { refusal: undetermined() };
        }
        const match = matchWorkspacePatterns(packages, posixRelative(dir, project));
        if (match.result === 'unsupported') return { refusal: unsupportedPattern(match.pattern) };
        if (match.result !== 'included') return { refusal: undetermined() };
      }
      return { root: dir, workspaceManifest: document };
    }
    if (path.dirname(dir) === dir) return { root: project, workspaceManifest: null };
  }
}

/** Resolves the mutation target for one project in its owning folder. */
export async function resolveMutationTarget(input: ResolveMutationTargetInput): Promise<MutationTargetResolution> {
  try {
    return await resolveOrRefuse(input);
  } catch (cause) {
    if (input.throwOnUnexpectedError || !isFsError(cause)) throw cause;
    // A filesystem error part way through means the answer is unknown, and
    // an unknown answer is an expected refusal, not an internal failure.
    return undetermined();
  }
}

async function resolveOrRefuse(input: ResolveMutationTargetInput): Promise<MutationTargetResolution> {
  const strict = input.throwOnUnexpectedError === true;
  const folder = path.resolve(input.folderPath);
  const projectDir = path.resolve(input.projectDir);
  const lexical = path.relative(folder, projectDir);
  if (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
    return refused('PATH_ESCAPES', PATH_ESCAPES_REASON);
  }
  // Links above the opened folder (a home directory alias, /tmp on macOS)
  // are fine. From the folder down they could point a write anywhere.
  if (await hasSymlinkFrom(folder, lexical === '' ? [] : lexical.split(path.sep))) {
    return refused('PATH_ESCAPES', PATH_ESCAPES_REASON);
  }
  // The native realpath gives the on-disk spelling, so the comparisons
  // below are exact and never fold case.
  const canonicalFolder = await canonicalPath(folder);
  const project = await canonicalPath(projectDir);
  if (relatePaths(canonicalFolder, project) === 'outside') return refused('PATH_ESCAPES', PATH_ESCAPES_REASON);

  const membership = input.packageManager === 'npm' ? await npmMembership(project, strict) : await pnpmMembership(project, strict);
  if ('refusal' in membership) return membership.refusal;
  const root = membership.root;
  if (relatePaths(canonicalFolder, root) === 'outside') return refused('OUTSIDE_FOLDER', OUTSIDE_FOLDER_REASON);

  let lockfileName: MutationTarget['lockfileName'];
  if (input.packageManager === 'pnpm') {
    lockfileName = PNPM_LOCK;
  } else {
    const shrinkwrap = await exists(path.join(root, SHRINKWRAP), strict);
    if (shrinkwrap === 'unreadable') return undetermined();
    lockfileName = shrinkwrap ? SHRINKWRAP : PACKAGE_LOCK;
  }
  const canonicalLockfile = path.join(root, lockfileName);
  let lockfileExists = false;
  try {
    const stat = await lstat(canonicalLockfile);
    if (stat.isSymbolicLink() || !stat.isFile()) return refused('PATH_ESCAPES', PATH_ESCAPES_REASON);
    lockfileExists = true;
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      if (input.throwOnUnexpectedError || !isFsError(cause)) throw cause;
      return undetermined();
    }
  }

  if (input.packageManager === 'pnpm') {
    const override = await findPnpmLockfileOverride({
      projectDir: project,
      workspaceRoot: root,
      workspaceManifest: membership.workspaceManifest,
      environment: input.environment ?? defaultMutationTargetEnvironment(strict),
      throwOnUnexpectedError: strict,
    });
    if (override !== null) return refused(override.code, override.reason);
  }

  // Consumers compare these with paths built from the folder's own
  // spelling, so express them the same way. Identity uses canonical paths.
  const lexicalRoot = path.join(input.folderPath, ...segmentsBelow(canonicalFolder, root));
  const importerId = posixRelative(root, project);
  const target: MutationTarget = {
    root: lexicalRoot,
    lockfilePath: path.join(lexicalRoot, lockfileName),
    lockfileName,
    lockfileExists,
    packageManager: input.packageManager,
    importerId,
    workspaceMember: importerId !== '.',
  };
  return {
    ok: true,
    target,
    identity: JSON.stringify(['target', input.packageManager, root, canonicalLockfile, importerId]),
  };
}

/** The identity two resolutions are compared by. Undefined when none was resolved. */
export function mutationTargetIdentity(resolution: MutationTargetResolution | null | undefined): string | undefined {
  return resolution?.identity;
}

/** Spread into `computeSourceFingerprint` input, so every fingerprint of one project agrees on the target. */
export function targetFingerprintField(
  resolution: MutationTargetResolution | null | undefined
): { mutationTargetIdentity?: string } {
  return resolution === null || resolution === undefined ? {} : { mutationTargetIdentity: resolution.identity };
}

/** Answer for a source that carries no resolution at all: never authority to write. */
export const UNRESOLVED_MUTATION_TARGET: MutationTargetResolution = {
  ok: false,
  refusal: { code: 'LOCKFILE_UNDETERMINED', reason: LOCKFILE_UNDETERMINED_REASON },
  identity: JSON.stringify(['refused', 'LOCKFILE_UNDETERMINED', LOCKFILE_UNDETERMINED_REASON]),
};
