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
import { readdir, readFile } from 'node:fs/promises';
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

/** A pattern stays inside the workspace when it is relative and never steps up with `..`. */
function isContainedPattern(pattern: string): boolean {
  const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (body === '' || body.includes('\\') || path.posix.isAbsolute(body) || /^[a-z]:/i.test(body)) return false;
  return body.split('/').every((segment) => segment !== '..');
}

/**
 * The literal leading directories of a positive pattern and how deep its
 * glob part may reach. `apps/*` walks only `apps/`, one level deep.
 */
function walkPlan(pattern: string): { prefix: string[]; depth: number } {
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
  const globIndex = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (globIndex === -1) return { prefix: segments, depth: 0 };
  const rest = segments.slice(globIndex);
  const unbounded = rest.some((segment) => segment.includes('**') || segment.includes('{'));
  return { prefix: segments.slice(0, globIndex), depth: unbounded ? MAX_DISCOVERY_DEPTH : rest.length };
}

/**
 * Directories with a package.json that some positive pattern could match,
 * as lock-root-relative POSIX paths. Bounded by depth, directory reads and
 * candidates. node_modules and dot directories are skipped.
 */
async function collectCandidates(lockfileRoot: string, patterns: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const candidates = new Set<string>();
  const visited = new Set<string>();
  let reads = 0;
  const visit = async (relative: string, depthLeft: number): Promise<void> => {
    if (signal?.aborted) throw new Error('Workspace discovery was cancelled.');
    if (reads >= MAX_DIRECTORY_READS || candidates.size >= MAX_CANDIDATES) return;
    const key = `${relative}\u0000${depthLeft}`;
    if (visited.has(key)) return;
    visited.add(key);
    reads += 1;
    let entries;
    try {
      entries = await readdir(path.join(lockfileRoot, ...relative.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    if (relative !== '' && entries.some((entry) => entry.isFile() && entry.name === 'package.json')) candidates.add(relative);
    if (depthLeft === 0) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await visit(relative === '' ? entry.name : `${relative}/${entry.name}`, depthLeft - 1);
    }
  };
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const plan = walkPlan(pattern);
    if (plan.prefix.some((segment) => segment.startsWith('.') || segment === 'node_modules')) continue;
    await visit(plan.prefix.join('/'), plan.depth);
  }
  return [...candidates];
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
 * review stale.
 */
export async function readPnpmWorkspaceLayout(input: {
  lockfileRoot: string;
  importerId: string;
  signal?: AbortSignal;
}): Promise<PnpmWorkspaceLayout | undefined> {
  try {
    const workspaceText = await readIfExists(path.join(input.lockfileRoot, WORKSPACE_MANIFEST));
    if (workspaceText === undefined) return undefined;
    if (input.importerId !== '.' && !isSafeRelativePath(input.importerId)) return undefined;
    const source = asRecord(loadYaml(workspaceText)) ?? {};
    const rawPatterns = Array.isArray(source['packages']) ? source['packages'] : [];
    const patterns = rawPatterns.filter((entry): entry is string => typeof entry === 'string' && isContainedPattern(entry));
    // JSON is valid YAML and needs no serializer.
    const workspace = { packages: patterns, ...pick(source, SETTING_KEYS) };
    const files: { path: string; text: string }[] = [
      { path: WORKSPACE_MANIFEST, text: `${JSON.stringify(workspace, null, 2)}\n` },
    ];
    const npmrc = await readIfExists(path.join(input.lockfileRoot, NPMRC));
    const sanitizedRc = npmrc === undefined ? undefined : sanitizedNpmrc(npmrc);
    if (sanitizedRc !== undefined) files.push({ path: NPMRC, text: sanitizedRc });
    const ids = ['.', ...await collectCandidates(input.lockfileRoot, patterns, input.signal)];
    for (const id of ids) {
      if (id === input.importerId || (id !== '.' && !isSafeRelativePath(id))) continue;
      const relative = id === '.' ? 'package.json' : `${id}/package.json`;
      const raw = await readIfExists(path.join(input.lockfileRoot, ...relative.split('/')));
      const text = raw === undefined ? undefined : sanitizedManifest(raw);
      if (text !== undefined) files.push({ path: relative, text });
    }
    return { importerId: input.importerId, files, fingerprint: fingerprintFiles(files) };
  } catch {
    return undefined;
  }
}
