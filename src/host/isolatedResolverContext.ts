import { classifySpecifier } from '../core/manifest/parse.js';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasLocalSource(value: unknown): boolean {
  if (typeof value === 'string') {
    const spec = value.trim().toLowerCase();
    const kind = classifySpecifier(spec).unresolvable;
    return kind === 'file' || kind === 'workspace-link' || spec.startsWith('git+file:');
  }
  return Object.values(record(value)).some(hasLocalSource);
}

const LOCAL_FILES_REASON = 'Local dependency files and linked packages were not included.';

/** Omissions visible in the npm manifest and the already resolved lockfile topology. No file discovery. */
export function npmManifestResolverLimitations(manifestText: string, importerId = '.'): string[] {
  const manifest = record(JSON.parse(manifestText));
  const workspaces = manifest['workspaces'];
  const workspacePackages = Array.isArray(workspaces) ? workspaces : record(workspaces)['packages'];
  const reasons: string[] = [];
  if (importerId !== '.') {
    reasons.push('Other packages and root package.json settings in this workspace were not included.');
  } else if (Array.isArray(workspacePackages) && workspacePackages.length > 0) {
    reasons.push('Other packages in this workspace were not included.');
  }
  if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'].some(
    (field) => hasLocalSource(manifest[field]))) {
    reasons.push(LOCAL_FILES_REASON);
  }
  return reasons;
}
