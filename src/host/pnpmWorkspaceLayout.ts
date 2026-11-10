/**
 * Reads the pnpm workspace files that Upgrade Review's isolated resolver
 * needs: pnpm-workspace.yaml and every other workspace manifest. Without
 * them pnpm cannot resolve `workspace:` or `catalog:` specifiers in the
 * temporary project.
 *
 * Only resolution data is copied. pnpm-workspace.yaml and the `pnpm` field
 * of each copied manifest keep an allowlist of keys, so settings that name
 * directories or files (lockfileDir, storeDir, patchedDependencies and the
 * like) never reach the temporary project.
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { load as loadYaml } from 'js-yaml';

import type { IsolatedWorkspaceLayout } from './resolverVerifier.js';

const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';
const RESOLUTION_KEYS = [
  'overrides',
  'packageExtensions',
  'peerDependencyRules',
  'allowedDeprecatedVersions',
] as const;
const WORKSPACE_KEYS = ['packages', 'catalog', 'catalogs', ...RESOLUTION_KEYS] as const;
const MAX_DISCOVERY_DEPTH = 6;
const MAX_MEMBERS = 500;
const SKIPPED_DIRS = new Set(['node_modules']);

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

function isSafeRelativePath(id: string, allowGlobs = false): boolean {
  if (id.includes('\\') || path.posix.isAbsolute(id) || /^[a-z]:/i.test(id)) return false;
  return id.split('/').every((segment) =>
    segment !== '' && segment !== '.' && segment !== '..' && (allowGlobs || !/[*?[\]{}!]/.test(segment)));
}

/** Supports `*`, `**`, `?` and `[...]` classes (`[!...]` negates). Other characters match literally. */
function globToRegExp(pattern: string): RegExp {
  const segmentSource = (segment: string): string => {
    let source = '';
    for (let index = 0; index < segment.length; index += 1) {
      const char = segment[index] ?? '';
      const close = char === '[' ? segment.indexOf(']', index + 2) : -1;
      if (close > index) {
        const body = segment.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
        source += `[${body}]`;
        index = close;
      } else if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return source;
  };
  const parts = pattern.split('/');
  let source = '';
  parts.forEach((segment, index) => {
    const last = index === parts.length - 1;
    if (segment === '**') source += last ? '.+' : '(?:[^/]+/)*';
    else source += segmentSource(segment) + (last ? '' : '/');
  });
  return new RegExp(`^${source}$`);
}

/** Drops a leading `./` and a trailing `/`, which pnpm accepts in package patterns. */
function normalizePattern(pattern: string): string {
  const negated = pattern.startsWith('!');
  let body = negated ? pattern.slice(1) : pattern;
  while (body.startsWith('./')) body = body.slice(2);
  while (body.endsWith('/')) body = body.slice(0, -1);
  return negated ? `!${body}` : body;
}

/** Expands one level of `{a,b}` alternatives, the common form in workspace patterns. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (match === null) return [pattern];
  return (match[1] ?? '').split(',').flatMap((option) =>
    expandBraces(pattern.slice(0, match.index) + option + pattern.slice(match.index + match[0].length)));
}

/** Keeps package patterns that stay inside the workspace. */
function safePackagePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string')
    .map(normalizePattern)
    .flatMap(expandBraces)
    .filter((entry) => isSafeRelativePath(entry.startsWith('!') ? entry.slice(1) : entry, true));
}

/** Directories under the lock root whose relative path matches the workspace patterns. */
async function discoverMembers(lockfileRoot: string, patterns: readonly string[]): Promise<string[]> {
  const include = patterns.filter((pattern) => !pattern.startsWith('!')).map(globToRegExp);
  const exclude = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => globToRegExp(pattern.slice(1)));
  if (include.length === 0) return [];
  const members: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DISCOVERY_DEPTH || members.length >= MAX_MEMBERS) return;
    let entries;
    try {
      entries = await readdir(path.join(lockfileRoot, ...relative.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (include.some((re) => re.test(child)) && !exclude.some((re) => re.test(child))) members.push(child);
      await walk(child, depth + 1);
    }
  };
  await walk('', 1);
  return members;
}

function lockfileImporterIds(lockfileText: string): string[] {
  const importers = asRecord(asRecord(loadYaml(lockfileText))?.['importers']);
  return importers === null ? [] : Object.keys(importers);
}

/** A copied manifest keeps only resolution keys in its `pnpm` field. */
function sanitizedManifest(text: string): string | undefined {
  try {
    const manifest = asRecord(JSON.parse(text));
    if (manifest === null) return undefined;
    const pnpm = asRecord(manifest['pnpm']);
    if (manifest['pnpm'] === undefined) return text;
    const { pnpm: _dropped, ...rest } = manifest;
    return JSON.stringify(pnpm === null ? rest : { ...rest, pnpm: pick(pnpm, RESOLUTION_KEYS) }, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * Returns undefined when the lock root has no pnpm-workspace.yaml or the
 * files cannot be read, so the resolver keeps its single-project layout.
 */
export async function readPnpmWorkspaceLayout(input: {
  lockfileRoot: string;
  importerId: string;
  lockfileText: string;
}): Promise<IsolatedWorkspaceLayout | undefined> {
  try {
    const workspaceText = await readIfExists(path.join(input.lockfileRoot, WORKSPACE_MANIFEST));
    if (workspaceText === undefined) return undefined;
    if (input.importerId !== '.' && !isSafeRelativePath(input.importerId)) return undefined;
    const workspace = pick(asRecord(loadYaml(workspaceText)) ?? {}, WORKSPACE_KEYS);
    const patterns = safePackagePatterns(workspace['packages']);
    const files: { path: string; text: string }[] = [];
    const members: string[] = input.importerId === '.' ? [] : [input.importerId];
    const excluded = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => globToRegExp(pattern.slice(1)));
    const ids = new Set(['.', ...lockfileImporterIds(input.lockfileText), ...await discoverMembers(input.lockfileRoot, patterns)]);
    for (const id of ids) {
      if (id === input.importerId || (id !== '.' && !isSafeRelativePath(id))) continue;
      // A stale importer the workspace now excludes stays out, as it does in the real workspace.
      if (id !== '.' && excluded.some((re) => re.test(id))) continue;
      const relative = id === '.' ? 'package.json' : `${id}/package.json`;
      const raw = await readIfExists(path.join(input.lockfileRoot, ...relative.split('/')));
      const text = raw === undefined ? undefined : sanitizedManifest(raw);
      if (text === undefined) continue;
      files.push({ path: relative, text });
      if (id !== '.') members.push(id);
    }
    // Every copied member is listed by path, so pnpm includes it whatever pattern syntax the original used.
    workspace['packages'] = members;
    // JSON is valid YAML and needs no serializer.
    files.unshift({ path: WORKSPACE_MANIFEST, text: `${JSON.stringify(workspace, null, 2)}\n` });
    return { importerId: input.importerId, files };
  } catch {
    return undefined;
  }
}
