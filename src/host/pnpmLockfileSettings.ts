/**
 * pnpm settings that move, split or replace the lockfile pnpm writes, read
 * from every source this host can read without running pnpm.
 *
 * The policy is strict on purpose: any non-default value in any source
 * refuses changes, whichever pnpm version would actually honour it. Guessing
 * precedence or version rules wrong would let an install write a lockfile
 * the transaction never captured, while a refusal only costs the user a
 * change they can make in a terminal. Sources that redirect configuration
 * (userconfig, globalconfig, prefix, workspace-dir) and code that can rewrite
 * configuration (pnpmfiles, config dependencies) are refused rather than
 * followed.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseIni } from 'ini';
import { load as loadYaml } from 'js-yaml';

import { isRecord } from '../core/validation.js';
import { authorizedRelation, isMissingPathError } from './pathIdentity.js';

export const LOCKFILE_UNDETERMINED_REASON =
  'Packageawy cannot safely determine which lockfile your package manager will write. Changes are unavailable.';
export const PNPMFILE_REASON =
  'This project uses a pnpmfile, which can change where pnpm writes the lockfile. Changes are unavailable.';
export const PNPM_CONFIG_DEPENDENCIES_REASON =
  'This project loads pnpm configuration plugins, which can change where pnpm writes the lockfile. Changes are unavailable.';

export type PnpmSettingsRefusal =
  | { code: 'LOCKFILE_UNDETERMINED'; reason: string }
  | { code: 'PNPMFILE'; reason: string }
  | { code: 'PNPM_CONFIG_DEPENDENCIES'; reason: string };

/** The host facts the settings check reads. Injected so tests never depend on the real home or environment. */
export interface PnpmSettingsEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: NodeJS.Platform;
  /** Prefixes of the Node installations a task could run with. npm's global `<prefix>/etc/npmrc` is read for each. */
  nodePrefixes: readonly string[];
}

/**
 * The default of each setting, the only value that does not refuse. Null
 * means any value refuses. Booleans compare without case. Paths keep their
 * case, because `NODE_MODULES` is another directory on a case-sensitive volume.
 */
type SettingDefault = { kind: 'boolean'; value: 'true' | 'false' } | { kind: 'path'; value: string } | null;
const LOCKFILE_SETTING_DEFAULTS: ReadonlyMap<string, SettingDefault> = new Map<string, SettingDefault>([
  ['shared-workspace-lockfile', { kind: 'boolean', value: 'true' }],
  ['lockfile-dir', null],
  ['git-branch-lockfile', { kind: 'boolean', value: 'false' }],
  ['lockfile', { kind: 'boolean', value: 'true' }],
  ['use-lockfile', { kind: 'boolean', value: 'true' }],
  ['virtual-store-dir', { kind: 'path', value: 'node_modules/.pnpm' }],
  ['modules-dir', { kind: 'path', value: 'node_modules' }],
]);
const REDIRECTING_SETTINGS: ReadonlySet<string> = new Set(['userconfig', 'globalconfig', 'prefix', 'workspace-dir']);
// There is no implicit global pnpmfile: pnpm loads one only when the
// global-pnpmfile setting names it, so checking the setting is enough.
const PNPMFILE_SETTINGS: ReadonlySet<string> = new Set(['pnpmfile', 'global-pnpmfile']);
const CONFIG_DEPENDENCIES = 'config-dependencies';

/** `sharedWorkspaceLockfile`, `shared_workspace_lockfile` and `shared-workspace-lockfile` are one setting. */
export function normalizeSettingName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * Backslash separates paths only on Windows. On other platforms it is a
 * literal character, so `node_modules\\` names another directory.
 */
function isDefault(value: unknown, allowed: SettingDefault, platform: NodeJS.Platform): boolean {
  if (allowed === null) return false;
  const text = String(value);
  if (allowed.kind === 'boolean') return text.trim().toLowerCase() === allowed.value;
  // A path is compared as written: `node_modules ` with a space is another
  // directory, so nothing is trimmed or otherwise tidied.
  const separated = platform === 'win32' ? text.replace(/\\/g, '/') : text;
  return separated === allowed.value;
}

function undetermined(detail: string): PnpmSettingsRefusal {
  return { code: 'LOCKFILE_UNDETERMINED', reason: `${LOCKFILE_UNDETERMINED_REASON} ${detail}` };
}

/** The refusal one setting causes, or null when it is a default or unrelated. */
function settingRefusal(
  rawName: string,
  value: unknown,
  source: string,
  platform: NodeJS.Platform
): PnpmSettingsRefusal | null {
  const name = normalizeSettingName(rawName);
  if (PNPMFILE_SETTINGS.has(name)) return { code: 'PNPMFILE', reason: PNPMFILE_REASON };
  if (name === CONFIG_DEPENDENCIES) return { code: 'PNPM_CONFIG_DEPENDENCIES', reason: PNPM_CONFIG_DEPENDENCIES_REASON };
  if (REDIRECTING_SETTINGS.has(name)) return undetermined(`Setting found: ${name} in ${source}.`);
  if (!LOCKFILE_SETTING_DEFAULTS.has(name)) return null;
  const allowed = LOCKFILE_SETTING_DEFAULTS.get(name) ?? null;
  // A value pnpm would expand from the environment is unknown here, so it counts as set.
  if (value === undefined || !isDefault(value, allowed, platform)) {
    return undetermined(`Setting found: ${name} in ${source}.`);
  }
  return null;
}

type SourceText = { status: 'absent' } | { status: 'read'; text: string } | { status: 'unreadable' };

async function readSource(filePath: string): Promise<SourceText> {
  try {
    return { status: 'read', text: await readFile(filePath, 'utf8') };
  } catch (cause) {
    return isMissingPathError(cause) ? { status: 'absent' } : { status: 'unreadable' };
  }
}

async function checkNpmrc(filePath: string, label: string, platform: NodeJS.Platform): Promise<PnpmSettingsRefusal | null> {
  const source = await readSource(filePath);
  if (source.status === 'absent') return null;
  if (source.status === 'unreadable') return undetermined(`Could not read ${label}.`);
  for (const entry of npmrcEntries(source.text)) {
    const refusal = settingRefusal(entry.key, entry.value, label, platform);
    if (refusal !== null) return refusal;
  }
  return null;
}

function collectEntries(document: Record<string, unknown>, into: Array<{ key: string; value: string | undefined }>): void {
  for (const [key, value] of Object.entries(document)) {
    // Keys inside a [section] are reported too: refusing more is safe.
    if (isRecord(value)) {
      collectEntries(value, into);
      continue;
    }
    // `key[]=` lines become an array, and each entry still sets `key`.
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = item === null || item === undefined ? undefined : String(item);
      // A value pnpm would expand from the environment is unknown here.
      into.push({ key, value: text === undefined || text.includes('${') || key.includes('${') ? undefined : text });
    }
  }
}

/**
 * Every setting in an .npmrc, read with the `ini` package that npm's and
 * pnpm's config loaders use, so quoting, escapes, bare keys (true) and
 * `key[]` arrays mean exactly what they mean to the package manager.
 */
export function npmrcEntries(text: string): Array<{ key: string; value: string | undefined }> {
  const entries: Array<{ key: string; value: string | undefined }> = [];
  collectEntries(parseIni(text) as Record<string, unknown>, entries);
  return entries;
}

/** pnpm's own settings in a YAML document: pnpm-workspace.yaml or the global config.yaml. */
export function checkYamlSettings(
  document: Record<string, unknown>,
  label: string,
  platform: NodeJS.Platform
): PnpmSettingsRefusal | null {
  for (const [key, value] of Object.entries(document)) {
    const name = normalizeSettingName(key);
    // Delegating settings to other files is not followed.
    // pnpm 12.15 added `include` to read settings from other files.
    if (name === 'include') {
      return undetermined(`Setting found: ${key} in ${label}.`);
    }
    const refusal = settingRefusal(key, value === null || typeof value === 'object' ? undefined : value, label, platform);
    if (refusal !== null) return refusal;
  }
  return null;
}

async function checkYamlFile(filePath: string, label: string, platform: NodeJS.Platform): Promise<PnpmSettingsRefusal | null> {
  const source = await readSource(filePath);
  if (source.status === 'absent') return null;
  if (source.status === 'unreadable') return undetermined(`Could not read ${label}.`);
  let document: unknown;
  try {
    document = loadYaml(source.text);
  } catch {
    return undetermined(`Could not read ${label}.`);
  }
  if (document === null || document === undefined) return null;
  if (!isRecord(document)) return undetermined(`Could not read ${label}.`);
  return checkYamlSettings(document, label, platform);
}

/** Where `pnpm config` keeps its global files on each platform, as pnpm's getConfigDir decides. */
export function pnpmConfigDirs(environment: PnpmSettingsEnvironment): string[] {
  const { env, homeDir, platform } = environment;
  const dirs: string[] = [];
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') dirs.push(path.join(xdg, 'pnpm'));
  else if (platform === 'darwin') dirs.push(path.join(homeDir, 'Library', 'Preferences', 'pnpm'));
  else if (platform === 'win32' && env['LOCALAPPDATA'] !== undefined && env['LOCALAPPDATA'] !== '') {
    dirs.push(path.join(env['LOCALAPPDATA'], 'pnpm', 'config'));
  } else dirs.push(path.join(homeDir, '.config', 'pnpm'));
  // Some installs keep pnpm's files under PNPM_HOME. Reading there too can
  // only add refusals, never remove one.
  const pnpmHome = env['PNPM_HOME'];
  if (pnpmHome !== undefined && pnpmHome !== '') dirs.push(pnpmHome, path.join(pnpmHome, 'config'));
  return dirs;
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await authorizedRelation(left, right)) === 'same';
  } catch {
    return false;
  }
}

/**
 * `npm run` exports npm's own userconfig, globalconfig and prefix to every
 * script it starts, so an editor launched from one inherits them. A value
 * that names the very file (or prefix) this check already reads moves
 * nothing and is allowed. Anything else, including a relative path, is a
 * redirect and refuses.
 */
async function namesInspectedDefault(
  name: string,
  value: string,
  environment: PnpmSettingsEnvironment
): Promise<boolean> {
  if (!path.isAbsolute(value)) return false;
  const defaults = name === 'userconfig'
    ? [path.join(environment.homeDir, '.npmrc')]
    : name === 'globalconfig'
      ? environment.nodePrefixes.map((prefix) => path.join(prefix, 'etc', 'npmrc'))
      : name === 'prefix' ? [...environment.nodePrefixes] : [];
  for (const candidate of defaults) {
    if (await samePath(value, candidate)) return true;
  }
  return false;
}

async function checkEnvironment(environment: PnpmSettingsEnvironment): Promise<PnpmSettingsRefusal | null> {
  for (const [rawName, value] of Object.entries(environment.env)) {
    const lower = rawName.toLowerCase();
    const prefix = lower.startsWith('npm_config_') ? 'npm_config_' : lower.startsWith('pnpm_config_') ? 'pnpm_config_' : null;
    if (prefix === null || value === undefined) continue;
    const name = normalizeSettingName(lower.slice(prefix.length));
    if (await namesInspectedDefault(name, value, environment)) continue;
    const refusal = settingRefusal(name, value, `the environment (${rawName})`, environment.platform);
    if (refusal !== null) return refusal;
  }
  return null;
}

export interface PnpmSettingsInput {
  projectDir: string;
  workspaceRoot: string;
  /** The parsed pnpm-workspace.yaml that owns the project, or null when there is none. */
  workspaceManifest: Record<string, unknown> | null;
  environment: PnpmSettingsEnvironment;
}

async function hasPnpmfile(dir: string): Promise<boolean | 'unreadable'> {
  for (const name of ['.pnpmfile.cjs', '.pnpmfile.mjs']) {
    const source = await readSource(path.join(dir, name));
    if (source.status === 'read') return true;
    if (source.status === 'unreadable') return 'unreadable';
  }
  return false;
}

async function rootManifestConfigDependencies(root: string): Promise<boolean | 'unreadable'> {
  const source = await readSource(path.join(root, 'package.json'));
  if (source.status === 'absent') return false;
  if (source.status === 'unreadable') return 'unreadable';
  try {
    const manifest: unknown = JSON.parse(source.text);
    if (!isRecord(manifest)) return false;
    const pnpm = manifest['pnpm'];
    return manifest['configDependencies'] !== undefined || (isRecord(pnpm) && pnpm['configDependencies'] !== undefined);
  } catch {
    return 'unreadable';
  }
}

/** The first reason pnpm might write somewhere other than `<workspaceRoot>/pnpm-lock.yaml`, or null. */
export async function findPnpmLockfileOverride(input: PnpmSettingsInput): Promise<PnpmSettingsRefusal | null> {
  const { projectDir, workspaceRoot, workspaceManifest, environment } = input;
  if (workspaceManifest !== null) {
    const fromWorkspace = checkYamlSettings(workspaceManifest, 'pnpm-workspace.yaml', environment.platform);
    if (fromWorkspace !== null) return fromWorkspace;
  }
  for (const dir of new Set([workspaceRoot, projectDir])) {
    const pnpmfile = await hasPnpmfile(dir);
    if (pnpmfile === 'unreadable') return undetermined('Could not read the project pnpmfile.');
    if (pnpmfile) return { code: 'PNPMFILE', reason: PNPMFILE_REASON };
  }
  const configDependencies = await rootManifestConfigDependencies(workspaceRoot);
  if (configDependencies === 'unreadable') return undetermined('Could not read the workspace package.json.');
  if (configDependencies) return { code: 'PNPM_CONFIG_DEPENDENCIES', reason: PNPM_CONFIG_DEPENDENCIES_REASON };

  const fromEnvironment = await checkEnvironment(environment);
  if (fromEnvironment !== null) return fromEnvironment;

  const npmrcSources: Array<[string, string]> = [
    [path.join(projectDir, '.npmrc'), 'the project .npmrc'],
    [path.join(workspaceRoot, '.npmrc'), 'the workspace .npmrc'],
    [path.join(environment.homeDir, '.npmrc'), 'your user .npmrc'],
    ...environment.nodePrefixes.map((prefix): [string, string] => [path.join(prefix, 'etc', 'npmrc'), 'the global npmrc']),
  ];
  for (const configDir of pnpmConfigDirs(environment)) npmrcSources.push([path.join(configDir, 'rc'), "pnpm's global rc"]);
  const seen = new Set<string>();
  for (const [filePath, label] of npmrcSources) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const refusal = await checkNpmrc(filePath, label, environment.platform);
    if (refusal !== null) return refusal;
  }
  for (const configDir of pnpmConfigDirs(environment)) {
    const refusal = await checkYamlFile(path.join(configDir, 'config.yaml'), "pnpm's global config.yaml", environment.platform);
    if (refusal !== null) return refusal;
  }
  return null;
}
