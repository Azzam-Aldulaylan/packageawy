/** JSX/TSX-aware lexical masking and expression-boundary helpers for import scanning. */

/** Calls permit comments anywhere whitespace is legal between tokens. */
export const CALL_TRIVIA = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r?\n|$))*`;

// Fixed bounds keep unsuccessful matching linear even for semicolonless files.
// Longer or more complicated syntax is a coverage gap, never a removal signal.
export const MAX_MATCH_LENGTH = 4096;
export const IDENTIFIER = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$]*`;

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
  // Closing angles can end TS generics/assertions or precede a regex after an operator.
  if (/^(?:}|>{1,3}|\.|unknown)$/.test(context.previousSignificant)) return undefined;
  // `void` ends a type in assertions but prefixes an expression in JS.
  if (context.typeAssertionDepth !== undefined && context.previousWord === 'void') return undefined;
  // `of` is contextual in for-of headers; deciding its role needs the grammar.
  if (context.previousWord === 'of' && context.controlParentheses.includes(true)) return undefined;
  return context.previousSignificant === '' || context.previousSignificant === '...' || context.previousSignificant === '=>' ||
    /^(?:<<=?|>{1,3}=|<=)$/.test(context.previousSignificant) ||
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
  } else if (character === '=' && next === '>') {
    context.previousSignificant = '=>';
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
export function regexLiteralEnd(text: string, start: number): number | undefined {
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

type LexicalFrame =
  | ({ kind: 'code'; braces: number | undefined } & ExpressionContext)
  | { kind: 'template' }
  | { kind: 'jsx'; name: string; inTag: boolean };

/** Only enter markup where an expression may start. */
function jsxOpening(text: string, index: number): RegExpExecArray | null {
  return /^<(>|[\p{ID_Start}$_][\p{ID_Continue}$.:\-]*(?=[\s/<>]|$))/u.exec(text.slice(index));
}

/**
 * Mask literal text and markup, keeping executable template and JSX expressions
 * visible at their original offsets. Each expression gets its own slash goal.
 * An unreadable boundary stops the walk and keeps removal coverage incomplete.
 */
export function codePositionMask(
  text: string,
  onUncertain?: () => void,
  onComment?: (start: number, end: number) => void,
  jsx = true,
): boolean[] {
  const code = new Array<boolean>(text.length).fill(true);
  const stack: LexicalFrame[] = [{ kind: 'code', braces: undefined, ...expressionContext() }];
  const hashbangStart = text.startsWith('\ufeff') ? 1 : 0;
  let index = 0;
  const hideUntil = (end: number): void => {
    while (index < end) code[index++] = false;
  };
  const uncertain = (): void => {
    onUncertain?.();
    hideUntil(text.length);
  };
  const comment = (): void => {
    const start = index;
    if (text[index + 1] === '/' || text[index] === '#') {
      while (index < text.length && !/[\r\n\u2028\u2029]/.test(text[index] ?? '')) code[index++] = false;
    } else {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) uncertain();
      else hideUntil(end + 2);
    }
    onComment?.(start, index);
  };
  const openJsx = (opening: RegExpExecArray): void => {
    const name = opening[1] === '>' ? '' : opening[1] ?? '';
    stack.push({ kind: 'jsx', name, inTag: name !== '' });
    hideUntil(index + opening[0].length);
    // Type arguments may be separated from the element name by tag trivia.
    while (name !== '' && index < text.length) {
      if (/\s/.test(text[index] ?? '')) hideUntil(index + 1);
      else if (text[index] === '/' && /[/*]/.test(text[index + 1] ?? '')) comment();
      else break;
    }
    if (name !== '' && text[index] === '<') {
      const start = index;
      const end = genericEnd(text.slice(start, start + MAX_MATCH_LENGTH));
      if (end === undefined) { uncertain(); return; }
      // Types can contain import("pkg"). Keep their tokens visible, using
      // the non-JSX goal so nested generic angles cannot become markup.
      const mask = codePositionMask(text.slice(start, start + end), onUncertain,
        (from, to) => onComment?.(start + from, start + to), false);
      while (index < start + end) {
        code[index] = mask[index - start] ?? false;
        index += 1;
      }
    }
  };
  while (index < text.length) {
    const frame = stack[stack.length - 1];
    const character = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (frame?.kind === 'template') {
      if (character === '\\') hideUntil(Math.min(index + 2, text.length));
      else if (character === '`') {
        hideUntil(index + 1);
        stack.pop();
      } else if (character === '$' && next === '{') {
        hideUntil(index + 2);
        stack.push({ kind: 'code', braces: 1, ...expressionContext() });
      } else hideUntil(index + 1);
      continue;
    }
    if (frame?.kind === 'jsx') {
      // Once the opening tag has ended, slashes are ordinary JSX text.
      if (frame.inTag && character === '/' && (next === '/' || next === '*')) comment();
      else if (character === '{') {
        hideUntil(index + 1);
        stack.push({ kind: 'code', braces: 1, ...expressionContext() });
      } else if (frame.inTag && (character === '"' || character === "'")) {
        // JSX attribute strings use entities, not JS backslash escapes.
        const end = text.indexOf(character, index + 1);
        if (end === -1) uncertain();
        else hideUntil(end + 1);
      } else if (frame.inTag && character === '/' && next === '>') {
        hideUntil(index + 2);
        stack.pop();
      } else if (frame.inTag && character === '>') {
        hideUntil(index + 1);
        frame.inTag = false;
      } else if (!frame.inTag && character === '<') {
        const closing = /^<\/([\p{ID_Continue}$.:\-]*)\s*>/u.exec(text.slice(index));
        if (closing !== null && closing[1] === frame.name) {
          hideUntil(index + closing[0].length);
          stack.pop();
        } else {
          const opening = jsxOpening(text, index);
          if (opening === null) uncertain();
          else openJsx(opening);
        }
      } else if (frame.inTag && character === '<') uncertain();
      else hideUntil(index + 1);
      continue;
    }
    if (frame?.kind !== 'code') break;
    const isHashbang = index === hashbangStart && character === '#' && next === '!';
    if (isHashbang || (character === '/' && (next === '/' || next === '*'))) {
      comment();
      continue;
    }
    if (character === '`') {
      hideUntil(index + 1);
      endExpression(frame);
      stack.push({ kind: 'template' });
      continue;
    }
    if (character === "'" || character === '"') {
      code[index++] = false;
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        code[index++] = false;
        if (current === '\\' && index < text.length) {
          const escaped = text[index];
          code[index++] = false;
          if (escaped === '\r' && text[index] === '\n') code[index++] = false;
        } else if (current === character) {
          closed = true;
          break;
        } else if (/[\r\n]/.test(current ?? '')) break;
      }
      if (!closed) uncertain();
      endExpression(frame);
      continue;
    }
    if (character === '<' || character === '>') {
      // Consume the longest operator before JSX detection: the second < in
      // a shift must never become markup. Each operator expects a RHS expression.
      const operator = /^(?:>>>?=?|<<=?|[<>]=)/.exec(text.slice(index, index + 4));
      if (operator !== null) {
        index += operator[0].length;
        frame.previousSignificant = operator[0];
        frame.previousWord = '';
        frame.afterControlCondition = false;
        continue;
      }
    }
    // Right shifts expect an expression even though a following slash also has
    // to account for TypeScript's nested generic closing angles.
    if (jsx && character === '<' && (regexCanStart(frame) === true || /^>{2,3}$/.test(frame.previousSignificant))) {
      const candidate = text.slice(index, index + MAX_MATCH_LENGTH);
      // Recognize balanced generic-arrow parameters before trying JSX. Leave
      // type tokens executable so this classification cannot hide loader calls.
      const genericLooking = GENERIC_PREFIX.test(candidate) ||
        (candidate.length === MAX_MATCH_LENGTH && INCOMPLETE_GENERIC_PREFIX.test(candidate));
      const end = genericLooking ? genericEnd(candidate) : undefined;
      if (end !== undefined && GENERIC_ARGUMENTS_START.test(candidate.slice(end))) {
        index = expressionTokenEnd(text, index, frame);
        continue;
      }
      const opening = jsxOpening(text, index);
      const afterName = opening === null ? '' : candidate.slice(opening[0].length);
      const clearTag = opening !== null && (opening[1] === '>' || afterName.startsWith('<') ||
        TAG_CONTENT_START.test(afterName));
      if (genericLooking || !clearTag) uncertain();
      else if (opening !== null) {
        endExpression(frame);
        openJsx(opening);
      }
      continue;
    }
    if (character === '/' && regexCanStart(frame) !== false) {
      const end = regexCanStart(frame) === undefined ? undefined : regexLiteralEnd(text, index);
      if (end === undefined) uncertain();
      else hideUntil(end);
      endExpression(frame);
      continue;
    }
    if (frame.braces !== undefined) {
      if (character === '{') frame.braces += 1;
      else if (character === '}' && --frame.braces === 0) {
        hideUntil(index + 1);
        stack.pop();
        continue;
      }
    }
    // Escaped identifiers can spell loaders or their receivers. This walker
    // does not decode identifier tokens, so never certify that code as covered.
    if (character === '\\' && next === 'u') onUncertain?.();
    if (/\s/.test(character)) index += 1;
    else index = expressionTokenEnd(text, index, frame);
  }
  if (stack.length > 1) onUncertain?.();
  return code;
}

const GENERIC_PREFIX = new RegExp(`^<${CALL_TRIVIA}(?:const\\b|${IDENTIFIER}${CALL_TRIVIA}(?:[,=]|extends\\b))`, 'u');
// Exhausting the window before or inside `extends` cannot rule out a generic.
const INCOMPLETE_GENERIC_PREFIX = new RegExp(`^<${CALL_TRIVIA}${IDENTIFIER}${CALL_TRIVIA}(?:e|ex|ext|exte|exten|extend)?$`, 'u');
const GENERIC_ARGUMENTS_START = new RegExp(`^${CALL_TRIVIA}\\(`);
const TAG_CONTENT_START = new RegExp(`^${CALL_TRIVIA}(?:/?>|\\{|<|${IDENTIFIER})`, 'u');

/** Bounded delimiter matching supports object/array constraints and nested defaults. */
function genericEnd(candidate: string): number | undefined {
  const closings: string[] = [];
  const pairs: Record<string, string> = { '<': '>', '{': '}', '[': ']', '(': ')' };
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index] ?? '';
    if (candidate.startsWith('//', index)) {
      while (index < candidate.length && !/[\r\n\u2028\u2029]/.test(candidate[index] ?? '')) index += 1;
    } else if (candidate.startsWith('/*', index)) {
      const end = candidate.indexOf('*/', index + 2);
      if (end === -1) return undefined;
      index = end + 1;
    } else if (character === '"' || character === "'") {
      const quote = character;
      for (index += 1; index < candidate.length && candidate[index] !== quote; index += 1) {
        if (/[\r\n]/.test(candidate[index] ?? '')) return undefined;
        if (candidate[index] === '\\') index += 1;
      }
      if (index >= candidate.length) return undefined;
    } else if (pairs[character] !== undefined) closings.push(pairs[character]);
    else if (/[>})\]]/.test(character)) {
      if (character === '>' && candidate[index - 1] === '=') continue; // Function type arrow.
      if (closings.pop() !== character) return undefined;
      if (closings.length === 0) return index + 1;
    } else if (!/[\p{ID_Continue}$\s.,;:=?&|!+*\-]/u.test(character)) return undefined;
  }
  return undefined;
}
