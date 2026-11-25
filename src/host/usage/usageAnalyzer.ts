/**
 * On-demand workspace usage analyzer: the one shared implementation behind
 * both "Where is this used?" (one package) and unused-dependency detection
 * (every direct dependency at once). Never runs at activation, dashboard
 * startup, or on any refresh/filter/sort/pagination action: always
 * explicitly triggered, always cancellable. See usageCoordinator.ts for the
 * call sites.
 *
 * One pass over the workspace's source files regardless of how many package
 * names are requested: each file is read once, every import/require/dynamic-
 * import in it is extracted once (src/core/usage/importScan.ts), and each
 * match is bucketed into whichever requested package it belongs to. This is
 * what lets a full "Analyze cleanup" run (all direct dependencies) cost the
 * same file I/O as checking a single package.
 */

import * as path from 'node:path';

import { configReferencesPackage } from '../../core/usage/configHeuristics.js';
import { scanFilesBounded } from '../../core/usage/boundedFileScan.js';
import { findPackageInManifestConfig, findPackageInScripts } from '../../core/usage/packageScripts.js';
import { hasUnreadTemplateImports } from '../../core/usage/importScan.js';
import { extractSourceCoverage, SOURCE_IMPORT_COVERAGE_REASON, STYLESHEET_EXTENSION } from '../../core/usage/sourceCoverage.js';
import { styleDialect } from '../../core/usage/styleScan.js';
import { prettierAutoLoadReference } from '../../core/usage/prettierPlugins.js';
import type { DependencyUsageResult } from '../../core/usage/types.js';
import { UsageReferenceIndex } from '../../core/usage/referenceIndex.js';
import type { PerformanceRecorder } from '../../core/performance/measurement.js';
import { NOOP_PERFORMANCE_RECORDER } from '../../core/performance/measurement.js';
import type { CancellationToken, HostPlatform, WorkspaceFolder } from '../platform/hostPlatform.js';
import { canonicalPath, relatePaths } from '../pathIdentity.js';
import {
  findConfigFiles,
  findCoverageFiles,
  findSourceFiles,
  planWorkspaceFiles,
  readTextFileCapped,
  relativeToFolder,
  USAGE_SOURCE_EXTENSIONS,
} from './workspaceFiles.js';

import { LocalImportCoverage } from './localImportCoverage.js';
import { OUTSIDE_LINK_REFERENCE_REASON, OutsideProjectLinks } from './outsideProjectLinks.js';
import { StylesheetReader } from './stylesheetReader.js';
import { trackSourceEvidenceFiles } from './sourceEvidenceFiles.js';
const DEFAULT_MAX_FILES = 6000;

export interface AnalyzeUsageOptions {
  platform: HostPlatform;
  folder: WorkspaceFolder;
  /** The project's workspace-folder-relative directory ("" for the folder root): scan is scoped to this subtree, not sibling monorepo members. */
  dir: string;
  manifestText: string;
  packageNames: readonly string[];
  /** The project's Prettier major version, when known. Below 3, installed Prettier plugins count as used. */
  prettierMajor?: number | null;
  maxFiles?: number;
  onProgress?: (scanned: number, total: number) => void;
  token: CancellationToken;
  performance?: PerformanceRecorder;
}

export async function analyzeDependencyUsage(
  options: AnalyzeUsageOptions
): Promise<Map<string, DependencyUsageResult>> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const requested = new Set(options.packageNames);
  const referenceIndex = new UsageReferenceIndex(options.packageNames);
  const performance = options.performance ?? NOOP_PERFORMANCE_RECORDER;

  const endDiscovery = performance.start('usage file discovery');
  const [sourceFiles, configFiles, coverageFiles] = await Promise.all([
    findSourceFiles(options.platform, options.folder, options.dir, maxFiles, options.token),
    findConfigFiles(options.platform, options.folder, options.dir, options.token),
    findCoverageFiles(options.platform, options.folder, options.dir, maxFiles, options.token),
  ]);
  const listedFiles = planWorkspaceFiles(options.folder, sourceFiles, configFiles, coverageFiles);
  const projectRoot = path.resolve(options.folder.path, options.dir);
  const canonicalProject = await canonicalPath(projectRoot).catch(() => null);
  // Files that editor search found through a hidden link leading outside the
  // project are not project source. Leave them out instead of counting them
  // unreadable, unless the project names that folder (see outsideProjectLinks.ts).
  const outsideLinks = new OutsideProjectLinks(projectRoot, canonicalProject);
  await outsideLinks.prepare(listedFiles.map((file) => file.absolutePath), () => options.token.isCancellationRequested);
  outsideLinks.checkText(options.manifestText);
  const files = listedFiles.filter((file) => !outsideLinks.covers(file.absolutePath));
  const overlappingFiles = sourceFiles.length + configFiles.length + coverageFiles.length - listedFiles.length;
  performance.increment('usage source discoveries', sourceFiles.length);
  performance.increment('usage config discoveries', configFiles.length);
  performance.increment('usage coverage discoveries', coverageFiles.length);
  performance.increment('usage unique files', files.length);
  endDiscovery({
    'source files': sourceFiles.length,
    'config files': configFiles.length,
    'coverage files': coverageFiles.length,
    'unique files': files.length,
    overlaps: overlappingFiles,
  });
  const fileCapReached = sourceFiles.length >= maxFiles || coverageFiles.length >= maxFiles;

  let scannedSourceFiles = 0;
  const sourceTotal = files.filter((file) => file.source).length;
  let failedReadCount = 0;
  const coverageReasons = new Set<string>();
  if (files.some((file) => /\.mdx$/i.test(file.filePath))) coverageReasons.add('.mdx files');
  const pendingScripts = new Set<string>();
  const scannedPaths = new Set<string>();
  const evidenceFiles = trackSourceEvidenceFiles(options.platform, projectRoot, 'usage');
  const localImports = new LocalImportCoverage(options.platform, options.folder, options.dir, maxFiles, options.token, scannedPaths, evidenceFiles.record);
  const checkSourceIdentity = (absolutePath: string, target: string): void => {
    // Followed styles already use canonical coordinates; discovery uses the workspace spelling.
    const expected = canonicalProject !== null && relatePaths(canonicalProject, absolutePath) !== 'outside'
      ? absolutePath : path.resolve(canonicalProject ?? projectRoot, path.relative(projectRoot, absolutePath));
    if (target !== expected) {
      coverageReasons.add('symlinked source files with unproven relative import resolution');
    }
  };
  const containedPath = async (absolutePath: string): Promise<string | null> => {
    try {
      const target = await canonicalPath(absolutePath);
      return canonicalProject !== null && relatePaths(canonicalProject, target) === 'inside' ? target : null;
    } catch {
      return null;
    }
  };
  const readMetrics = {
    onStat: () => performance.increment('usage stats'),
    onRead: (bytes: number) => {
      performance.increment('usage reads');
      performance.increment('usage bytes', bytes);
    },
  };
  const consumeSource = (absolutePath: string, filePath: string, text: string): void => {
    if (scannedPaths.has(absolutePath)) return;
    scannedPaths.add(absolutePath);
    const coverage = extractSourceCoverage(filePath, text, true);
    for (const reason of coverage.reasons) coverageReasons.add(reason);
    for (const style of coverage.styles) {
      styles.scan(absolutePath, filePath, style.text, style.dialect);
      if (style.src !== undefined) styles.addTarget(absolutePath, filePath, text, style.dialect, {
        target: style.src, offset: style.offset, directive: 'style src',
      });
    }
    for (const script of coverage.scripts) {
      referenceIndex.addSourceFile(filePath, script.text, script.language);
      outsideLinks.checkScript(script.text, filePath, script.language);
      if (hasUnreadTemplateImports(script.text, filePath, script.language, options.dir, localImports.request)) coverageReasons.add(SOURCE_IMPORT_COVERAGE_REASON);
    }
    for (const src of coverage.localScripts) {
      const local = src.startsWith('/')
        ? path.resolve(projectRoot, `.${src}`)
        : path.resolve(path.dirname(absolutePath), src);
      const relative = path.relative(projectRoot, local);
      const extension = path.extname(local).slice(1);
      // Only project-local JS/TS paths have the same readable and watched authority as source discovery.
      if (src === '' || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(src) ||
          relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
          !USAGE_SOURCE_EXTENSIONS.some((value) => value === extension && !['vue', 'svelte', 'astro'].includes(value))) {
        coverageReasons.add('script src targets that could not be read');
      } else {
        pendingScripts.add(local);
      }
    }
  };
  const styles = new StylesheetReader({
    platform: options.platform, folder: options.folder, projectRoot, token: options.token,
    maxFiles, index: referenceIndex, globalReasons: coverageReasons, metrics: readMetrics, containedPath,
    recordFile: evidenceFiles.record,
    consumeScript: (absolutePath, filePath, text, canonical) => {
      checkSourceIdentity(absolutePath, canonical);
      // Followed plugins/configs may import other excluded scripts. Without a
      // module-resolution proof, relative dependencies must remain uncertain.
      if (hasUnreadTemplateImports(text, filePath, undefined, options.dir, localImports.request,
        specifier => !/^(?:\.\.?($|[\\/])|[\\/]|[a-z]:)/i.test(specifier))) coverageReasons.add(SOURCE_IMPORT_COVERAGE_REASON);
      consumeSource(absolutePath, filePath, text);
      for (const name of requested) {
        if (configReferencesPackage(text, name, path.basename(filePath))) referenceIndex.addReference(name, {
          filePath, line: 0, column: 0, snippet: path.basename(filePath), kind: 'config', context: filePath,
        });
      }
    },
  });
  const endWorkspaceScan = performance.start('usage workspace scan');
  const workspaceScan = await scanFilesBounded({
    items: files.filter((file) => !/\.mdx$/i.test(file.filePath) && !STYLESHEET_EXTENSION.test(file.filePath)),
    read: async ({ absolutePath, source }) => {
      // Discovery can return symlinks too, so enforce the same authority before every read.
      const target = await containedPath(absolutePath);
      if (target !== null) {
        evidenceFiles.record(absolutePath);
        if (source) checkSourceIdentity(absolutePath, target);
      }
      return target === null ? null : readTextFileCapped(options.platform, target, readMetrics);
    },
    consume: (file, text) => {
      outsideLinks.checkText(text);
      if (file.source) consumeSource(file.absolutePath, file.filePath, text);
      if (!file.config) return;
      const configName = file.filePath.slice(file.filePath.lastIndexOf('/') + 1);
      for (const name of requested) {
        if (configReferencesPackage(text, name, configName)) {
          referenceIndex.addReference(name, {
            filePath: file.filePath,
            line: 0,
            column: 0,
            snippet: configName,
            kind: 'config',
            context: configName,
          });
        }
      }
    },
    isCancelled: () => options.token.isCancellationRequested,
    onReadFailure: () => {
      failedReadCount += 1;
      performance.increment('usage read failures');
    },
    onItemProcessed: (file) => {
      if (!file.source) return;
      scannedSourceFiles += 1;
      options.onProgress?.(scannedSourceFiles, sourceTotal);
    },
  });
  for (const file of files.filter((entry) => STYLESHEET_EXTENSION.test(entry.filePath))) {
    if (options.token.isCancellationRequested) break;
    const target = await containedPath(file.absolutePath);
    if (target !== null) evidenceFiles.record(file.absolutePath);
    const text = target === null ? null : await readTextFileCapped(options.platform, target, readMetrics);
    const dialect = styleDialect(file.filePath) ?? 'css';
    if (text === null) {
      styles.protectPreprocessor(file.filePath, dialect);
      coverageReasons.add(`stylesheets in ${file.filePath} that could not be read`);
    }
    else {
      outsideLinks.checkText(text);
      scannedPaths.add(file.absolutePath);
      // Preserve canonical ownership and resolve nested imports beside the real file.
      styles.scan(target ?? file.absolutePath, file.filePath, text, dialect);
    }
  }
  // A local src may be excluded from discovery or beyond its cap. Read it explicitly before claiming coverage.
  for (const absolutePath of pendingScripts) {
    if (options.token.isCancellationRequested) break;
    const target = await containedPath(absolutePath);
    if (target === null) {
      coverageReasons.add('script src targets that could not be read');
      continue;
    }
    if (scannedPaths.has(absolutePath)) continue;
    evidenceFiles.record(absolutePath);
    checkSourceIdentity(absolutePath, target);
    const text = await readTextFileCapped(options.platform, target, readMetrics);
    const filePath = relativeToFolder(options.folder, absolutePath);
    if (text === null || filePath === null) coverageReasons.add('script src targets that could not be read');
    else consumeSource(absolutePath, filePath, text);
  }
  await styles.drain();
  if (!await localImports.complete()) coverageReasons.add(SOURCE_IMPORT_COVERAGE_REASON);
  if (outsideLinks.referenced) coverageReasons.add(OUTSIDE_LINK_REFERENCE_REASON);
  // A cancellation can settle during discovery with an empty/partial result,
  // before the bounded scanner has an item on which to observe it. Never
  // publish that degraded pass as complete.
  const cancelledEarly = workspaceScan.cancelled || options.token.isCancellationRequested;
  endWorkspaceScan({
    'unique files': workspaceScan.processed,
    'source files': scannedSourceFiles,
    'read failures': failedReadCount,
    packages: requested.size,
  });

  for (const name of requested) {
    for (const key of findPackageInManifestConfig(options.manifestText, name)) {
      referenceIndex.addReference(name, {
        filePath: 'package.json', line: 0, column: 0,
        snippet: `package.json: ${key}`, kind: 'config', context: `package.json ${key}`,
      });
    }
    for (const scriptMatch of findPackageInScripts(options.manifestText, name)) {
      referenceIndex.addReference(name, {
        filePath: 'package.json',
        line: 0,
        column: 0,
        snippet: `"${scriptMatch.scriptName}": "${scriptMatch.scriptCommand}"`,
        kind: 'script',
        context: scriptMatch.scriptName,
      });
    }
    const prettierReference = prettierAutoLoadReference(name, options.prettierMajor ?? null);
    if (prettierReference !== null) referenceIndex.addReference(name, prettierReference);
  }

  const scannedAt = new Date().toISOString();
  // A missing, unreadable, or oversized eligible file is an evidence gap,
  // just like a file-cap or cancellation. References found elsewhere remain
  // valid, but a zero-reference result from this pass cannot honestly prove
  // that the package is unused or low-risk to remove.
  const truncated = fileCapReached || cancelledEarly || failedReadCount > 0;
  const results = new Map<string, DependencyUsageResult>();
  for (const name of requested) {
    const reasons = [...new Set([...coverageReasons, ...(styles.packageReasons.get(name) ?? [])])].sort();
    results.set(name, {
      packageName: name,
      references: referenceIndex.forPackage(name),
      truncated: truncated || reasons.length > 0,
      ...(reasons.length === 0 ? {} : { coverageReasons: reasons }),
      scannedFileCount: scannedSourceFiles,
      scannedAt,
    });
  }
  evidenceFiles.finish(!cancelledEarly);
  return results;
}
