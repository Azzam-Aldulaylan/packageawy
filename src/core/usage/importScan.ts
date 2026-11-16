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

import { importedPackageName } from './packageNameMatch.js';

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

function stripComments(text: string): string {
  const characters = text.split('');
  codePositionMask(text, undefined, undefined, (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (!/[\r\n]/.test(characters[index] ?? '')) characters[index] = ' ';
    }
  });
  return characters.join('');
}

interface ExpressionContext {
  previousSignificant: string;
  previousWord: string;
  controlParentheses: boolean[];
  afterControlCondition: boolean;
  delimiterDepth: number;
  typeAssertionDepth: number | undefined;
}

/** Undefined means the lexical goal needs grammar this walker does not have. */
function regexCanStart(context: ExpressionContext): boolean | undefined {
  // `>` can end a TS generic/assertion or precede a regex in a comparison.
  if (/^(?:}|>|\.|unknown)$/.test(context.previousSignificant)) return undefined;
  // `void` ends a type in assertions but prefixes an expression in JS.
  if (context.typeAssertionDepth !== undefined && context.previousWord === 'void') return undefined;
  // `of` is contextual in for-of headers; deciding its role needs the grammar.
  if (context.previousWord === 'of' && context.controlParentheses.includes(true)) return undefined;
  return context.previousSignificant === '' || context.previousSignificant === '...' ||
    /^[=([{,;:!?&|+\-*/%~<>^]$/.test(context.previousSignificant) ||
    context.afterControlCondition ||
    /^(?:return|typeof|case|do|else|in|instanceof|new|delete|void|throw|yield|await)$/.test(context.previousWord);
}

function isControlKeyword(word: string): boolean {
  return /^(?:if|for|while|with|switch|catch)$/.test(word);
}

function expressionContext(): ExpressionContext {
  return {
    previousSignificant: '', previousWord: '', controlParentheses: [], afterControlCondition: false,
    delimiterDepth: 0, typeAssertionDepth: undefined,
  };
}

function endExpression(context: ExpressionContext): void {
  context.previousSignificant = 'literal';
  context.previousWord = '';
  context.afterControlCondition = false;
}

/** Consume whole tokens so ++/-- and numeric exponent signs cannot become binary operators. */
function expressionTokenEnd(text: string, start: number, context: ExpressionContext): number {
  const character = text[start] ?? '';
  const next = text[start + 1];
  let end = start + 1;
  if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(next ?? ''))) {
    const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?[\d_]+)?)n?/.exec(text.slice(start));
    endExpression(context);
    return start + (number?.[0].length ?? 1);
  }
  if (/[\p{ID_Start}$_]/u.test(character)) {
    while (/[\p{ID_Continue}$\u200c\u200d]/u.test(text[end] ?? '')) end += 1;
    // A property named return/typeof/etc. is still an expression end.
    context.previousWord = context.previousSignificant === '.' ? '' : text.slice(start, end);
    if (/^(?:as|satisfies)$/.test(context.previousWord)) {
      context.typeAssertionDepth ??= context.delimiterDepth;
    }
    context.previousSignificant = 'identifier';
    context.afterControlCondition = false;
    return end;
  }
  if ((character === '+' || character === '-') && next === character) {
    const allowed = regexCanStart(context);
    context.previousSignificant = allowed === undefined ? 'unknown' : allowed ? character : 'literal';
    end += 1;
  } else if (character === '?' && next === '.') {
    context.previousSignificant = '.';
    end += 1;
  } else if (text.startsWith('...', start)) {
    context.previousSignificant = '...';
    end += 2;
  } else if (character === '!' && next !== '=' && regexCanStart(context) !== true) {
    // TypeScript also uses ! as a postfix non-null assertion.
    context.previousSignificant = 'unknown';
  } else {
    if (character === '(') context.controlParentheses.push(isControlKeyword(context.previousWord));
    if (/^[([{]$/.test(character)) context.delimiterDepth += 1;
    else if (/^[)\]}]$/.test(character)) context.delimiterDepth -= 1;
    // Keep type context through unions, conditionals and nested type members.
    // Only a containing delimiter or same-level semicolon safely ends it.
    if (context.typeAssertionDepth !== undefined &&
        (context.delimiterDepth < context.typeAssertionDepth ||
         (character === ';' && context.delimiterDepth === context.typeAssertionDepth))) {
      context.typeAssertionDepth = undefined;
    }
    context.previousSignificant = /^[()[\]{}.,;:=!?&|+\-*/%~<>^]$/.test(character) ? character : 'unknown';
  }
  context.afterControlCondition = character === ')' && context.controlParentheses.pop() === true;
  context.previousWord = '';
  return end;
}

/** A regex cannot cross a line terminator, even after an escape. */
function regexLiteralEnd(text: string, start: number): number | undefined {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const character = text[index];
    if (/[\r\n\u2028\u2029]/.test(character ?? '')) return undefined;
    if (character === '\\') {
      if (index + 1 >= text.length || /[\r\n\u2028\u2029]/.test(text[index + 1] ?? '')) return undefined;
      index += 2;
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      index += 1;
      while (/[\p{ID_Continue}$]/u.test(text[index] ?? '')) index += 1;
      return index;
    }
    index += 1;
  }
  return undefined;
}

function templateLiteralEnd(text: string, start: number, onUncertain?: () => void): number {
  const stack: Array<{ kind: 'template' } | ({ kind: 'expression'; depth: number } & ExpressionContext)> = [{ kind: 'template' }];
  const uncertain = (): number => {
    onUncertain?.();
    return text.length;
  };
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const frame = stack[stack.length - 1];
    const character = text[index];
    const next = text[index + 1];
    if (frame?.kind === 'template') {
      if (character === '\\') index += 1;
      else if (character === '`') stack.pop();
      else if (character === '$' && next === '{') {
        stack.push({ kind: 'expression', depth: 1, ...expressionContext() });
        index += 1;
      }
    } else if (frame?.kind === 'expression') {
      if (character === '"' || character === "'") {
        const quote = character;
        index += 1;
        while (index < text.length && text[index] !== quote) index += text[index] === '\\' ? 2 : 1;
        if (index >= text.length) return uncertain();
        endExpression(frame);
      } else if (character === '/' && next === '/') {
        while (index < text.length && !/[\r\n\u2028\u2029]/.test(text[index] ?? '')) index += 1;
        continue;
      } else if (character === '/' && next === '*') {
        const end = text.indexOf('*/', index + 2);
        if (end === -1) return uncertain();
        index = end + 2;
        continue;
      } else if (character === '/' && regexCanStart(frame) !== false) {
        if (regexCanStart(frame) === undefined) return uncertain();
        const end = regexLiteralEnd(text, index);
        if (end === undefined) return uncertain();
        index = end;
        endExpression(frame);
        continue;
      } else if (character === '`') {
        endExpression(frame);
        stack.push({ kind: 'template' });
      } else if (!/\s/.test(character ?? '')) {
        if (character === '{') frame.depth += 1;
        else if (character === '}') {
          frame.depth -= 1;
          if (frame.depth === 0) stack.pop();
        }
        index = expressionTokenEnd(text, index, frame);
        continue;
      }
    }
    index += 1;
  }
  return stack.length > 0 ? uncertain() : Math.min(index, text.length);
}

/**
 * Marks positions that are executable source rather than comment/string/
 * template/regex contents. The regex matcher below still needs quoted
 * specifiers intact, so it checks only that the import/require keyword begins
 * in code. Conservative template masking may miss imports inside `${...}`;
 * that is preferable to promoting documentation text to confirmed evidence.
 */
function codePositionMask(
  text: string,
  onTemplate?: (value: string) => void,
  onUncertain?: () => void,
  onComment?: (start: number, end: number) => void,
): boolean[] {
  const code = new Array<boolean>(text.length).fill(true);
  const context = expressionContext();
  const hashbangStart = text.startsWith('\ufeff') ? 1 : 0;
  let index = 0;
  const hideUntil = (end: number): void => {
    while (index < end) code[index++] = false;
  };
  const uncertain = (): void => {
    onUncertain?.();
    hideUntil(text.length);
  };
  while (index < text.length) {
    const character = text[index] ?? '';
    const next = text[index + 1] ?? '';
    const isHashbang = index === hashbangStart && character === '#' && next === '!';
    if (isHashbang || (character === '/' && (next === '/' || next === '*'))) {
      const start = index;
      if (isHashbang || next === '/') {
        while (index < text.length && !/[\r\n\u2028\u2029]/.test(text[index] ?? '')) code[index++] = false;
      } else {
        const end = text.indexOf('*/', index + 2);
        if (end === -1) uncertain();
        else hideUntil(end + 2);
      }
      onComment?.(start, index);
      continue;
    }
    if (character === '`') {
      const end = templateLiteralEnd(text, index, onUncertain);
      onTemplate?.(text.slice(index + 1, end));
      hideUntil(end);
      endExpression(context);
      continue;
    }
    if (character === "'" || character === '"') {
      code[index++] = false;
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        code[index++] = false;
        if (current === '\\' && index < text.length) {
          code[index++] = false;
        } else if (current === character) {
          closed = true;
          break;
        } else if (/[\r\n]/.test(current ?? '')) break;
      }
      if (!closed) uncertain();
      endExpression(context);
      continue;
    }
    if (character === '/' && regexCanStart(context) !== false) {
      const end = regexCanStart(context) === undefined ? undefined : regexLiteralEnd(text, index);
      if (end === undefined) uncertain();
      else hideUntil(end);
      endExpression(context);
      continue;
    }
    if (/\s/.test(character)) index += 1;
    else index = expressionTokenEnd(text, index, context);
  }
  return code;
}

/** Calls permit comments anywhere whitespace is legal between tokens. */
export const CALL_TRIVIA = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r?\n|$))*`;

const CALL_DOT = `${CALL_TRIVIA}\\.${CALL_TRIVIA}`;
const REQUIRE_CALLEE = `require(?:${CALL_DOT}resolve(?:${CALL_DOT}paths)?)?`;
const IMPORT_CALLEE = `import(?:${CALL_DOT}meta${CALL_DOT}resolve)?`;
/** Shared by static source detection and coverage gates for masked executable content. */
export const DEPENDENCY_CALL = `\\b(?:${REQUIRE_CALLEE}|${IMPORT_CALLEE})${CALL_TRIVIA}\\(`;

/** Report masked calls or uncertain source extraction without claiming confirmed references. */
export function hasUnreadTemplateImports(text: string): boolean {
  let unread = false;
  codePositionMask(text, (value) => {
    if (hasUnescapedTemplateInterpolation(value) && new RegExp(DEPENDENCY_CALL).test(value)) unread = true;
  }, () => { unread = true; });
  return unread;
}

interface KeywordPattern {
  kind: RawImportMatch['kind'];
  regex: RegExp;
}

const QUOTED = "(['\"`])((?:\\\\.|(?!\\1).)*)\\1";

const KEYWORD_PATTERNS: KeywordPattern[] = [
  { kind: 'dynamic-import', regex: new RegExp(`\\b${IMPORT_CALLEE}${CALL_TRIVIA}\\(${CALL_TRIVIA}${QUOTED}`, 'g') },
  // Keep resolution calls compatible with existing consumers by reporting
  // require calls as `require` references. Static resolution is still concrete evidence
  // that the package is needed at runtime or during tool configuration.
  { kind: 'require', regex: new RegExp(`\\b${REQUIRE_CALLEE}${CALL_TRIVIA}\\(${CALL_TRIVIA}${QUOTED}`, 'g') },
  // `import .. from '<spec>'` and `export .. from '<spec>'`: anything
  // between the keyword and `from` that isn't a quote/semicolon (covers
  // named/default/namespace/type imports and multi-line brace lists).
  { kind: 'import', regex: new RegExp(`\\b(?:import|export)\\b(?!\\s*\\()[^'"\`;]*?\\bfrom\\s*${QUOTED}`, 'g') },
  // Side-effect import: `import '<spec>'`: no `from`, so distinct from the pattern above.
  { kind: 'import', regex: new RegExp(`\\bimport\\s*${QUOTED}`, 'g') },
];

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
  const rawEnd = text.indexOf('\n', start);
  const end = rawEnd === -1 ? text.length : rawEnd;
  const raw = text.slice(start, end).trim();
  return raw.length > MAX_SNIPPET_LENGTH ? `${raw.slice(0, MAX_SNIPPET_LENGTH)}…` : raw;
}

function hasUnescapedTemplateInterpolation(value: string): boolean {
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== '$' || value[index + 1] !== '{') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

export function scanSourceForImportSpecifiers(text: string): RawImportSpecifierMatch[] {
  const cleaned = stripComments(text);
  const codePositions = codePositionMask(text);
  const lineStarts = buildLineStarts(text);
  const matches: RawImportSpecifierMatch[] = [];
  // Avoid double-reporting the same specifier occurrence under more than one
  // pattern (the `import ... from` and side-effect-`import` patterns are
  // mutually exclusive by construction, but keyed dedupe is cheap insurance).
  const seenAtIndex = new Set<number>();

  for (const { kind, regex } of KEYWORD_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      if (codePositions[match.index] !== true) continue;
      const specifier = match[2] ?? '';
      const quote = match[1];
      // Interpolated templates are runtime expressions, not exact package
      // subpaths. Treating them as literals could turn incomplete static
      // evidence into a false confirmed missing-file finding.
      if (quote === '`' && hasUnescapedTemplateInterpolation(specifier)) continue;
      const specifierIndex = match.index + match[0].lastIndexOf(specifier);
      if (seenAtIndex.has(specifierIndex)) continue;
      seenAtIndex.add(specifierIndex);

      const packageName = importedPackageName(specifier);
      if (packageName === null) continue;

      const { line, column } = locate(lineStarts, specifierIndex);
      matches.push({ packageName, specifier, line, column, snippet: lineTextAt(text, lineStarts, line), kind });
    }
  }

  matches.sort((a, b) => a.line - b.line || a.column - b.column);
  return matches;
}

/** Backward-compatible usage-analysis shape. Detailed consumers opt into the function above. */
export function scanSourceForImports(text: string): RawImportMatch[] {
  return scanSourceForImportSpecifiers(text).map(({ specifier: _specifier, ...match }) => match);
}
