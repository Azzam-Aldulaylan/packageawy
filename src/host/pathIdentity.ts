/**
 * One way to decide whether two dependency file paths are the same file or
 * whether one lies inside a folder. The mutation target resolver, the
 * project mutation lock and the transaction file adapter all use it, so a
 * path one of them accepts is never one another treats as different.
 *
 * Two questions get two answers on purpose:
 *   - Authorization (`authorizedRelation`, `relatePaths`) never folds case.
 *     Both paths are canonicalized with the native realpath, which returns
 *     the spelling on disk on volumes that ignore case (macOS, Windows), and
 *     the results are compared segment by segment exactly. Two directories
 *     that differ only by case on a case-sensitive volume stay different,
 *     and nothing is inferred from probing a sibling.
 *   - `lockKey` always lowercases. It may join paths that are really
 *     different, and the worst outcome is two windows waiting on each other,
 *     never two writers at once.
 */

import { realpath as realpathCallback, realpathSync } from 'node:fs';
import path from 'node:path';

export type PathRelation = 'same' | 'inside' | 'outside' | 'unresolved';

function errorCode(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code?: unknown }).code : undefined;
}

/** Missing parts of a path are expected here: the lockfile an install will create does not exist yet. */
export function isMissingPathError(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The native realpath and path rules, or Windows semantics and a fake realpath in a test. */
export interface PathSystem {
  path: path.PlatformPath;
  realpath: (candidate: string) => Promise<string>;
}

export const nativeRealpath = (candidate: string): Promise<string> =>
  new Promise((resolve, reject) => {
    realpathCallback.native(candidate, (error, resolved) => (error === null ? resolve(resolved) : reject(error)));
  });

const HOST: PathSystem = { path, realpath: nativeRealpath };

/**
 * Canonical spelling of a path that may not exist yet: the native realpath
 * of its nearest existing ancestor, then the missing segments exactly as
 * written. Errors other than "missing" propagate.
 */
export async function canonicalPath(candidate: string, system: PathSystem = HOST): Promise<string> {
  const tail: string[] = [];
  let current = system.path.resolve(candidate);
  for (;;) {
    try {
      const real = await system.realpath(current);
      return tail.length === 0 ? real : system.path.join(real, ...[...tail].reverse());
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
      const parent = system.path.dirname(current);
      if (parent === current) throw cause;
      tail.push(system.path.basename(current));
      current = parent;
    }
  }
}

/** Synchronous canonical spelling for the lock key, which is computed on synchronous paths. */
function canonicalPathSync(candidate: string): string {
  const tail: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...[...tail].reverse());
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Key for the one-change-per-project lock: canonical, then always lowercased. */
export function lockKey(candidate: string): string {
  let canonical: string;
  try {
    canonical = canonicalPathSync(candidate);
  } catch {
    canonical = path.resolve(candidate);
  }
  return canonical.toLowerCase();
}

/**
 * Segments of an absolute path, compared by this file itself rather than
 * with path.relative, which ignores case on Windows. A Windows drive letter
 * is not part of the directory tree, so it is compared without case.
 */
function segmentsOf(target: string, pathModule: path.PlatformPath): string[] {
  const normalized = pathModule.normalize(target);
  const parts = normalized.split(pathModule === path.win32 ? /[\\/]+/ : /\/+/).filter((part) => part !== '');
  if (pathModule === path.win32 && parts[0] !== undefined && /^[a-z]:$/i.test(parts[0])) parts[0] = parts[0].toUpperCase();
  return parts;
}

/**
 * How `child` relates to `parent`, both already canonical: segment by
 * segment, exactly. No case folding: canonicalization already produced the
 * on-disk spelling wherever case does not matter.
 */
export function relatePaths(parent: string, child: string, pathModule: path.PlatformPath = path): 'same' | 'inside' | 'outside' {
  const parentSegments = segmentsOf(parent, pathModule);
  const childSegments = segmentsOf(child, pathModule);
  if (childSegments.length < parentSegments.length) return 'outside';
  for (const [index, part] of parentSegments.entries()) {
    if (childSegments[index] !== part) return 'outside';
  }
  return childSegments.length === parentSegments.length ? 'same' : 'inside';
}

/**
 * Canonicalizes both paths, then relates them exactly. A path that cannot
 * be canonicalized is `unresolved`, and callers refuse the change.
 */
export async function authorizedRelation(parent: string, child: string, system: PathSystem = HOST): Promise<PathRelation> {
  try {
    const [canonicalParent, canonicalChild] = await Promise.all([canonicalPath(parent, system), canonicalPath(child, system)]);
    return relatePaths(canonicalParent, canonicalChild, system.path);
  } catch {
    return 'unresolved';
  }
}

/** The part of `child` below `parent` as path segments, for a pair `relatePaths` called same or inside. */
export function segmentsBelow(parent: string, child: string, pathModule: path.PlatformPath = path): string[] {
  return segmentsOf(child, pathModule).slice(segmentsOf(parent, pathModule).length);
}
