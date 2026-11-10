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

function isMissing(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
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
  // An extglob group that spans a `/` can repeat directories, like a brace or `**`.
  const unbounded = rest.some((segment) => segment.includes('**') || segment.includes('{') ||
    segment.split('(').length !== segment.split(')').length);
  return { prefix: segments.slice(0, globIndex), depth: unbounded ? MAX_DISCOVERY_DEPTH : rest.length, unbounded };
}

function isInside(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * Reads a file whose real path stays inside the workspace. A missing file
 * returns an empty result. `escapes` marks one that leaves the workspace and
 * `failed` one that exists but cannot be read.
 */
async function readContained(
  realRoot: string,
  absolutePath: string
): Promise<{ text?: string; escapes?: true; failed?: true }> {
  try {
    const real = await realpath(absolutePath);
    if (!isInside(realRoot, real)) return { escapes: true };
    return { text: await readFile(real, 'utf8') };
  } catch (cause) {
    return isMissing(cause) ? {} : { failed: true };
  }
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
): Promise<{ candidates: string[]; complete: boolean; escaped: boolean; failed: boolean }> {
  const candidates = new Set<string>();
  const visited = new Set<string>();
  let reads = 0;
  let complete = true;
  let escaped = false;
  let failed = false;
  const visit = async (relative: string, depthLeft: number, unbounded: boolean): Promise<void> => {
    if (signal?.aborted) throw new Error('Workspace discovery was cancelled.');
    const key = `${relative}\u0000${depthLeft}\u0000${unbounded}`;
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
    } catch (cause) {
      if (!isMissing(cause)) failed = true;
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
  return { candidates: [...candidates], complete, escaped, failed };
}

const LOCAL_PROTOCOL = /^(?:link|file|portal|git\+file|workspace):(.*)$/;
const TARBALL = /\.(?:tgz|tar|tar\.gz)$/i;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * True when a dependency specifier anywhere in `value` points at a local
 * path outside the workspace, judged from `baseDir` (lock-root-relative).
 * pnpm reads such paths during resolution, which would leave the temporary
 * project.
 */
function referencesOutside(value: unknown, baseDir: string): boolean {
  if (typeof value === 'string') {
    const protocol = LOCAL_PROTOCOL.exec(value);
    const target = protocol?.[1] ?? value;
    // Every link:, file:, portal: and git+file: target is a path. workspace: holds a path only when it has a `/` or `.`.
    const isPath = (protocol !== null && !value.startsWith('workspace:')) ||
      /^(?:\.{1,2}(?:\/|$)|\/|~\/|[a-z]:)/i.test(target) || target.includes('\\') ||
      (value.startsWith('workspace:') && target.includes('/')) ||
      (TARBALL.test(target) && !/^[a-z][a-z+.-]*:\/\//i.test(target));
    if (!isPath) return false;
    if (target.startsWith('~/') || path.posix.isAbsolute(target) || /^[a-z]:/i.test(target) || target.includes('\\')) return true;
    const resolved = path.posix.normalize(path.posix.join(baseDir, target));
    return resolved === '..' || resolved.startsWith('../');
  }
  if (Array.isArray(value)) return value.some((entry) => referencesOutside(entry, baseDir));
  const record = asRecord(value);
  return record !== null && Object.values(record).some((entry) => referencesOutside(entry, baseDir));
}

function collectPatches(text: string, patches: unknown[]): void {
  try {
    const patched = asRecord(asRecord(JSON.parse(text))?.['pnpm'])?.['patchedDependencies'];
    if (patched !== undefined) patches.push(patched);
  } catch {
    // Parse failures are reported where the manifest is staged.
  }
}

export function manifestReferencesOutside(text: string, baseDir: string): boolean {
  try {
    const manifest = asRecord(JSON.parse(text)) ?? {};
    return [...DEPENDENCY_FIELDS, 'pnpm'].some((field) => referencesOutside(manifest[field], baseDir));
  } catch {
    return false;
  }
}

/** A copied manifest keeps only resolution keys in its `pnpm` field. */
export function sanitizedManifest(text: string): string | undefined {
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

/**
 * Allowlisted scalar settings only, written canonically. Credentials,
 * registries and paths are left out. An allowlisted key with a value that
 * is not a plain scalar is reported, since pnpm would read it differently.
 */
function sanitizedNpmrc(text: string): { text?: string; unsupported?: string } {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!NPMRC_KEYS.has(key)) continue;
    let value = line.slice(separator + 1).replace(/\s+[;#].*$/, '').trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!/^[\w.-]+$/.test(value)) return { unsupported: `The workspace .npmrc sets ${key} to a value the review cannot stage.` };
    lines.push(`${key}=${value}`);
  }
  return lines.length === 0 ? {} : { text: `${lines.join('\n')}\n` };
}

function fingerprintFiles(files: readonly { path: string; text: string }[], reasons: readonly string[]): string {
  const hash = createHash('sha256');
  // Availability counts too, so a change that only makes the workspace unstageable still stales a review.
  for (const reason of reasons) hash.update(reason).update('\u0000');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update('\u0000').update(file.text).update('\u0000');
  }
  return hash.digest('hex');
}

/**
 * Returns undefined when the lock root has no pnpm-workspace.yaml, so the
 * resolver keeps its single-project layout, or when discovery is cancelled.
 * The fingerprint covers every staged file, so editing any of them makes a
 * review stale. `unavailableReason` is set when the staged copy could differ
 * from the real workspace, and the review then reports an unknown result.
 */
export async function readPnpmWorkspaceLayout(input: {
  lockfileRoot: string;
  importerId: string;
  /** The reviewed manifest. It is checked like the others and staged by the resolver. */
  manifestText?: string;
  signal?: AbortSignal;
}): Promise<PnpmWorkspaceLayout | undefined> {
  let realRoot: string;
  try {
    realRoot = await realpath(input.lockfileRoot);
  } catch {
    return undefined;
  }
  const workspaceRead = await readContained(realRoot, path.join(realRoot, WORKSPACE_MANIFEST));
  if (workspaceRead.text === undefined && workspaceRead.escapes === undefined && workspaceRead.failed === undefined) {
    return undefined;
  }
  if (input.importerId !== '.' && !isSafeRelativePath(input.importerId)) return undefined;
  const reasons: string[] = [];
  const files: { path: string; text: string }[] = [];
  if (workspaceRead.escapes) reasons.push('pnpm-workspace.yaml resolves outside the workspace.');
  if (workspaceRead.failed) reasons.push('pnpm-workspace.yaml could not be read.');
  let source: Record<string, unknown> = {};
  try {
    source = asRecord(loadYaml(workspaceRead.text ?? '')) ?? {};
  } catch {
    reasons.push('pnpm-workspace.yaml could not be parsed.');
  }
  if (!Array.isArray(source['packages'])) {
    // A settings-only file at a single project's root keeps the single-project layout used before workspaces were staged.
    if (input.importerId === '.' && reasons.length === 0) return undefined;
    reasons.push('pnpm-workspace.yaml has no packages list to stage.');
  }
  const rawPatterns = Array.isArray(source['packages']) ? source['packages'] : [];
  const patterns: string[] = [];
  for (const entry of rawPatterns) {
    if (typeof entry === 'string' && isContainedPattern(entry)) patterns.push(entry);
    else if (typeof entry !== 'string' || !isExclusion(entry)) reasons.push('A workspace package pattern points outside the workspace.');
  }
  for (const pattern of patterns) {
    if (!isExclusion(pattern) && walkPlan(pattern).prefix.some((segment) => segment.startsWith('.') || segment === 'node_modules')) {
      reasons.push('A workspace package pattern names a hidden or node_modules directory.');
    }
  }
  const settings = pick(source, SETTING_KEYS);
  // Patches are applied by the real install. Their configuration is part of the fingerprint.
  const patches: unknown[] = [];
  if (source['patchedDependencies'] !== undefined) patches.push(source['patchedDependencies']);
  if (referencesOutside(settings, '.')) reasons.push('A workspace setting points at a local path outside the workspace.');
  // JSON is valid YAML and needs no serializer.
  files.push({ path: WORKSPACE_MANIFEST, text: `${JSON.stringify({ packages: patterns, ...settings }, null, 2)}\n` });
  const npmrc = await readContained(realRoot, path.join(realRoot, NPMRC));
  if (npmrc.failed) reasons.push('The workspace .npmrc could not be read.');
  if (npmrc.escapes) reasons.push('The workspace .npmrc resolves outside the workspace.');
  const sanitizedRc = npmrc.text === undefined ? {} : sanitizedNpmrc(npmrc.text);
  if (sanitizedRc.unsupported !== undefined) reasons.push(sanitizedRc.unsupported);
  if (sanitizedRc.text !== undefined) files.push({ path: NPMRC, text: sanitizedRc.text });
  let discovery;
  try {
    discovery = await collectCandidates(realRoot, patterns, input.signal);
  } catch {
    return undefined;
  }
  if (discovery.escaped) reasons.push('A workspace package directory resolves outside the workspace.');
  if (discovery.failed) reasons.push('A workspace package directory could not be read.');
  if (!discovery.complete) reasons.push('The workspace has more packages than the review can stage.');
  if (input.manifestText !== undefined) {
    collectPatches(input.manifestText, patches);
    if (manifestReferencesOutside(input.manifestText, input.importerId)) {
      reasons.push('The reviewed package.json points at a local path outside the workspace.');
    }
  }
  for (const id of ['.', ...discovery.candidates]) {
    if (id === input.importerId || (id !== '.' && !isSafeRelativePath(id))) continue;
    const relative = id === '.' ? 'package.json' : `${id}/package.json`;
    const read = await readContained(realRoot, path.join(realRoot, ...relative.split('/')));
    if (read.escapes) reasons.push(`${relative} resolves outside the workspace.`);
    if (read.failed) reasons.push(`${relative} could not be read.`);
    if (read.text === undefined) continue;
    collectPatches(read.text, patches);
    const text = sanitizedManifest(read.text);
    if (text === undefined) {
      reasons.push(`${relative} could not be parsed.`);
      continue;
    }
    if (manifestReferencesOutside(text, id)) reasons.push(`${relative} points at a local path outside the workspace.`);
    files.push({ path: relative, text });
  }
  if (patches.length > 0) {
    reasons.push('The workspace patches dependencies, and patches are applied only by a real install.');
    reasons.push(JSON.stringify(patches));
  }
  return {
    importerId: input.importerId,
    files,
    fingerprint: fingerprintFiles(files, reasons),
    ...(reasons[0] === undefined ? {} : { unavailableReason: reasons[0] }),
  };
}
