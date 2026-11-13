/**
 * Whether a workspace's package patterns (npm `workspaces`, pnpm
 * `packages`) include one directory.
 *
 * Deliberately a strict subset: plain relative directory paths spelled
 * without `.` segments or a trailing slash, `*` as a whole last segment, and
 * `**` as whole segments. npm and pnpm each layer their own rules for
 * negation, braces, classes and extended globs on top of different glob
 * libraries, and a near miss here would pick a lockfile the
 * package manager does not write. Any other syntax is reported as
 * unsupported, and the caller refuses changes naming the pattern.
 */

export type PatternMatch =
  | { result: 'included' | 'excluded' }
  | { result: 'unsupported'; pattern: string };

type Segment = { kind: 'name'; name: string } | { kind: 'star' } | { kind: 'globstar' };

/** Characters any glob library could read as syntax. A name containing one is not a plain path. */
const GLOB_SYNTAX = /[*?[\]{}()!+@\\,]/;

/**
 * The parsed segments, or null when the pattern is outside the supported
 * subset. Nothing is normalized: npm's mapper reads ` packages/* `,
 * `./packages/a` and `packages/a/` differently from the plain spelling, so
 * those spellings are refused rather than tidied into one that matches.
 */
function parse(pattern: string): Segment[] | null {
  if (pattern === '' || pattern !== pattern.trim() || pattern.startsWith('/') || pattern.endsWith('/')) return null;
  const parts = pattern.split('/');
  const segments: Segment[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === '**') segments.push({ kind: 'globstar' });
    else if (part === '*' && index === parts.length - 1) segments.push({ kind: 'star' });
    else if (part === '' || part === '.' || part === '..' || GLOB_SYNTAX.test(part)) return null;
    else segments.push({ kind: 'name', name: part });
  }
  return segments;
}

/** A wildcard never matches a name that starts with a dot, as in npm's and pnpm's globs. */
const wildcardMatches = (name: string): boolean => !name.startsWith('.');

function matches(segments: readonly Segment[], names: readonly string[]): boolean {
  const [segment, ...restSegments] = segments;
  if (segment === undefined) return names.length === 0;
  const [name, ...restNames] = names;
  switch (segment.kind) {
    case 'globstar':
      if (matches(restSegments, names)) return true;
      return name !== undefined && wildcardMatches(name) && matches(segments, restNames);
    case 'star':
      return name !== undefined && wildcardMatches(name) && matches(restSegments, restNames);
    case 'name':
      return name === segment.name && matches(restSegments, restNames);
  }
}

/**
 * `relativeDir` is the project directory relative to the workspace root,
 * POSIX-separated, `.` for the root itself. The first unsupported pattern
 * is returned, even when another pattern already includes the directory.
 */
export function matchWorkspacePatterns(patterns: readonly string[], relativeDir: string): PatternMatch {
  const names = relativeDir === '' || relativeDir === '.' ? [] : relativeDir.split('/');
  const parsed: Segment[][] = [];
  for (const pattern of patterns) {
    const segments = parse(pattern);
    if (segments === null) return { result: 'unsupported', pattern };
    parsed.push(segments);
  }
  return { result: parsed.some((segments) => matches(segments, names)) ? 'included' : 'excluded' };
}
