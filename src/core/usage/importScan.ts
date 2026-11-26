/**
 * Static import/require/dynamic-import detection in one file's source text.
 *
 * Deliberately not a naive substring search: a package name appearing inside
 * a comment or an unrelated string literal must never count as usage. This
 * runs two passes instead:
 *
 *   1. `stripComments` walks the text once, blanking `//` and `/* *\/`
 *      comment content with spaces (preserving every line break, so line
 *      numbers stay correct) while passing string/template literal content
 *      through untouched: length-preserving throughout, so every offset in
 *      the stripped text is the identical offset in the original.
 *   2. A small set of targeted patterns then finds only the specifier
 *      immediately following `import`, a require/import call (including
 *      `require.resolve`, `require.resolve.paths`, and `import.meta.resolve`), or
 *      `export .. from`, never an arbitrary quoted string elsewhere in
 *      the file.
 *
 * This is intentionally not a full JS/TS parser: it is good enough for the
 * common, statically visible forms, not a promise of perfect detection.
 */

import { QUOTED, staticSpecifier } from './staticSpecifier.js';
import { scanBulkImport } from './bulkImportScan.js';
import { importedPackageName } from './packageNameMatch.js';
import { CALL_TRIVIA, codePositionMask, IDENTIFIER, MAX_MATCH_LENGTH } from './jsxLex.js';

export { CALL_TRIVIA } from './jsxLex.js';

export interface RawImportMatch {
  /** The bare package name the specifier resolved to (subpath already stripped), never the raw specifier. */
  packageName: string;
  line: number;
  column: number;
  snippet: string;
  kind: 'import' | 'require' | 'dynamic-import';
}

/** The same trusted static match plus the literal package specifier needed by target-surface compatibility checks. */
export interface RawImportSpecifierMatch extends RawImportMatch {
  specifier: string;
}

const MAX_SNIPPET_LENGTH = 160;

function stripComments(text: string, jsx: boolean): string {
  const characters = text.split('');
  codePositionMask(text, undefined, (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (!/[\r\n]/.test(characters[index] ?? '')) characters[index] = ' ';
    }
  }, jsx);
  return characters.join('');
}

const SIMPLE_TYPE = `${IDENTIFIER}(?:${CALL_TRIVIA}\\.${CALL_TRIVIA}${IDENTIFIER})*(?:${CALL_TRIVIA}\\[${CALL_TRIVIA}\\])*`;
const CALL_DOT = `${CALL_TRIVIA}\\.${CALL_TRIVIA}`;
const REQUIRE_CALLEE = `require(?:${CALL_DOT}resolve(?:${CALL_DOT}paths)?)?`;
const IMPORT_CALLEE = `import(?:${CALL_DOT}meta${CALL_DOT}resolve)?`;
const TYPE_ARGUMENTS = `<${CALL_TRIVIA}${SIMPLE_TYPE}(?:${CALL_TRIVIA},${CALL_TRIVIA}${SIMPLE_TYPE})*${CALL_TRIVIA},?${CALL_TRIVIA}>`;
const CALL_SUFFIX = `${CALL_TRIVIA}(?:${TYPE_ARGUMENTS}${CALL_TRIVIA})?(?:\\?\\.${CALL_TRIVIA})?\\(`;
/** Broad coverage gate also catches call shapes the static matcher cannot read. */
export const DEPENDENCY_CALL = `\\b(?:require|import)\\b${CALL_TRIVIA}[.?(<!\\[]`;
const KNOWN_CALL = new RegExp(`^(?:${REQUIRE_CALLEE}|${IMPORT_CALLEE})${CALL_SUFFIX}`, 'u');
// Punctuation can touch keywords: `export*from"pkg"` and `export type{T}`.
// Share this prefix with coverage checking so compact re-exports cannot vanish.
const REEXPORT_PREFIX = String.raw`export\b\s*(?:type\b\s*)?(?=[{*])`;
const REEXPORT_START = new RegExp(`^${REEXPORT_PREFIX}`);

export type ScriptLanguage = 'js' | 'jsx' | 'ts' | 'tsx';

/** Extracted blocks use their declared language; fileless callers retain JSX support. */
function allowsJsx(filePath?: string, language?: ScriptLanguage): boolean {
  if (language !== undefined) return language === 'jsx' || language === 'tsx';
  return filePath === undefined || !/\.(?:ts|mts|cts)$/i.test(filePath);
}

/** Report unreadable source and calls whose package specifier is not static.
 * filePath and projectDir use workspace-relative POSIX paths for local loaders.
 * Kept under the original export name for existing coverage consumers. */
export function hasUnreadTemplateImports(text: string, filePath?: string, language?: ScriptLanguage, projectDir = '', isLocalCovered: (directory: string) => boolean = () => false, isSpecifierCovered: (specifier: string) => boolean = () => true): boolean {
  let unread = false;
  const jsx = allowsJsx(filePath, language);
  const code = codePositionMask(text, () => { unread = true; }, undefined, jsx);
  const cleaned = stripComments(text, jsx);
  for (const access of cleaned.matchAll(/\b(?:module|globalThis|window|require)\b\s*(?:\?\.\s*)?\[/g)) {
    if (code[access.index] !== true) continue;
    const key = STATIC_COMPUTED_KEY.exec(cleaned.slice(access.index + access[0].length, access.index + MAX_MATCH_LENGTH));
    const value = key === null ? undefined : staticSpecifier(key);
    if (value === undefined || value === 'require' || value === 'import') unread = true;
  }
  for (const index of executableKeywords(cleaned, code)) {
    const candidate = cleaned.slice(index, index + MAX_MATCH_LENGTH);
    if (isNonLoaderProperty(cleaned, code, index, candidate)) continue;
    const bulk = scanBulkImport(candidate, filePath, projectDir);
    if (bulk !== undefined) {
      if (bulk.unread || bulk.localDirectories.some(directory => !isLocalCovered(directory))) unread = true;
      continue;
    }
    const call = KNOWN_CALL.exec(candidate);
    if (call !== null) {
      const argument = STATIC_CALL_ARGUMENT.exec(candidate.slice(call[0].length));
      const specifier = argument === null ? undefined : staticSpecifier(argument);
      if (specifier === undefined || !isSpecifierCovered(specifier)) {
        // Interpolation can introduce separators or traversal. Scanning the
        // static prefix directory cannot prove coverage of all possible targets.
        unread = true;
      }
      continue;
    }
    const keyword = /^(require|import|export)\b/.exec(candidate)?.[1];
    if (keyword === 'require') {
      // Aliases, computed/optional members, non-null assertions and unfamiliar
      // type arguments can all call a loader. Do not guess at their grammar.
      unread = true;
    } else if (keyword === 'import') {
      const declaration = staticDeclarationMatch(candidate);
      if (declaration !== null) {
        const specifier = staticSpecifier(declaration);
        if (specifier === undefined || !isSpecifierCovered(specifier)) unread = true;
      } else if (!/^import\s*\.\s*meta\s*\.\s*(?:url|env|hot|dirname|filename)\b/.test(candidate)) {
        unread = true;
      }
    } else if (REEXPORT_START.test(candidate)) {
      const clause = exportClause(candidate);
      if (clause === undefined) continue;
      const declaration = staticDeclarationMatch(candidate);
      const specifier = declaration === null ? undefined : staticSpecifier(declaration);
      if (specifier === undefined || !isSpecifierCovered(specifier)) unread = true;
    } else if (keyword === 'export' && 'type'.startsWith(candidate.slice('export'.length).trim())) {
      // The bound may end in trivia or partway through the optional `type`
      // token before a re-export's opening brace/star.
      unread = true;
    }
  }
  return unread;
}

/** Ignore names in clear property positions, but retain calls, aliases and computed access. */
function isNonLoaderProperty(text: string, code: readonly boolean[], index: number, candidate: string): boolean {
  const keyword = /^(?:require|import)\b/.exec(candidate)?.[0];
  if (keyword === undefined) return false;
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(text[previous] ?? '')) previous -= 1;
  if (text[previous] === '.' && text[previous - 1] !== '.') {
    const receiver = text.slice(Math.max(0, previous - MAX_MATCH_LENGTH), previous).trimEnd();
    if (/\b(?:module|globalThis|window)\s*\??$/.test(receiver)) return false;
    // A bare member name is harmless. A call or computed access may still be
    // module.require(name), or another loader shape we cannot resolve.
    const member = new RegExp(`^(?:require|import)(?:\\s*\\.\\s*${IDENTIFIER})*\\s*`, 'u').exec(candidate);
    return !/^[([<!?.]/.test(candidate.slice(member?.[0].length ?? keyword.length));
  }
  if (!/[{,]/.test(text[previous] ?? '')) return false;
  const after = candidate.slice(keyword.length).trimStart();
  if (after.startsWith(':')) return true;
  if (!/^[,}]/.test(after)) return false;
  // Shorthand must be inside an object, not an argument such as f(0, require, 1).
  // Bound the lookbehind just like static matching; uncertainty stays blocking.
  const closings: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let cursor = previous; cursor >= Math.max(0, index - MAX_MATCH_LENGTH); cursor -= 1) {
    if (!code[cursor]) continue;
    const character = text[cursor] ?? '';
    if (pairs[character] !== undefined) closings.push(pairs[character]);
    else if (/[([{]/.test(character)) {
      if (closings.length > 0) {
        if (closings.pop() !== character) return false;
      } else {
        if (character !== '{') return false;
        const prefix = text.slice(Math.max(0, cursor - MAX_MATCH_LENGTH), cursor).trimEnd();
        return /[=([{,:?]$|\breturn$/.test(prefix);
      }
    }
  }
  return false;
}

interface KeywordPattern {
  kind: RawImportMatch['kind'];
  regex: RegExp;
}

const STATIC_ARGUMENT = `${QUOTED}(?=${CALL_TRIVIA}[,)])`;
const STATIC_CALL_ARGUMENT = new RegExp(`^${CALL_TRIVIA}${STATIC_ARGUMENT}`);
const STATIC_COMPUTED_KEY = new RegExp(`^\\s*${QUOTED}\\s*\\]`);

const STATIC_DECLARATIONS = [
  // Only import bindings and re-export lists/stars can have a from clause.
  // In particular, never search the rest of the file after `export const`.
  new RegExp(`^import\\b(?!\\s*[('"\x60.<])[^'"\x60;]*?\\bfrom\\b\\s*${QUOTED}`),
  new RegExp(`^import\\b\\s*${QUOTED}`),
];

const EXPORT_STRING = new RegExp(`^${QUOTED}`);
const EXPORT_STAR = new RegExp(`^\\*(?:\\s*as\\s+(?:${QUOTED}|${IDENTIFIER}))?`, 'u');

/** Undefined proves a closed local list; null means an ambiguous/truncated clause. */
function exportClause(candidate: string): string | null | undefined {
  const prefix = REEXPORT_START.exec(candidate);
  if (prefix === null) return null;
  let end = prefix[0].length;
  if (candidate[end] === '{') {
    end += 1;
    while (end < candidate.length && candidate[end] !== '}') {
      const character = candidate[end] ?? '';
      if (character === '"' || character === "'") {
        const literal = EXPORT_STRING.exec(candidate.slice(end));
        if (literal === null) return null;
        end += literal[0].length;
      } else {
        if (/[{;`]/.test(character)) return null;
        end += 1;
      }
    }
    if (candidate[end] !== '}') return null;
    end += 1;
    const tail = candidate.slice(end).trimStart();
    if (tail === '') return candidate.length === MAX_MATCH_LENGTH ? null : undefined;
    if (/^[;}]|^(?:import|export|const|let|var|function|class)\b/.test(tail)) return undefined;
    if (!/^from\b/.test(tail)) return null;
  } else {
    const star = EXPORT_STAR.exec(candidate.slice(end));
    if (star === null) return null;
    end += star[0].length;
  }
  return candidate.slice(end);
}

const EXPORT_ARGUMENT = new RegExp(`^\\s*from\\b\\s*${QUOTED}`);
function staticDeclarationMatch(candidate: string): RegExpExecArray | null {
  if (REEXPORT_START.test(candidate)) {
    const clause = exportClause(candidate);
    if (clause == null) return null;
    const match = EXPORT_ARGUMENT.exec(clause);
    if (match !== null) match[0] = candidate.slice(0, candidate.length - clause.length) + match[0];
    return match;
  }
  for (const regex of STATIC_DECLARATIONS) {
    const match = regex.exec(candidate);
    if (match !== null) return match;
  }
  return null;
}

const KEYWORD_PATTERNS: KeywordPattern[] = [
  { kind: 'dynamic-import', regex: new RegExp(`^${IMPORT_CALLEE}${CALL_SUFFIX}${CALL_TRIVIA}${STATIC_ARGUMENT}`, 'u') },
  { kind: 'require', regex: new RegExp(`^${REQUIRE_CALLEE}${CALL_SUFFIX}${CALL_TRIVIA}${STATIC_ARGUMENT}`, 'u') },
];

/** Match each executable keyword independently: literal text and interpolated
 * arguments can overlap later calls, even when the outer match is rejected. */
function* executableKeywords(text: string, code: readonly boolean[]): Generator<number> {
  for (const match of text.matchAll(/\b(?:require|import|export)\b/g)) {
    if (code[match.index] === true) yield match.index;
  }
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function locate(lineStarts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  const lineStart = lineStarts[low] ?? 0;
  return { line: low + 1, column: index - lineStart + 1 };
}

function lineTextAt(text: string, lineStarts: readonly number[], line: number): string {
  const start = lineStarts[line - 1] ?? 0;
  const end = (lineStarts[line] ?? text.length + 1) - 1;
  const raw = text.slice(start, end).trim();
  return raw.length > MAX_SNIPPET_LENGTH ? `${raw.slice(0, MAX_SNIPPET_LENGTH)}…` : raw;
}

type StaticImport = { kind: RawImportMatch['kind']; specifier: string; specifierIndex: number };

/** Every static import/require/dynamic-import specifier in executable code, once per occurrence. */
function staticImports(text: string, filePath?: string, language?: ScriptLanguage): StaticImport[] {
  const jsx = allowsJsx(filePath, language);
  const cleaned = stripComments(text, jsx);
  const codePositions = codePositionMask(text, undefined, undefined, jsx);
  const found: StaticImport[] = [];
  // Avoid double-reporting the same specifier occurrence under more than one
  // pattern (the `import ... from` and side-effect-`import` patterns are
  // mutually exclusive by construction, but keyed dedupe is cheap insurance).
  const seenAtIndex = new Set<number>();

  for (const index of executableKeywords(cleaned, codePositions)) {
    const candidate = cleaned.slice(index, index + MAX_MATCH_LENGTH);
    const bulk = scanBulkImport(candidate, filePath);
    const imports: StaticImport[] = (bulk?.targets ?? []).map(target => ({
      kind: bulk?.kind ?? 'require', specifier: target.specifier, specifierIndex: index + target.offset,
    }));
    const declaration = staticDeclarationMatch(candidate);
    const patterns: Array<{ kind: RawImportMatch['kind']; match: RegExpExecArray }> = declaration === null ? [] : [{ kind: 'import' as const, match: declaration }];
    for (const { kind, regex } of KEYWORD_PATTERNS) {
      const match = regex.exec(candidate);
      if (match !== null) patterns.push({ kind, match });
    }
    for (const { kind, match } of patterns) {
      const specifier = staticSpecifier(match);
      if (specifier === undefined) continue;
      const specifierIndex = index + match[0].lastIndexOf(match[2] ?? '');
      imports.push({ kind, specifier, specifierIndex });
    }
    for (const entry of imports) {
      if (seenAtIndex.has(entry.specifierIndex)) continue;
      seenAtIndex.add(entry.specifierIndex);
      found.push(entry);
    }
  }
  return found;
}

export function scanSourceForImportSpecifiers(text: string, filePath?: string, language?: ScriptLanguage): RawImportSpecifierMatch[] {
  const lineStarts = buildLineStarts(text);
  const lineSnippets = new Map<number, string>();
  const matches: RawImportSpecifierMatch[] = [];
  for (const { kind, specifier, specifierIndex } of staticImports(text, filePath, language)) {
    const packageName = importedPackageName(specifier);
    if (packageName === null) continue;

    const { line, column } = locate(lineStarts, specifierIndex);
    let snippet = lineSnippets.get(line);
    if (snippet === undefined) {
      snippet = lineTextAt(text, lineStarts, line);
      lineSnippets.set(line, snippet);
    }
    matches.push({ packageName, specifier, line, column, snippet, kind });
  }

  matches.sort((a, b) => a.line - b.line || a.column - b.column);
  return matches;
}

/** Every decoded static specifier, whether it names a package or a path. */
export function scanSourceForStaticSpecifiers(text: string, filePath?: string, language?: ScriptLanguage): string[] {
  return staticImports(text, filePath, language).map(({ specifier }) => specifier);
}

/** Backward-compatible usage-analysis shape. Detailed consumers opt into the function above. */
export function scanSourceForImports(text: string, filePath?: string, language?: ScriptLanguage): RawImportMatch[] {
  return scanSourceForImportSpecifiers(text, filePath, language).map(({ specifier: _specifier, ...match }) => match);
}
