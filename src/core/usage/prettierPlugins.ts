/**
 * Prettier below version 3 loads every installed package named
 * `prettier-plugin-*`, `@prettier/plugin-*`, or `@scope/prettier-plugin-*`
 * on its own, with no `plugins` entry in any config file. On such a
 * project these plugins are in use even though nothing references them.
 * Prettier 3 dropped that behavior, so there a plugin still needs an
 * explicit config reference (see configHeuristics.ts).
 */

import semver from 'semver';

import type { Manifest } from '../manifest/parse.js';
import type { DependencyGraph } from '../types.js';
import type { DependencyReference } from './types.js';

const AUTO_LOADED_PLUGIN_PATTERNS: readonly RegExp[] = [
  /^prettier-plugin-./,
  /^@prettier\/plugin-./,
  /^@[^/]+\/prettier-plugin-./,
];

export function isPrettierAutoLoadedPluginName(packageName: string): boolean {
  return AUTO_LOADED_PLUGIN_PATTERNS.some((pattern) => pattern.test(packageName));
}

/**
 * The major version from an exact installed version, else from a declared
 * range. A range is only trusted when every version it allows shares one
 * major, so `>=2` or `*` gives null rather than a guess.
 */
export function prettierMajorFrom(resolvedVersion: string | null, declaredRange: string | null): number | null {
  const resolved = resolvedVersion === null ? null : semver.valid(resolvedVersion);
  if (resolved !== null) return semver.major(resolved);
  if (declaredRange === null || semver.validRange(declaredRange) === null) return null;
  const lowest = semver.minVersion(declaredRange);
  if (lowest === null) return null;
  const major = lowest.major;
  return semver.intersects(declaredRange, `>=${major + 1}.0.0-0`, { includePrerelease: true }) ? null : major;
}

/**
 * The project's Prettier major version: the lockfile's resolved version
 * of the direct `prettier` dependency first, else its declared range in
 * package.json. Null when Prettier is not a direct dependency or the
 * version cannot be told.
 */
export function projectPrettierMajor(graph: DependencyGraph | null, manifest: Manifest | null): number | null {
  if (graph !== null) {
    for (const node of graph.nodes.values()) {
      if (node.name === 'prettier' && node.direct) return prettierMajorFrom(node.version, node.range);
    }
  }
  const declared = manifest?.dependencies.find((dependency) => dependency.name === 'prettier' && dependency.aliasTarget === undefined);
  return declared === undefined ? null : prettierMajorFrom(null, declared.range);
}

/**
 * The usage evidence for a plugin Prettier loads on its own, or null when
 * the package is not such a plugin or the project's Prettier is unknown,
 * absent, or version 3 or later.
 */
export function prettierAutoLoadReference(packageName: string, prettierMajor: number | null): DependencyReference | null {
  if (prettierMajor === null || prettierMajor >= 3 || !isPrettierAutoLoadedPluginName(packageName)) return null;
  return {
    filePath: 'package.json',
    line: 0,
    column: 0,
    snippet: `Loaded automatically by Prettier ${prettierMajor}`,
    kind: 'config',
    context: `Prettier ${prettierMajor}`,
  };
}
