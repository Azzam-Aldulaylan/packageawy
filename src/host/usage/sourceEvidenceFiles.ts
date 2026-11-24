/** Host-only input identities (including resolution misses) for the last and in-flight scans. */
import * as path from 'node:path';
import { isExcluded } from '../../core/workspace/scan.js';
import { canonicalPathSync } from '../pathIdentity.js';
import type { HostPlatform } from '../platform/hostPlatform.js';

type ScanKind = 'usage' | 'compatibility';
interface EvidenceFiles { last: Set<string>; current?: Set<string> }
const projects = new WeakMap<HostPlatform, Map<string, Map<ScanKind, EvidenceFiles>>>();

/** Keep old evidence watched until its replacement finishes; stale scans cannot replace newer ones. */
export function trackSourceEvidenceFiles(platform: HostPlatform, projectRoot: string, kind: ScanKind): {
  record(file: string): void;
  finish(publish?: boolean): void;
} {
  let roots = projects.get(platform);
  if (roots === undefined) projects.set(platform, roots = new Map());
  const root = canonicalPathSync(projectRoot);
  let scans = roots.get(root);
  if (scans === undefined) roots.set(root, scans = new Map());
  let evidence = scans.get(kind);
  if (evidence === undefined) scans.set(kind, evidence = { last: new Set() });
  const current = new Set<string>();
  evidence.current = current;
  return {
    record: file => {
      current.add(canonicalPathSync(file));
      // A deleted or retargeted symlink no longer resolves to its scanned identity.
      current.add(path.resolve(file));
    },
    finish: (publish = true) => {
      if (evidence.current !== current) return;
      if (publish) evidence.last = current;
      delete evidence.current;
    },
  };
}

/** Synchronous so a file event revokes removal authority before any async continuation. */
export function shouldInvalidateSourceEvidence(platform: HostPlatform, projectRoot: string, file: string): boolean {
  const relative = path.relative(projectRoot, file);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  if (!isExcluded(relative.split(path.sep).join('/'))) return true;
  const scans = projects.get(platform)?.get(canonicalPathSync(projectRoot));
  if (scans === undefined) return false;
  const canonical = canonicalPathSync(file);
  return [...scans.values()].some(evidence => [canonical, path.resolve(file)]
    .some(identity => evidence.last.has(identity) || evidence.current?.has(identity)));
}
