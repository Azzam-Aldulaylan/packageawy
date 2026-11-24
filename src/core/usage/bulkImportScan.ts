/** Bounded static webpack/Vite bulk-loader parsing; never skips executable source. */
import { CALL_TRIVIA, IDENTIFIER, regexLiteralEnd } from './jsxLex.js';
import { importedPackageName } from './packageNameMatch.js';
import { QUOTED, staticSpecifier } from './staticSpecifier.js';

const DOT = `${CALL_TRIVIA}\\.${CALL_TRIVIA}`;
const PREFIX = new RegExp(`^(require${DOT}context|import${DOT}meta${DOT}glob)${CALL_TRIVIA}\\(`);
const STRING = new RegExp(`^${QUOTED}`);
const KEY = new RegExp(`^${IDENTIFIER}`, 'u');
const hasGlobMagic = (segment: string): boolean => /[*?{}[\]!]|[+@]\(/.test(segment);
interface Target { specifier: string; offset: number }
export interface BulkImport {
  kind: 'require' | 'dynamic-import';
  targets: Target[];
  unread: boolean;
  localDirectories: string[];
}

/** A tiny static-value reader. Calls, computed keys, interpolation and spreads fail closed. */
class StaticReader {
  index: number;
  constructor(readonly text: string, start: number) { this.index = start; }
  space(): void { while (/\s/.test(this.text[this.index] ?? '')) this.index += 1; }
  take(token: string): boolean {
    this.space();
    if (!this.text.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }
  string(): Target | undefined {
    this.space();
    const match = STRING.exec(this.text.slice(this.index));
    if (match === null) return undefined;
    const specifier = staticSpecifier(match);
    if (specifier === undefined) return undefined;
    const offset = this.index + 1;
    this.index += match[0].length;
    return { specifier, offset };
  }
  literal(pattern: RegExp): boolean {
    this.space();
    const match = pattern.exec(this.text.slice(this.index));
    if (match === null) return false;
    this.index += match[0].length;
    return true;
  }
  value(depth = 0): boolean {
    if (depth > 32) return false;
    if (this.string() !== undefined || this.literal(/^(?:true|false|null)\b|^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\b/i)) return true;
    const object = this.take('{');
    if (!object && !this.take('[')) return false;
    const close = object ? '}' : ']';
    if (this.take(close)) return true;
    do {
      if (object && ((this.string() === undefined && !this.literal(KEY)) || !this.take(':'))) return false;
      if (!this.value(depth + 1)) return false;
      if (this.take(close)) return true;
      if (!this.take(',')) return false;
    } while (!this.take(close));
    return true;
  }
}

/** Only understood literal options can support a complete file-selection proof. */
function globOptions(reader: StaticReader): { base?: string; unread: boolean } | undefined {
  if (!reader.take('{')) return undefined;
  const result: { base?: string; unread: boolean } = { unread: false };
  if (reader.take('}')) return result;
  do {
    reader.space();
    const quoted = reader.string();
    const key = quoted?.specifier ?? KEY.exec(reader.text.slice(reader.index))?.[0];
    if (key === undefined) return undefined;
    if (quoted === undefined) reader.index += key.length;
    if (!reader.take(':')) return undefined;
    if (['base', 'import', 'as'].includes(key)) {
      const value = reader.string();
      if (value === undefined) {
        result.unread = true;
        if (!reader.value()) return undefined;
      } else if (key === 'base') result.base = value.specifier;
    } else if (key === 'eager' || key === 'exhaustive') {
      if (!reader.literal(/^(?:true|false)\b/)) {
        result.unread = true;
        if (!reader.value()) return undefined;
      }
    } else {
      if (key !== 'query') result.unread = true;
      if (!reader.value()) return undefined;
    }
    if (reader.take('}')) return result;
    if (!reader.take(',')) return undefined;
  } while (!reader.take('}'));
  return result;
}

/** Portable path normalization for the browser-shared core. Escaping the workspace fails. */
function resolveParts(base: readonly string[], value: string): string[] | undefined {
  const parts = [...base];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts;
}

/** filePath and projectDir share the host's workspace-relative POSIX coordinates. */
function classify(target: Target, glob: boolean, filePath?: string, projectDir = ''): { target?: Target; localDirectory?: string; unread: boolean } {
  const value = target.specifier;
  if (value === '' || /[\\\x00-\x1f]/.test(value)) return { unread: true };
  const parts = value.split('/');
  const modules = parts.lastIndexOf('node_modules');
  if (modules !== -1) {
    const specifier = parts.slice(modules + 1).join('/');
    const name = importedPackageName(specifier);
    // A glob must not select arbitrary packages, nor vary the module directory.
    if (parts.slice(modules + 1).some(part => part.includes('..') || part === '.') || name === null || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) ||
        parts.slice(0, modules).some(hasGlobMagic)) return { unread: true };
    return { target: { specifier, offset: target.offset + parts.slice(0, modules + 1).join('/').length + 1 }, unread: false };
  }
  // Brace/character-class patterns mentioning node_modules are not local-only.
  if (value.includes('node_modules')) return { unread: true };
  const relative = value === '.' || value === '..' || /^\.\.?\//.test(value);
  if (!relative && !(glob && value.startsWith('/') && !value.startsWith('//'))) {
    if (glob || value.startsWith('/') || /^[a-z][\w+.-]*:/i.test(value)) return { unread: true };
    const name = importedPackageName(value);
    return name !== null && /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)
      ? { target, unread: false } : { unread: true };
  }
  if (filePath === undefined) return { unread: true };
  const root = resolveParts([], projectDir);
  const source = resolveParts([], filePath);
  if (root === undefined || source === undefined || filePath.startsWith('/')) return { unread: true };
  const inside = (candidate: string[] | undefined): boolean =>
    candidate !== undefined && root.every((part, index) => candidate[index] === part);
  if (!inside(source)) return { unread: true };
  // Traversal after or within glob syntax cannot be normalized as a directory.
  if (parts.some((part, index) =>
    (part.includes('..') && part !== '..' && hasGlobMagic(part)) ||
    (part === '..' && parts.slice(0, index).some(hasGlobMagic)))) return { unread: true };
  const resolved = relative ? resolveParts(source.slice(0, -1), value) : resolveParts(root, value.slice(1));
  if (!inside(resolved)) return { unread: true };
  // Prove a superset of possible matches: the whole static directory prefix.
  const magic = parts.findIndex(hasGlobMagic);
  const directory = (magic < 0 ? glob ? parts.slice(0, -1) : parts : parts.slice(0, magic)).join('/');
  const local = relative ? resolveParts(source.slice(0, -1), directory) : resolveParts(root, directory.slice(1));
  return inside(local) ? { localDirectory: local?.join('/') ?? '', unread: false } : { unread: true };
}

export function scanBulkImport(candidate: string, filePath?: string, projectDir = ''): BulkImport | undefined {
  const prefix = PREFIX.exec(candidate);
  if (prefix === null) return undefined;
  const glob = candidate.startsWith('import');
  const result: BulkImport = { kind: glob ? 'dynamic-import' : 'require', targets: [], localDirectories: [], unread: false };
  const reader = new StaticReader(candidate, prefix[0].length);
  const targets: Target[] = [];
  const array = glob && reader.take('[');
  let syntax = true;
  let base: string | undefined;
  if (!array || !reader.take(']')) {
    do {
      const target = reader.string();
      if (target === undefined) { syntax = false; break; }
      targets.push(target);
      if (!array || reader.take(']')) break;
      if (!reader.take(',')) { syntax = false; break; }
      if (reader.take(']')) break;
    } while (reader.index < candidate.length);
  }
  if (syntax && reader.take(',')) {
    if (!reader.take(')')) {
      if (glob) {
        const options = globOptions(reader);
        syntax = options !== undefined;
        base = options?.base;
        result.unread ||= options?.unread ?? true;
        reader.take(',');
        syntax = syntax && reader.take(')');
      } else {
        syntax = reader.literal(/^(?:true|false)\b/);
        if (syntax && reader.take(',')) {
          if (!reader.take(')')) {
            reader.space();
            const end = candidate[reader.index] === '/' ? regexLiteralEnd(candidate, reader.index) : undefined;
            syntax = end !== undefined;
            if (end !== undefined) reader.index = end;
            reader.take(',');
            syntax = syntax && reader.take(')');
          }
        } else syntax = syntax && reader.take(')');
      }
    }
  } else syntax = syntax && reader.take(')');
  let baseFile = filePath;
  if (base !== undefined) {
    const root = resolveParts([], projectDir);
    const relative = /^\.\.?\//.test(base);
    const resolved = filePath === undefined ? undefined : relative
      ? resolveParts(filePath.split('/').slice(0, -1), base)
      : base.startsWith('/') && !base.startsWith('//') ? resolveParts(root ?? [], base.slice(1)) : undefined;
    if (root === undefined || resolved === undefined || !root.every((part, index) => resolved[index] === part) ||
        /[\\\x00-\x1f]/.test(base) || hasGlobMagic(base) || base.split('/').includes('node_modules') || resolved.includes('node_modules')) result.unread = true;
    else baseFile = [...resolved, '__glob__.js'].join('/');
  }
  for (const target of targets) {
    // Absolute patterns remain project-root-relative even when a base is supplied.
    const classification = classify(target, glob, baseFile, projectDir);
    if (classification.localDirectory !== undefined) result.localDirectories.push(classification.localDirectory);
    if (classification.target !== undefined) result.targets.push(classification.target);
    if (classification.unread) result.unread = true;
  }
  result.unread ||= !syntax;
  return result;
}
