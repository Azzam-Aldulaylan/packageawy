/**
 * "Open in Packageawy" on a package.json: maps the clicked file to the
 * discovered project it belongs to. Only a manifest that discovery itself
 * found can be opened, so the result is always a candidate from the same
 * host-owned list the project picker shows, never a path taken on trust.
 */

import * as path from 'node:path';

import type { PerformanceRecorder } from '../core/performance/measurement.js';
import { NOOP_PERFORMANCE_RECORDER } from '../core/performance/measurement.js';
import type { HostPlatform } from './platform/hostPlatform.js';
import { discoverProjects } from './projectResolution.js';
import type { DiscoveredProject } from './projectResolution.js';

/** Shown when the clicked file is not a project the dashboard can open. */
/** Shown when a dependency change is running in the open dashboard. */
export const OPEN_MANIFEST_BUSY_MESSAGE =
  'Packageawy is finishing a dependency change. Open this project again when it completes.';

export const OPEN_MANIFEST_UNAVAILABLE_MESSAGE =
  'Packageawy opens package.json files from your workspace folders, outside node_modules.';

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  // Windows and default macOS volumes are case-insensitive. Windows paths
  // also arrive with either drive letter case from different editor APIs.
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The candidate whose package.json is exactly `manifestPath`, if discovery found one. */
export function findProjectForManifest(
  candidates: readonly DiscoveredProject[],
  manifestPath: string,
  platform: NodeJS.Platform = process.platform
): DiscoveredProject | undefined {
  if (path.basename(manifestPath) !== 'package.json') return undefined;
  const target = comparablePath(manifestPath, platform);
  return candidates.find(
    (candidate) => comparablePath(path.join(candidate.folder.path, candidate.manifestPath), platform) === target
  );
}

export interface ManifestTarget {
  candidates: DiscoveredProject[];
  project: DiscoveredProject | undefined;
}

/** Discovers every project and picks the one that owns `manifestPath`. */
export async function resolveManifestTarget(
  platform: HostPlatform,
  manifestPath: string,
  performance: PerformanceRecorder = NOOP_PERFORMANCE_RECORDER
): Promise<ManifestTarget> {
  const candidates = await discoverProjects(platform, performance);
  return { candidates, project: findProjectForManifest(candidates, manifestPath) };
}
