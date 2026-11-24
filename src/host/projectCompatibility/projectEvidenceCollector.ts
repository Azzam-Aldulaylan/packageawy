/** Host-owned, bounded project evidence collection for pre-upgrade checks. */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { scanFilesBounded } from '../../core/usage/boundedFileScan.js';
import { hasUnreadTemplateImports, scanSourceForImportSpecifiers } from '../../core/usage/importScan.js';
import { extractSourceCoverage, STYLESHEET_EXTENSION } from '../../core/usage/sourceCoverage.js';
import { scanStylesheet, styleDialect } from '../../core/usage/styleScan.js';
import type { ProjectImportReference } from '../../core/projectCompatibility/imports.js';
import type { NextRuleProjectFile } from '../../core/projectCompatibility/rules/next/index.js';
import { LocalImportCoverage } from '../usage/localImportCoverage.js';
import { trackSourceEvidenceFiles } from '../usage/sourceEvidenceFiles.js';
import { canonicalPath } from '../pathIdentity.js';
import { CancellationTokenSource } from '../platform/cancellation.js';
import type { HostPlatform, WorkspaceFolder } from '../platform/hostPlatform.js';
import {
  findConfigFiles,
  findStylesheetFiles,
  findSourceFiles,
  planWorkspaceFiles,
  readTextFileCapped,
} from '../usage/workspaceFiles.js';
import {
  parseProjectManifestCompatibilityEvidence,
  projectCompatibilityScanIsTruncated,
  shouldRetainFrameworkRuleFile,
  type ProjectManifestCompatibilityEvidence,
} from './projectEvidenceParsing.js';

export {
  parseProjectManifestCompatibilityEvidence,
  projectCompatibilityScanIsTruncated,
  shouldRetainFrameworkRuleFile,
  type ProjectManifestCompatibilityEvidence,
} from './projectEvidenceParsing.js';

const DEFAULT_MAX_FILES = 6_000;
const MAX_IMPORT_REFERENCES = 400;
const MAX_FRAMEWORK_RULE_FILES = 200;

export interface CollectedProjectCompatibilityEvidence extends ProjectManifestCompatibilityEvidence {
  imports: ProjectImportReference[];
  ruleFiles: NextRuleProjectFile[];
  scannedFileCount: number;
  truncated: boolean;
  /** Bounded reason codes only. No raw paths or read errors. */
  scanLimitations?: string[];
  /** Stable digest of only the source/config evidence this analysis consumed. */
  evidenceFingerprint: string;
}

function evidenceFingerprint(input: {
  manifest: ProjectManifestCompatibilityEvidence;
  imports: readonly ProjectImportReference[];
  ruleFiles: readonly NextRuleProjectFile[];
  truncated: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify({
    manifest: input.manifest,
    imports: input.imports,
    ruleFiles: input.ruleFiles,
    truncated: input.truncated,
  }), 'utf8').digest('hex');
}

export async function collectProjectCompatibilityEvidence(input: {
  platform: HostPlatform;
  folder: WorkspaceFolder;
  dir: string;
  manifestText: string;
  packageName: string;
  signal?: AbortSignal;
  maxFiles?: number;
}): Promise<CollectedProjectCompatibilityEvidence> {
  const manifest = parseProjectManifestCompatibilityEvidence(input.manifestText);
  const projectRoot = path.resolve(input.folder.path, input.dir);
  const evidenceFiles = trackSourceEvidenceFiles(input.platform, projectRoot, 'compatibility');
  let completed = false;
  const cancellation = new CancellationTokenSource();
  const abort = (): void => cancellation.cancel();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
    const [sourceFiles, configFiles, coverageFiles] = await Promise.all([
      findSourceFiles(input.platform, input.folder, input.dir, maxFiles, cancellation.token),
      findConfigFiles(input.platform, input.folder, input.dir, cancellation.token),
      findStylesheetFiles(input.platform, input.folder, input.dir, maxFiles, cancellation.token),
    ]);
    const stylesheetFiles = coverageFiles.filter(file => STYLESHEET_EXTENSION.test(file));
    const files = planWorkspaceFiles(input.folder, sourceFiles, configFiles, stylesheetFiles);
    const scannedPaths = new Set<string>();
    const localImports = new LocalImportCoverage(input.platform, input.folder, input.dir, maxFiles, cancellation.token, scannedPaths, evidenceFiles.record);
    const imports: ProjectImportReference[] = [];
    const retainedFiles = new Map<string, NextRuleProjectFile>();
    let evidenceLimitReached = false;
    const scanLimitations = new Set<string>();
    let failedReadCount = 0;
    let scannedSourceFiles = 0;
    let sourceCancelled = false;
    let configCancelled = false;
    const canonicalProject = await canonicalPath(projectRoot);
    const workspaceScan = await scanFilesBounded({
      items: files,
      read: async ({ absolutePath }) => {
        const target = await canonicalPath(absolutePath);
        evidenceFiles.record(absolutePath);
        if (target !== path.resolve(canonicalProject, path.relative(projectRoot, absolutePath))) {
          scanLimitations.add('project-source-import-scan-incomplete');
        }
        return readTextFileCapped(input.platform, absolutePath);
      },
      isCancelled: () => cancellation.token.isCancellationRequested,
      consume: (file, content) => {
        if (file.source || STYLESHEET_EXTENSION.test(file.filePath)) scannedPaths.add(file.absolutePath);
        if (STYLESHEET_EXTENSION.test(file.filePath)) {
          const style = scanStylesheet(content, styleDialect(file.filePath));
          if (style.targets.length > 0 || style.unread.length > 0) scanLimitations.add('project-stylesheet-dependencies-unread');
        }
        if (file.source) {
          const coverage = extractSourceCoverage(file.filePath, content);
          if (coverage.reasons.length > 0) scanLimitations.add('project-source-extraction-incomplete');
          for (const script of coverage.scripts) {
            if (hasUnreadTemplateImports(script.text, file.filePath, script.language, input.dir, localImports.request)) {
              scanLimitations.add('project-source-import-scan-incomplete');
            }
            for (const match of scanSourceForImportSpecifiers(script.text, file.filePath, script.language)) {
              if (match.packageName !== input.packageName) continue;
              if (imports.length >= MAX_IMPORT_REFERENCES) {
                evidenceLimitReached = true;
                scanLimitations.add('project-import-reference-limit');
                continue;
              }
              imports.push({
                specifier: match.specifier,
                kind: match.kind,
                filePath: file.filePath,
                line: match.line,
                column: match.column,
                snippet: match.snippet,
              });
            }
          }
          if (shouldRetainFrameworkRuleFile(input.packageName, file.filePath)) {
            if (retainedFiles.size >= MAX_FRAMEWORK_RULE_FILES) {
              evidenceLimitReached = true;
              scanLimitations.add('project-framework-file-limit');
            } else retainedFiles.set(file.filePath, { filePath: file.filePath, content });
          }
        }
        if (file.config) {
          if (!retainedFiles.has(file.filePath) && retainedFiles.size >= MAX_FRAMEWORK_RULE_FILES) {
            evidenceLimitReached = true;
            scanLimitations.add('project-framework-file-limit');
          } else {
            retainedFiles.set(file.filePath, { filePath: file.filePath, content });
          }
        }
      },
      onReadFailure: () => { failedReadCount += 1; },
      onItemProcessed: (file) => {
        if (file.source) scannedSourceFiles += 1;
      },
    });
    if (!await localImports.complete()) scanLimitations.add('project-source-import-scan-incomplete');
    if (workspaceScan.cancelled || cancellation.token.isCancellationRequested) {
      sourceCancelled = scannedSourceFiles < sourceFiles.length;
      const processedConfigFiles = files
        .slice(0, workspaceScan.processed)
        .filter((file) => file.config).length;
      configCancelled = processedConfigFiles < configFiles.length;
      // Discovery itself is cancellable. If it resolves to an empty or
      // partial set after cancellation, its returned length cannot prove
      // that either evidence class was exhaustively discovered.
      if (cancellation.token.isCancellationRequested) {
        sourceCancelled = true;
        configCancelled = true;
      }
    }

    imports.sort((left, right) =>
      left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column ||
      left.specifier.localeCompare(right.specifier)
    );
    const ruleFiles = [...retainedFiles.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
    const truncated = projectCompatibilityScanIsTruncated({
      discoveredSourceFiles: sourceFiles.length,
      maxFiles,
      sourceCancelled,
      configCancelled,
      failedReadCount,
      evidenceLimitReached,
    }) || scanLimitations.size > 0 || stylesheetFiles.length >= maxFiles;
    if (stylesheetFiles.length >= maxFiles) scanLimitations.add('project-stylesheet-file-limit');
    if (sourceFiles.length >= maxFiles) scanLimitations.add('project-source-file-limit');
    if (sourceCancelled || configCancelled) scanLimitations.add('project-source-scan-cancelled');
    if (failedReadCount > 0) scanLimitations.add('project-source-file-unreadable');
    completed = true;
    return {
      ...manifest,
      imports,
      ruleFiles,
      scannedFileCount: scannedSourceFiles,
      truncated,
      ...(scanLimitations.size > 0 ? { scanLimitations: [...scanLimitations].sort() } : {}),
      evidenceFingerprint: evidenceFingerprint({ manifest, imports, ruleFiles, truncated }),
    };
  } finally {
    evidenceFiles.finish(completed && !cancellation.token.isCancellationRequested);
    input.signal?.removeEventListener('abort', abort);
    cancellation.dispose();
  }
}
