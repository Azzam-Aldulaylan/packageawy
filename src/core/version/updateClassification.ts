import semver from 'semver';

export type UpdateKind = 'major' | 'minor' | 'patch';

/** Classify the actual versions using semver.diff, including pre-release bumps. */
export function classifyUpdate(current: string, target: string): UpdateKind | null {
  if (semver.valid(current) === null || semver.valid(target) === null) return null;
  const difference = semver.diff(current, target);
  if (difference === 'major' || difference === 'premajor') return 'major';
  if (difference === 'minor' || difference === 'preminor') return 'minor';
  if (difference === 'patch' || difference === 'prepatch') return 'patch';
  return null;
}
