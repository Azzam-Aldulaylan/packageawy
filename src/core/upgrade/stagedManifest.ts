/**
 * Pure construction of a package.json used for a mixed-classification
 * coordinated upgrade. The host supplies only planner/controller-owned exact
 * versions. The transaction layer owns writing these bytes with compare-and-
 * swap protection before one package-manager reconciliation install.
 */

import semver from 'semver';

import { isCatalogSpecifier } from '../manifest/parse.js';
import {
  isSafeNpmPackageName,
  isSafeSemverVersion,
  type DependencyClassification,
} from './plan.js';

export interface StagedManifestChange {
  packageName: string;
  target: string;
  classification: DependencyClassification;
}

export interface StagedManifestRemoval {
  packageName: string;
  classification: DependencyClassification;
}

/**
 * `exact` writes the planned version as-is (used for the resolution pass and
 * isolated verification). `preserve` keeps the declaration's own operator
 * when it is a plain exact, caret, or tilde version; see preservedSpecifier.
 */
export type StagedManifestRangeStyle = 'exact' | 'preserve';

export interface StagedManifestOptions {
  rangeStyle?: StagedManifestRangeStyle;
}

export type StagedManifestErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_CHANGE'
  | 'DUPLICATE_CHANGE'
  | 'MISSING_DECLARATION'
  | 'CATALOG_SPECIFIER';

export class StagedManifestError extends Error {
  constructor(
    readonly code: StagedManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'StagedManifestError';
  }
}

const BLOCK_BY_CLASSIFICATION: Record<DependencyClassification, string> = {
  prod: 'dependencies',
  dev: 'devDependencies',
  optional: 'optionalDependencies',
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoot(contents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new StagedManifestError('INVALID_MANIFEST', 'package.json is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new StagedManifestError('INVALID_MANIFEST', 'package.json must contain a JSON object.');
  }
  return parsed;
}

function dependencyBlock(root: Record<string, unknown>, name: string): Record<string, unknown> | null {
  if (!Object.hasOwn(root, name)) return null;
  const block = root[name];
  if (!isRecord(block)) {
    throw new StagedManifestError('INVALID_MANIFEST', `${name} must be a JSON object.`);
  }
  return block;
}

function indentation(contents: string): string | number | undefined {
  const match = /^(\s+)(?="(?:name|version|private|type|scripts|dependencies|devDependencies|optionalDependencies|peerDependencies|packageManager|workspaces)"\s*:)/m.exec(contents);
  if (match === null) return undefined;
  const whitespace = match[1]?.replace(/[\r\n]/g, '') ?? '';
  return whitespace.length === 0 ? undefined : whitespace;
}

function stringifyLikeSource(root: Record<string, unknown>, source: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = /(?:\r\n|\n)$/.test(source);
  const formatted = JSON.stringify(root, null, indentation(source));
  const normalized = newline === '\n' ? formatted : formatted.replace(/\n/g, newline);
  return finalNewline ? `${normalized}${newline}` : normalized;
}

/**
 * The specifier an upgrade writes for `target`, keeping the style of the
 * current declaration where that style is a plain version with an optional
 * `^`, `~`, `~>`, or `=` operator (a leading `v` and inner whitespace are
 * dropped). Anything else (`>=` and compound ranges, x-ranges, `*`, tags,
 * empty) has no single obvious rewrite, so the exact target is written,
 * matching what the staged path has always done.
 */
export function preservedSpecifier(current: string, target: string): string {
  if (semver.valid(target) === null) return target;
  const compact = current.replace(/\s+/g, '');
  const match = /^(\^|~>?|=)?v?(\d+(?:\.\d+){0,2})((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(compact);
  if (match === null) return target;
  const operator = match[1] ?? '';
  const parts = (match[2] ?? '').split('.').length;
  // A bare partial version ("1", "1.2") is an x-range, not an exact pin.
  if (parts < 3 && (operator === '' || operator === '=')) return target;
  if (parts < 3 && (match[3] ?? '') !== '') return target;
  const specifier = `${operator}${target}`;
  return semver.satisfies(target, specifier, { includePrerelease: true }) ? specifier : target;
}

interface JsonSpan {
  start: number;
  end: number;
  members?: JsonMember[];
}

interface JsonMember {
  keyStart: number;
  key: string;
  value: JsonSpan;
}

class JsonScanError extends Error {}

/** Locates value spans in JSON text that JSON.parse already accepted. */
function scanJson(text: string): JsonSpan {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++;
  };
  const fail = (): never => {
    throw new JsonScanError('Unexpected JSON text.');
  };
  const string = (): void => {
    if (text[i] !== '"') fail();
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail();
    i++;
  };
  const value = (): JsonSpan => {
    ws();
    const start = i;
    const ch = text[i];
    if (ch === '{') {
      i++;
      const members: JsonMember[] = [];
      ws();
      if (text[i] === '}') {
        i++;
        return { start, end: i, members };
      }
      for (;;) {
        ws();
        const keyStart = i;
        string();
        const key = JSON.parse(text.slice(keyStart, i)) as string;
        ws();
        if (text[i] !== ':') fail();
        i++;
        members.push({ keyStart, key, value: value() });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== '}') fail();
        i++;
        return { start, end: i, members };
      }
    }
    if (ch === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return { start, end: i };
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== ']') fail();
        i++;
        return { start, end: i };
      }
    }
    if (ch === '"') {
      string();
      return { start, end: i };
    }
    while (i < text.length && !',]} \t\n\r'.includes(text[i] as string)) i++;
    if (i === start) fail();
    return { start, end: i };
  };
  const root = value();
  ws();
  if (i !== text.length) fail();
  return root;
}

/** JSON.parse keeps the last duplicate key, so edits target the last one too. */
function lastMember(span: JsonSpan, key: string): { member: JsonMember; index: number } | null {
  const members = span.members ?? [];
  for (let index = members.length - 1; index >= 0; index--) {
    const member = members[index] as JsonMember;
    if (member.key === key) return { member, index };
  }
  return null;
}

function dependencyMember(text: string, blockName: string, packageName: string) {
  const root = scanJson(text);
  const block = lastMember(root, blockName);
  if (block === null || block.member.value.members === undefined) throw new JsonScanError('Missing block.');
  const dependency = lastMember(block.member.value, packageName);
  if (dependency === null) throw new JsonScanError('Missing dependency.');
  return { block: block.member.value, dependency };
}

function replaceValueText(text: string, blockName: string, packageName: string, specifier: string): string {
  const { dependency } = dependencyMember(text, blockName, packageName);
  const span = dependency.member.value;
  return `${text.slice(0, span.start)}${JSON.stringify(specifier)}${text.slice(span.end)}`;
}

function removeMemberText(text: string, blockName: string, packageName: string): string {
  const { block, dependency } = dependencyMember(text, blockName, packageName);
  const members = block.members as JsonMember[];
  const { member, index } = dependency;
  if (members.length === 1) {
    // Only member: leave an empty object, as JSON.stringify would.
    return `${text.slice(0, block.start + 1)}${text.slice(block.end - 1)}`;
  }
  if (index > 0) {
    // Drop from the end of the previous value through this value, which
    // removes the separating comma and this member's own line.
    const previous = members[index - 1] as JsonMember;
    return `${text.slice(0, previous.value.end)}${text.slice(member.value.end)}`;
  }
  // First of several: drop this member, its comma, and the whitespace up to
  // the next key, keeping the indentation in front of this member.
  const next = members[index + 1] as JsonMember;
  return `${text.slice(0, member.keyStart)}${text.slice(next.keyStart)}`;
}

/**
 * Apply the edits to the source text so key order, indentation, spacing and
 * line endings stay exactly as written. The result must parse to the same
 * document the object-level edit produced; if it does not (or the text could
 * not be scanned), fall back to re-serializing like the source.
 */
function editLikeSource(
  source: string,
  expectedRoot: Record<string, unknown>,
  edit: (text: string) => string
): string {
  try {
    const edited = edit(source);
    if (JSON.stringify(JSON.parse(edited)) === JSON.stringify(expectedRoot)) return edited;
  } catch {
    // Fall through to the structural serialization below.
  }
  return stringifyLikeSource(expectedRoot, source);
}

/**
 * Return manifest text with the planned versions in their existing blocks.
 * No dependency is added, moved, or removed, and only the changed values'
 * text differs from the source. If a package also appears in a shadowed
 * block, only the host-asserted authoritative classification is updated,
 * matching manifest parsing's existing precedence behavior. With
 * `rangeStyle: 'preserve'` each value keeps its declaration's operator.
 */
export function buildStagedManifest(
  contents: string,
  changes: readonly StagedManifestChange[],
  options: StagedManifestOptions = {}
): string {
  if (changes.length === 0) {
    throw new StagedManifestError('INVALID_CHANGE', 'At least one coordinated manifest change is required.');
  }

  const root = parseRoot(contents);
  const seen = new Set<string>();
  const edits: Array<{ blockName: string; packageName: string; specifier: string }> = [];

  for (const change of changes) {
    if (
      FORBIDDEN_KEYS.has(change.packageName) ||
      !isSafeNpmPackageName(change.packageName) ||
      !isSafeSemverVersion(change.target)
    ) {
      throw new StagedManifestError('INVALID_CHANGE', 'A coordinated manifest change is not a safe exact package version.');
    }
    if (seen.has(change.packageName)) {
      throw new StagedManifestError('DUPLICATE_CHANGE', `Duplicate coordinated change for ${change.packageName}.`);
    }
    seen.add(change.packageName);

    const expectedBlock = BLOCK_BY_CLASSIFICATION[change.classification];
    const block = dependencyBlock(root, expectedBlock);
    if (
      block === null ||
      !Object.hasOwn(block, change.packageName) ||
      typeof block[change.packageName] !== 'string'
    ) {
      throw new StagedManifestError(
        'MISSING_DECLARATION',
        `${change.packageName} is not a string declaration in ${expectedBlock}.`
      );
    }
    if (isCatalogSpecifier(block[change.packageName] as string)) {
      throw new StagedManifestError(
        'CATALOG_SPECIFIER',
        `${change.packageName} gets its version from the pnpm catalog in pnpm-workspace.yaml.`
      );
    }
    const specifier =
      options.rangeStyle === 'preserve'
        ? preservedSpecifier(block[change.packageName] as string, change.target)
        : change.target;
    block[change.packageName] = specifier;
    edits.push({ blockName: expectedBlock, packageName: change.packageName, specifier });
  }

  return editLikeSource(contents, root, (text) =>
    edits.reduce((current, item) => replaceValueText(current, item.blockName, item.packageName, item.specifier), text)
  );
}

/**
 * Return manifest text with the given declared dependencies deleted from
 * their existing blocks. Nothing is added or modified: every sibling
 * dependency in the same block, and every other key in the manifest, is
 * left exactly as written. Only the removed packages' own key/value pairs
 * disappear.
 */
export function buildStagedManifestForRemoval(
  contents: string,
  removals: readonly StagedManifestRemoval[]
): string {
  if (removals.length === 0) {
    throw new StagedManifestError('INVALID_CHANGE', 'At least one dependency to remove is required.');
  }

  const root = parseRoot(contents);
  const seen = new Set<string>();
  const edits: Array<{ blockName: string; packageName: string }> = [];

  for (const removal of removals) {
    if (FORBIDDEN_KEYS.has(removal.packageName) || !isSafeNpmPackageName(removal.packageName)) {
      throw new StagedManifestError('INVALID_CHANGE', 'A dependency to remove is not a safe package name.');
    }
    if (seen.has(removal.packageName)) {
      throw new StagedManifestError('DUPLICATE_CHANGE', `Duplicate removal for ${removal.packageName}.`);
    }
    seen.add(removal.packageName);

    const expectedBlock = BLOCK_BY_CLASSIFICATION[removal.classification];
    const block = dependencyBlock(root, expectedBlock);
    if (
      block === null ||
      !Object.hasOwn(block, removal.packageName) ||
      typeof block[removal.packageName] !== 'string'
    ) {
      throw new StagedManifestError(
        'MISSING_DECLARATION',
        `${removal.packageName} is not a string declaration in ${expectedBlock}.`
      );
    }
    delete block[removal.packageName];
    edits.push({ blockName: expectedBlock, packageName: removal.packageName });
  }

  return editLikeSource(contents, root, (text) =>
    edits.reduce((current, item) => removeMemberText(current, item.blockName, item.packageName), text)
  );
}
