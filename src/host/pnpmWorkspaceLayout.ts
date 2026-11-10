/**
 * Stages the pnpm workspace around a reviewed project for Upgrade Review's
 * isolated resolver, so `workspace:` and `catalog:` specifiers resolve as
 * they do in the real workspace.
 *
 * One bounded walk collects every package.json under the lock root, and
 * pnpm decides which of them are members. Configuration is staged exactly
 * as written. Whenever the staged copy could resolve differently from the
 * real workspace (an unrecognized setting, a hook or patch, a local path
 * outside the workspace, a limit reached, a file that cannot be read), the
 * layout carries an `unavailableReason` and the review reports unknown.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { load as loadYaml } from 'js-yaml';

import { classifySpecifier } from '../core/manifest/parse.js';
import type { IsolatedWorkspaceLayout } from './resolverVerifier.js';

/** A staged workspace plus a hash of everything that shapes its resolution. */
export interface PnpmWorkspaceLayout extends IsolatedWorkspaceLayout {
  fingerprint: string;
}

const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';
const NPMRC = '.npmrc';
const MAX_DEPTH = 16;
const MAX_DIRECTORY_READS = 5000;
const MAX_MANIFESTS = 1000;

/** Manifest `pnpm` field keys that name no files. */
const MANIFEST_SETTINGS = [
  'overrides', 'packageExtensions', 'peerDependencyRules', 'allowedDeprecatedVersions', 'supportedArchitectures',
  'ignoredOptionalDependencies', 'onlyBuiltDependencies', 'neverBuiltDependencies', 'ignoredBuiltDependencies',
  'allowBuilds', 'updateConfig', 'auditConfig',
];

/** Workspace settings that name no files. Anything else makes the layout unavailable. */
const WORKSPACE_SETTINGS = new Set([
  ...MANIFEST_SETTINGS, 'packages', 'catalog', 'catalogs', 'catalogMode', 'linkWorkspacePackages',
  'preferWorkspacePackages', 'injectWorkspacePackages', 'saveWorkspaceProtocol', 'dedupePeerDependents',
  'dedupeDirectDeps', 'dedupeInjectedDeps', 'resolutionMode', 'resolvePeersFromWorkspaceRoot', 'autoInstallPeers',
  'strictPeerDependencies', 'excludeLinksFromLockfile', 'peersSuffixMaxLength', 'ignoreCompatibilityDb',
  'minimumReleaseAge', 'minimumReleaseAgeExclude', 'trustPolicy', 'trustPolicyExclude', 'nodeLinker',
  'shamefullyHoist', 'hoistPattern', 'publicHoistPattern', 'savePrefix', 'saveExact', 'engineStrict',
]);

/** The same settings as .npmrc keys, plus a few that only affect fetching or saving. */
const NPMRC_SETTINGS = new Set([
  ...[...WORKSPACE_SETTINGS].map((key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
  'fetch-retries', 'fetch-timeout', 'network-concurrency', 'prefer-offline', 'enable-pre-post-scripts',
]);

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isInside(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/** The local path a specifier names, as pnpm reads it, or undefined for anything that is not local. */
function localTarget(spec: string): string | undefined {
  const value = spec.trim();
  // pnpm reads protocols in any case.
  const lower = value.toLowerCase();
  for (const protocol of ['portal:', 'link:', 'file:', 'git+file:']) {
    if (lower.startsWith(protocol)) return value.slice(protocol.length);
  }
  if (lower.startsWith('workspace:')) {
    const rest = value.slice('workspace:'.length);
    return rest.startsWith('.') || rest.includes('/') ? rest : undefined;
  }
  return classifySpecifier(value).unresolvable === 'file' ? value : undefined;
}

/** True when a specifier anywhere in `value` names a local path outside the lock root, judged from `baseDir`. */
function referencesOutside(value: unknown, baseDir: string): boolean {
  if (typeof value === 'string') {
    const target = localTarget(value)?.replace(/^\/\/(?=\/)/, '');
    if (target === undefined) return false;
    if (/^(?:~|[\\/]|[a-z]:)/i.test(target) || target.includes('\\')) return true;
    const resolved = path.posix.normalize(path.posix.join(baseDir, target));
    return resolved === '..' || resolved.startsWith('../');
  }
  if (Array.isArray(value)) return value.some((entry) => referencesOutside(entry, baseDir));
  return Object.values(asRecord(value) ?? {}).some((entry) => referencesOutside(entry, baseDir));
}

/**
 * Every brace expansion of a pattern, with `{a..b}` ranges kept as one
 * literal. Undefined when there are too many to check.
 */
function expandBraces(pattern: string, limit = { left: 256 }): string[] | undefined {
  const text = pattern.replace(/\{[^{},]*\.\.[^{},]*\}/g, 'range');
  const open = text.indexOf('{');
  let depth = 0;
  const commas: number[] = [];
  for (let index = open; open !== -1 && index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      if (commas.length === 0) return expandBraces(text.slice(0, open) + text.slice(open + 1, index) + text.slice(index + 1), limit);
      const options = [open, ...commas].map((start, i) => text.slice(start + 1, [...commas, index][i]));
      const results: string[] = [];
      for (const option of options) {
        const expanded = expandBraces(text.slice(0, open) + option + text.slice(index + 1), limit);
        if (expanded === undefined) return undefined;
        results.push(...expanded);
      }
      return results;
    } else if (char === ',' && depth === 1) commas.push(index);
  }
  return --limit.left < 0 ? undefined : [text];
}

/** True when every expansion of a pattern is relative and never steps up with `..`. */
function isContainedPattern(pattern: string): boolean {
  // Only plain names, `/`, `*`, `?` and brace lists are interpreted. Escapes, classes and extglobs are not.
  if (!/^[\w@.\-/*?{},]*$/.test(pattern)) return false;
  // Numeric ranges only produce digits. A character range such as {-..0} can produce `.` and `/`, so it is not interpreted.
  const ranges = pattern.match(/\{[^{},]*\.\.[^{},]*\}/g) ?? [];
  if (ranges.some((range) => !/^\{-?\d+\.\.-?\d+(?:\.\.-?\d+)?\}$/.test(range))) return false;
  return expandBraces(pattern)?.every((expanded) => !/^(?:[\\/]|[a-z]:)/i.test(expanded) &&
    !expanded.split(/[\\/]/).includes('..')) ?? false;
}

/**
 * True when a pattern could select a directory inside `.git`, which the
 * manifest walk never reads. Class and extglob syntax such as `[.]git` or
 * `@(.git)` is not interpreted here, so any pattern using it counts.
 */
function mayMatchGitDir(pattern: string): boolean {
  if (/[[(]/.test(pattern)) return true;
  return expandBraces(pattern)?.some((expanded) => expanded.split(/[\\/]/).some((segment) =>
    segment.toLowerCase().startsWith('.git') || (segment.startsWith('.') && /[*?]/.test(segment)))) ?? true;
}

/** Why a manifest cannot be staged as written, or undefined when it can. */
function manifestProblem(text: string, baseDir: string, relative: string): string | undefined {
  let manifest: Record<string, unknown> | null;
  try {
    manifest = asRecord(JSON.parse(text));
  } catch {
    manifest = null;
  }
  if (manifest === null) return `${relative} could not be parsed.`;
  const pnpm = asRecord(manifest['pnpm']) ?? {};
  const unsupported = Object.keys(pnpm).find((key) => !MANIFEST_SETTINGS.includes(key));
  if (unsupported !== undefined) return `${relative} sets pnpm.${unsupported}, which the review does not stage.`;
  if ([...DEPENDENCY_FIELDS, 'pnpm', 'resolutions', 'overrides'].some((field) => referencesOutside(manifest?.[field], baseDir))) {
    return `${relative} points at a local path outside the workspace.`;
  }
  return undefined;
}

/**
 * Collects lock-root-relative directories that hold a package.json. Hidden
 * directories are included, node_modules and .git are not. Symlinks are
 * followed only inside the workspace.
 */
async function collectManifestDirs(
  realRoot: string,
  reasons: string[],
  signal?: AbortSignal
): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  let reads = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (signal?.aborted) throw new Error('Workspace discovery was cancelled.');
    let real: string;
    let entries;
    try {
      real = await realpath(path.join(realRoot, ...relative.split('/').filter(Boolean)));
      if (!isInside(realRoot, real)) return void reasons.push(`${relative} resolves outside the workspace.`);
      // A second path to the same directory is an alias or a cycle, which the staged copy cannot mirror.
      if (seen.has(real)) return void reasons.push(`${relative} is a second path to a directory already staged.`);
      seen.add(real);
      if (++reads > MAX_DIRECTORY_READS || depth > MAX_DEPTH) {
        return void reasons.push('The workspace has more directories than the review can stage.');
      }
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return void reasons.push(`${relative || 'The workspace root'} could not be read.`);
    }
    for (const entry of entries) {
      if (entry.name === 'package.json5' || entry.name === 'package.yaml') {
        reasons.push(`${relative === '' ? '' : `${relative}/`}${entry.name} is a manifest format the review does not stage.`);
      }
    }
    if (entries.some((entry) => entry.name === 'package.json' && !entry.isDirectory())) {
      if (dirs.length >= MAX_MANIFESTS) return void reasons.push('The workspace has more packages than the review can stage.');
      dirs.push(relative === '' ? '.' : relative);
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      // A symlink is walked only when it points at a directory. File links do not shape membership.
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() &&
        await stat(path.join(real, entry.name)).then((target) => target.isDirectory(), () => false));
      if (isDirectory) {
        await visit(relative === '' ? entry.name : `${relative}/${entry.name}`, depth + 1);
      }
    }
  };
  await visit('', 0);
  return dirs;
}

/** Keeps supported settings verbatim. Registry and credential lines are left out, since the host passes registries itself. */
function stagedNpmrc(text: string, reasons: string[]): string | undefined {
  const kept: string[] = [];
  // pnpm's INI parser also ends a line at a bare CR.
  for (const line of text.split(/[\r\n]+/)) {
    const key = line.trim().split('=')[0]?.trim() ?? '';
    if (key === '' || key.startsWith(';') || key.startsWith('#')) continue;
    if (key === 'registry' || key.endsWith(':registry') || key.startsWith('//')) continue;
    if (!NPMRC_SETTINGS.has(key)) reasons.push(`The workspace .npmrc sets ${key}, which the review does not stage.`);
    else kept.push(line);
  }
  return kept.length === 0 ? undefined : `${kept.join('\n')}\n`;
}

async function readContained(realRoot: string, relative: string, reasons: string[]): Promise<string | undefined> {
  try {
    const real = await realpath(path.join(realRoot, ...relative.split('/')));
    if (!isInside(realRoot, real)) return void reasons.push(`${relative} resolves outside the workspace.`);
    return await readFile(real, 'utf8');
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') reasons.push(`${relative} could not be read.`);
    return undefined;
  }
}

/**
 * Returns undefined when the lock root has no pnpm-workspace.yaml, or only
 * settings for a single project at its root, so the resolver keeps its
 * single-project layout. Also undefined when discovery is cancelled.
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
  const reasons: string[] = [];
  const workspaceText = await readContained(realRoot, WORKSPACE_MANIFEST, reasons);
  if (workspaceText === undefined && reasons.length === 0) return undefined;
  if (input.importerId !== '.' && (input.importerId.includes('\\') || input.importerId.split('/').some(
    (segment) => segment === '' || segment === '.' || segment === '..'))) return undefined;
  let settings: Record<string, unknown> = {};
  try {
    settings = asRecord(loadYaml(workspaceText ?? '')) ?? {};
  } catch {
    reasons.push('pnpm-workspace.yaml could not be parsed.');
  }
  if (!Array.isArray(settings['packages']) && input.importerId === '.' && reasons.length === 0) return undefined;
  for (const key of Object.keys(settings)) {
    if (!WORKSPACE_SETTINGS.has(key)) reasons.push(`pnpm-workspace.yaml sets ${key}, which the review does not stage.`);
  }
  const patterns = Array.isArray(settings['packages']) ? settings['packages'] : [];
  if (patterns.some((pattern) => typeof pattern !== 'string' || !isContainedPattern(pattern.replace(/^!/, '')))) {
    reasons.push('A workspace package pattern points outside the workspace or uses syntax the review does not interpret.');
  }
  if (patterns.some((pattern) => typeof pattern === 'string' && (!/^!(?!\()/.test(pattern) && mayMatchGitDir(pattern)))) {
    reasons.push('A workspace package pattern can select a directory inside .git, which the review does not stage.');
  }
  if (referencesOutside({ ...settings, packages: [] }, '.')) {
    reasons.push('A workspace setting points at a local path outside the workspace.');
  }

  const files: { path: string; text: string }[] = [];
  if (workspaceText !== undefined) files.push({ path: WORKSPACE_MANIFEST, text: workspaceText });
  for (const pnpmfile of ['.pnpmfile.cjs', '.pnpmfile.mjs']) {
    if (await readContained(realRoot, pnpmfile, reasons) !== undefined) {
      reasons.push(`The workspace has ${pnpmfile}, whose hooks only a real install runs.`);
    }
  }
  // pnpm also reads the .npmrc of the project it runs in, which the staged copy runs from the root instead.
  const memberNpmrc = input.importerId === '.' ? undefined : await readContained(realRoot, `${input.importerId}/${NPMRC}`, reasons);
  if (memberNpmrc !== undefined) reasons.push(`${input.importerId}/${NPMRC} sets project settings the review does not stage.`, memberNpmrc);
  const npmrc = await readContained(realRoot, NPMRC, reasons);
  const npmrcText = npmrc === undefined ? undefined : stagedNpmrc(npmrc, reasons);
  if (npmrcText !== undefined) files.push({ path: NPMRC, text: npmrcText });
  if (input.manifestText !== undefined) {
    const problem = manifestProblem(input.manifestText, input.importerId, 'The reviewed package.json');
    if (problem !== undefined) reasons.push(problem);
  }
  let dirs: string[];
  try {
    dirs = await collectManifestDirs(realRoot, reasons, input.signal);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (dir === input.importerId) continue;
    const relative = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const text = await readContained(realRoot, relative, reasons);
    if (text === undefined) continue;
    const problem = manifestProblem(text, dir, relative);
    if (problem !== undefined) reasons.push(problem);
    files.push({ path: relative, text });
  }

  const hash = createHash('sha256');
  // Availability and the whole .npmrc count too, so any change there stales a review.
  for (const part of [...reasons, npmrc ?? '']) hash.update(part).update('\u0000');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update('\u0000').update(file.text).update('\u0000');
  }
  return {
    importerId: input.importerId,
    files,
    fingerprint: hash.digest('hex'),
    ...(reasons[0] === undefined ? {} : { unavailableReason: reasons[0] }),
  };
}
