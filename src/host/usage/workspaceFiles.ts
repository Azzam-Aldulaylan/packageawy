/**
 * Workspace-search adapter for usage analysis: the one place this
 * feature touches `HostPlatform.findFiles`. Scoped to the specific
 * project directory (a monorepo member's subtree, not its siblings) by
 * passing the directory as the search base, exactly like `discoverProjects`/`loadProject`
 * (projectResolution.ts) already scope manifest/lockfile discovery, never a
 * raw recursive filesystem walk, and never a workspace-relative glob string
 * built by interpolating a real directory name (which could contain glob
 * metacharacters) into a pattern.
 */

import * as path from 'node:path';

import { DEFAULT_EXCLUDED_DIRS } from '../../core/workspace/scan.js';
import { CONFIG_FILE_GLOBS } from '../../core/usage/configHeuristics.js';
import { STYLE_DEPENDENCY_DIRECTIVE } from '../../core/usage/sourceCoverage.js';
import { planWorkspaceAnalysisFiles } from '../../core/usage/workspaceAnalysisPlan.js';
import type { CancellationToken, HostPlatform, WorkspaceFolder } from '../platform/hostPlatform.js';

export interface WorkspaceFileReadMetrics {
  onStat?(): void;
  onRead?(bytes: number): void;
}

export interface PlannedWorkspaceFile {
  /** Absolute path. */
  absolutePath: string;
  filePath: string;
  source: boolean;
  config: boolean;
}

/**
 * Workspace-folder-relative, POSIX-separated, and verified to actually be
 * inside `folder`: the same computation
 * projectResolution.ts's `relativeToFolder` uses, duplicated here rather
 * than exported across module boundaries for a single small, security-
 * relevant path computation. Used for every reference this feature ever
 * sends to the webview, so a path can never read as "inside" a folder it
 * isn't.
 */
export function relativeToFolder(folder: WorkspaceFolder, absolutePath: string): string | null {
  const rel = path.relative(folder.path, absolutePath).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

export const USAGE_SOURCE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'mts', 'cts'] as const;
export const USAGE_SOURCE_FILE_GLOB = `**/*.{${USAGE_SOURCE_EXTENSIONS.join(',')}}`;
export const USAGE_COVERAGE_FILE_GLOB = '**/*.{mdx,css,scss,sass,less,styl,stylus,pcss,postcss}';
export const USAGE_CONFIG_FILE_GLOB = `{${CONFIG_FILE_GLOBS.join(',')}}`;
/**
 * Exact watcher authority for usage-analysis identity. Config entries are
 * deliberately shared with discovery, including extensionless `.eslintrc`
 * and `.babelrc`, so a cached result cannot outlive an input change.
 */
export const USAGE_FILE_WATCH_GLOB = `{${USAGE_SOURCE_FILE_GLOB},${USAGE_COVERAGE_FILE_GLOB},${CONFIG_FILE_GLOBS.join(',')}}`;
const EXCLUDE_GLOB = `**/{${DEFAULT_EXCLUDED_DIRS.join(',')}}/**`;

/** `dir` is the project's workspace-folder-relative directory ("" for the folder root. See DiscoveredProject.dir). */
export async function findSourceFiles(
  platform: HostPlatform,
  folder: WorkspaceFolder,
  dir: string,
  maxFiles: number,
  token: CancellationToken
): Promise<string[]> {
  return platform.findFiles(
    { folder, dir, include: USAGE_SOURCE_FILE_GLOB, exclude: EXCLUDE_GLOB, maxResults: maxFiles },
    token
  );
}

export async function findConfigFiles(
  platform: HostPlatform,
  folder: WorkspaceFolder,
  dir: string,
  token: CancellationToken
): Promise<string[]> {
  // Config files are always few: no cap needed beyond the exclude glob.
  return platform.findFiles({ folder, dir, include: USAGE_CONFIG_FILE_GLOB, exclude: EXCLUDE_GLOB }, token);
}

/** Discover unread types separately so their absence from the import scan cannot imply coverage. */
export async function findCoverageFiles(
  platform: HostPlatform,
  folder: WorkspaceFolder,
  dir: string,
  maxFiles: number,
  token: CancellationToken
): Promise<string[]> {
  return platform.findFiles(
    { folder, dir, include: USAGE_COVERAGE_FILE_GLOB, exclude: EXCLUDE_GLOB, maxResults: maxFiles }, token
  );
}

/** Merge source/config discoveries into one stable, de-duplicated read plan. */
export function planWorkspaceFiles(
  folder: WorkspaceFolder,
  sourceFiles: readonly string[],
  configFiles: readonly string[],
  coverageFiles: readonly string[] = []
): PlannedWorkspaceFile[] {
  const absolutePathByPath = new Map<string, string>();
  const sourcePaths: string[] = [];
  const configPaths: string[] = [];
  for (const absolutePath of sourceFiles) {
    const filePath = relativeToFolder(folder, absolutePath);
    if (filePath === null) continue;
    absolutePathByPath.set(filePath, absolutePath);
    sourcePaths.push(filePath);
  }
  for (const absolutePath of configFiles) {
    const filePath = relativeToFolder(folder, absolutePath);
    if (filePath === null) continue;
    absolutePathByPath.set(filePath, absolutePath);
    configPaths.push(filePath);
  }
  const analysisFiles = planWorkspaceAnalysisFiles(sourcePaths, configPaths);
  for (const absolutePath of coverageFiles) {
    const filePath = relativeToFolder(folder, absolutePath);
    if (filePath === null || absolutePathByPath.has(filePath)) continue;
    absolutePathByPath.set(filePath, absolutePath);
    analysisFiles.push({ key: filePath, source: false, config: false });
  }
  return analysisFiles.sort((a, b) => a.key.localeCompare(b.key)).flatMap((entry) => {
    const absolutePath = absolutePathByPath.get(entry.key);
    return absolutePath === undefined ? [] : [{
      absolutePath,
      filePath: entry.key,
      source: entry.source,
      config: entry.config,
    }];
  });
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Keep only a directive-sized overlap and stop reading as soon as coverage is known. */
export async function stylesheetHasDependencies(
  platform: HostPlatform,
  absolutePath: string,
  token: CancellationToken,
  metrics: WorkspaceFileReadMetrics = {}
): Promise<boolean | null> {
  let tail = '';
  let bytes = 0;
  try {
    for await (const chunk of platform.readFileChunks(absolutePath)) {
      if (token.isCancellationRequested) return null;
      bytes += chunk.byteLength;
      metrics.onRead?.(chunk.byteLength);
      const text = tail + Buffer.from(chunk).toString('latin1');
      const match = STYLE_DEPENDENCY_DIRECTIVE.exec(text);
      // Wait for the next byte before deciding a word boundary at a chunk edge.
      if (match !== null && match.index + match[0].length < text.length) return true;
      if (bytes > MAX_FILE_BYTES) return null;
      tail = text.slice(-8);
    }
    return STYLE_DEPENDENCY_DIRECTIVE.test(tail);
  } catch {
    return null;
  }
}

/** Reads a file's UTF-8 text, or null when it's missing, unreadable, or too large to be worth scanning. */
export async function readTextFileCapped(
  platform: HostPlatform,
  absolutePath: string,
  metrics: WorkspaceFileReadMetrics = {}
): Promise<string | null> {
  try {
    metrics.onStat?.();
    const stat = await platform.statFile(absolutePath);
    if (stat.size > MAX_FILE_BYTES) return null;
    const bytes = await platform.readFile(absolutePath);
    metrics.onRead?.(bytes.byteLength);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}
