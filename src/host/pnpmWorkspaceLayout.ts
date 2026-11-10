/**
 * Reads the pnpm workspace files that Upgrade Review's isolated resolver
 * needs, so `workspace:` and `catalog:` specifiers resolve in the temporary
 * project exactly as they do in the real workspace.
 *
 * pnpm itself decides workspace membership. The `packages` patterns are
 * copied as written, and every package.json that a pattern could match is
 * staged. pnpm ignores the ones that are not members.
 *
 * Only settings that shape resolution and name no paths are copied, from
 * pnpm-workspace.yaml, the lock-root .npmrc and each manifest's `pnpm`
 * field. Paths, credentials, stores and pnpmfiles never reach the temporary
 * project.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

import { load as loadYaml } from 'js-yaml';

import type { IsolatedWorkspaceLayout } from './resolverVerifier.js';

/** A staged workspace plus a hash of every file in it. */
export interface PnpmWorkspaceLayout extends IsolatedWorkspaceLayout {
  fingerprint: string;
}

const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';
const NPMRC = '.npmrc';

/** Manifest `pnpm` field keys that change resolution without naming files. */
const MANIFEST_RESOLUTION_KEYS = [
  'overrides',
  'packageExtensions',
  'peerDependencyRules',
  'allowedDeprecatedVersions',
  'supportedArchitectures',
  'ignoredOptionalDependencies',
] as const;

/** Workspace settings that change resolution without naming files. */
const SETTING_KEYS = [
  ...MANIFEST_RESOLUTION_KEYS,
  'catalog',
  'catalogs',
  'catalogMode',
  'linkWorkspacePackages',
  'preferWorkspacePackages',
  'injectWorkspacePackages',
  'saveWorkspaceProtocol',
  'dedupePeerDependents',
  'dedupeDirectDeps',
  'dedupeInjectedDeps',
  'resolutionMode',
  'resolvePeersFromWorkspaceRoot',
  'autoInstallPeers',
  'strictPeerDependencies',
  'excludeLinksFromLockfile',
  'peersSuffixMaxLength',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
] as const;

/** The same scalar settings as .npmrc keys, which pnpm 9 reads instead of the workspace file. */
const NPMRC_KEYS = new Set([
  'link-workspace-packages',
  'prefer-workspace-packages',
  'inject-workspace-packages',
  'save-workspace-protocol',
  'dedupe-peer-dependents',
  'dedupe-direct-deps',
  'dedupe-injected-deps',
  'resolution-mode',
  'resolve-peers-from-workspace-root',
  'auto-install-peers',
  'strict-peer-dependencies',
  'exclude-links-from-lockfile',
  'peers-suffix-max-length',
  'minimum-release-age',
]);

const GLOB_CHARS = /[*?[\]{}()!+@]/;
const MAX_DISCOVERY_DEPTH = 6;
const MAX_DIRECTORY_READS = 2000;
const MAX_CANDIDATES = 500;

async function readIfExists(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) if (record[key] !== undefined) picked[key] = record[key];
  return picked;
}

function isSafeRelativePath(id: string): boolean {
  if (id.includes('\\') || path.posix.isAbsolute(id) || /^[a-z]:/i.test(id)) return false;
  return id.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A leading `!` excludes, except the `!(...)` extglob, which matches. */
function isExclusion(pattern: string): boolean {
  return pattern.startsWith('!') && !pattern.startsWith('!(');
}

/** A pattern stays inside the workspace when it is relative and never steps up with `..`. */
function isContainedPattern(pattern: string): boolean {
  const body = isExclusion(pattern) ? pattern.slice(1) : pattern;
  if (body === '' || body.includes('\\') || path.posix.isAbsolute(body) || /^[a-z]:/i.test(body)) return false;
  return body.split('/').every((segment) => segment !== '..');
}

/**
 * The literal leading directories of a positive pattern and how deep its
 * glob part may reach. `apps/*` walks only `apps/`, one level deep.
 */
function walkPlan(pattern: string): { prefix: string[]; depth: number; unbounded: boolean } {
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
  const globIndex = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (globIndex === -1) return { prefix: segments, depth: 0, unbounded: false };
  const rest = segments.slice(globIndex);
  const unbounded = rest.some((segment) => segment.includes('**') || segment.includes('{'));
  return { prefix: segments.slice(0, globIndex), depth: unbounded ? MAX_DISCOVERY_DEPTH : rest.length, unbounded };
}

function isInside(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/** Reads a file whose real path stays inside the workspace. `escapes` marks one that leaves it. */
async function readContained(realRoot: string, absolutePath: string): Promise<{ text?: string; escapes?: true }> {
  let real: string;
  try {
    real = await realpath(absolutePath);
  } catch {
    return {};
  }
  if (!isInside(realRoot, real)) return { escapes: true };
  const text = await readIfExists(real);
  return text === undefined ? {} : { text };
}

/**
 * Directories with a package.json that some positive pattern could match,
 * as lock-root-relative POSIX paths. node_modules and dot directories are
 * skipped. `complete` is false when a limit cut the walk short, and
 * `escaped` is true when a directory resolves outside the workspace. Either
 * way a member may be missing.
 */
async function collectCandidates(
  realRoot: string,
  patterns: readonly string[],
  signal?: AbortSignal
): Promise<{ candidates: string[]; complete: boolean; escaped: boolean }> {
  const candidates = new Set<string>();
  const visited = new Set<string>();
  let reads = 0;
  let complete = true;
  let escaped = false;
  const visit = async (relative: string, depthLeft: number, unbounded: boolean): Promise<void> => {
    if (signal?.aborted) throw new Error('Workspace discovery was cancelled.');
    const key = `${relative}\u0000${depthLeft}`;
    if (visited.has(key)) return;
    if (reads >= MAX_DIRECTORY_READS || candidates.size >= MAX_CANDIDATES) {
      complete = false;
      return;
    }
    visited.add(key);
    let entries;
    try {
      const real = await realpath(path.join(realRoot, ...relative.split('/').filter(Boolean)));
      if (!isInside(realRoot, real)) {
        escaped = true;
        return;
      }
      reads += 1;
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return;
    }
    if (relative !== '' && entries.some((entry) => entry.name === 'package.json' && !entry.isDirectory())) {
      candidates.add(relative);
    }
    const children = entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) &&
      !entry.name.startsWith('.') && entry.name !== 'node_modules');
    if (depthLeft === 0) {
      if (unbounded && children.length > 0) complete = false;
      return;
    }
    for (const entry of children) {
      await visit(relative === '' ? entry.name : `${relative}/${entry.name}`, depthLeft - 1, unbounded);
    }
  };
  for (const pattern of patterns) {
    if (isExclusion(pattern)) continue;
    const plan = walkPlan(pattern);
    if (plan.prefix.some((segment) => segment.startsWith('.') || segment === 'node_modules')) continue;
    await visit(plan.prefix.join('/'), plan.depth, plan.unbounded);
  }
  return { candidates: [...candidates], complete, escaped };
}

const LOCAL_PROTOCOL = /^(?:link|file|portal|git\+file):(.*)$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * True when a dependency specifier anywhere in `value` points at a local
 * path outside the workspace, judged from `baseDir` (lock-root-relative).
 * pnpm reads such paths during resolution, which would leave the temporary
 * project.
 */
function referencesOutside(value: unknown, baseDir: string): boolean {
  if (typeof value === 'string') {
    const target = LOCAL_PROTOCOL.exec(value)?.[1] ?? (/^(?:\.{1,2}\/|\/|~)/.test(value) ? value : undefined);
    if (target === undefined) return false;
    if (target.startsWith('~') || path.posix.isAbsolute(target) || /^[a-z]:/i.test(target) || target.includes('\\')) return true;
    const resolved = path.posix.normalize(path.posix.join(baseDir, target));
    return resolved === '..' || resolved.startsWith('../');
  }
  if (Array.isArray(value)) return value.some((entry) => referencesOutside(entry, baseDir));
  const record = asRecord(value);
  return record !== null && Object.values(record).some((entry) => referencesOutside(entry, baseDir));
}

function manifestReferencesOutside(text: string, baseDir: string): boolean {
  try {
    const manifest = asRecord(JSON.parse(text)) ?? {};
    return [...DEPENDENCY_FIELDS, 'pnpm'].some((field) => referencesOutside(manifest[field], baseDir));
  } catch {
    return false;
  }
}

/** A copied manifest keeps only resolution keys in its `pnpm` field. */
function sanitizedManifest(text: string): string | undefined {
  try {
    const manifest = asRecord(JSON.parse(text));
    if (manifest === null) return undefined;
    if (manifest['pnpm'] === undefined) return text;
    const pnpm = asRecord(manifest['pnpm']);
    const { pnpm: _dropped, ...rest } = manifest;
    return JSON.stringify(pnpm === null ? rest : { ...rest, pnpm: pick(pnpm, MANIFEST_RESOLUTION_KEYS) }, null, 2);
  } catch {
    return undefined;
  }
}

/** Allowlisted scalar settings only. Credentials, registries and paths are left out. */
function sanitizedNpmrc(text: string): string | undefined {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*([a-z-]+)\s*=\s*([\w.-]+)\s*$/.exec(raw);
    if (match !== null && NPMRC_KEYS.has(match[1] ?? '')) lines.push(`${match[1]}=${match[2]}`);
  }
  return lines.length === 0 ? undefined : `${lines.join('\n')}\n`;
}

function fingerprintFiles(files: readonly { path: string; text: string }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update('\u0000').update(file.text).update('\u0000');
  }
  return hash.digest('hex');
}

/**
 * Returns undefined when the lock root has no pnpm-workspace.yaml or the
 * files cannot be read, so the resolver keeps its single-project layout.
 * The fingerprint covers every staged file, so editing any of them makes a
 * review stale. `unavailableReason` is set when the staged copy could differ
 * from the real workspace, and the review then reports an unknown result.
 */
export async function readPnpmWorkspaceLayout(input: {
  lockfileRoot: string;
  importerId: string;
  signal?: AbortSignal;
}): Promise<PnpmWorkspaceLayout | undefined> {
  try {
    const realRoot = await realpath(input.lockfileRoot);
    const workspaceRead = await readContained(realRoot, path.join(realRoot, WORKSPACE_MANIFEST));
    if (workspaceRead.text === undefined && workspaceRead.escapes === undefined) return undefined;
    if (input.importerId !== '.' && !isSafeRelativePath(input.importerId)) return undefined;
    let unavailableReason: string | undefined;
    const incomplete = (reason: string): void => {
      unavailableReason ??= reason;
    };
    if (workspaceRead.escapes) incomplete('pnpm-workspace.yaml resolves outside the workspace.');
    const source = asRecord(loadYaml(workspaceRead.text ?? '')) ?? {};
    const rawPatterns = Array.isArray(source['packages']) ? source['packages'] : [];
    const patterns = rawPatterns.filter((entry): entry is string => typeof entry === 'string' && isContainedPattern(entry));
    const settings = pick(source, SETTING_KEYS);
    if (referencesOutside(settings, '.')) incomplete('A workspace setting points at a local path outside the workspace.');
    // JSON is valid YAML and needs no serializer.
    const workspace = { packages: patterns, ...settings };
    const files: { path: string; text: string }[] = [
      { path: WORKSPACE_MANIFEST, text: `${JSON.stringify(workspace, null, 2)}\n` },
    ];
    const npmrc = await readContained(realRoot, path.join(realRoot, NPMRC));
    const sanitizedRc = npmrc.text === undefined ? undefined : sanitizedNpmrc(npmrc.text);
    if (sanitizedRc !== undefined) files.push({ path: NPMRC, text: sanitizedRc });
    const discovery = await collectCandidates(realRoot, patterns, input.signal);
    if (discovery.escaped) incomplete('A workspace package directory resolves outside the workspace.');
    if (!discovery.complete) incomplete('The workspace has more packages than the review can stage.');
    for (const id of ['.', ...discovery.candidates]) {
      if (id === input.importerId || (id !== '.' && !isSafeRelativePath(id))) continue;
      const relative = id === '.' ? 'package.json' : `${id}/package.json`;
      const read = await readContained(realRoot, path.join(realRoot, ...relative.split('/')));
      if (read.escapes) incomplete(`${relative} resolves outside the workspace.`);
      const text = read.text === undefined ? undefined : sanitizedManifest(read.text);
      if (text === undefined) continue;
      if (manifestReferencesOutside(text, id)) incomplete(`${relative} points at a local path outside the workspace.`);
      files.push({ path: relative, text });
    }
    return {
      importerId: input.importerId,
      files,
      fingerprint: fingerprintFiles(files),
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    };
  } catch {
    return undefined;
  }
}
