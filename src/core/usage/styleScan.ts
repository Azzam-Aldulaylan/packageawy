/** Lexical stylesheet dependencies shared by source extraction and host resolution. */
export type StyleDialect = 'css' | 'scss' | 'sass' | 'less' | 'stylus';
export interface StyleTarget {
  target: string;
  offset: number;
  directive: string;
  /** CSS url() imports keep CSS resolution even in Sass. */
  cssImport?: boolean;
  /** Explicit Less (less)/(css) options override the imported file extension. */
  dialect?: 'less' | 'css';
  computed?: boolean;
}
export interface StyleScan {
  targets: StyleTarget[];
  unread: number[];
}
// Sass identifiers treat hyphens and underscores alike. Accept all namespace
// aliases and the unqualified spelling used with `@use "sass:meta" as *`.
export const isStyleLoader = (value: string): boolean => /(?:^|\.)load(?:[-_]css)?$/.test(value);
/** Builtins that read data or execute a plugin rather than import a stylesheet. */
export function styleFileKind(name: string, dialect: StyleDialect): 'data' | 'script' | undefined {
  if (dialect === 'stylus' && name === 'use') return 'script';
  if (dialect === 'stylus' && (name === 'json' || name === 'image-size') ||
      dialect === 'less' && /^image-(?:size|width|height)$/.test(name)) return 'data';
  return undefined;
}
interface Token { value: string; start: number; end: number; string: boolean }
const imageSet = (name: string): boolean => name === 'image-set' || name === '-webkit-image-set';
const assetFunction = (name: string, dialect: StyleDialect): boolean => name === 'url' || imageSet(name) ||
  dialect === 'less' && name === 'data-uri' || dialect === 'stylus' && name === 'embedurl';

export function styleDialect(fileOrLanguage: string): StyleDialect | undefined {
  const value = fileOrLanguage.toLowerCase().split('.').pop();
  if (value === 'scss' || value === 'sass' || value === 'less') return value;
  if (value === 'styl' || value === 'stylus') return 'stylus';
  if (value === 'css' || value === 'pcss' || value === 'postcss') return 'css';
  return undefined;
}

function escapeEnd(text: string, start: number): number {
  const hex = /^[\da-f]{1,6}(?:\r\n|\s)?/i.exec(text.slice(start + 1));
  return hex ? start + 1 + hex[0].length : Math.min(text.length, start + (text[start + 1] === '\r' && text[start + 2] === '\n' ? 3 : 2));
}

export function decodeStyleEscapes(text: string): string {
  return text.replace(/\\(?:([\da-f]{1,6})(?:\r\n|\s)?|\r\n|[\s\S])/gi, (match, hex: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
    }
    return /[\r\n]/.test(match) ? '' : match.slice(1);
  });
}

function tokenize(text: string, dialect: StyleDialect, unread: number[]): Token[] {
  const tokens: Token[] = [];
  const urlContexts: boolean[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const c = text[i] ?? '';
    if (/\s/.test(c)) { i += 1; continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) { unread.push(i); break; }
      i = end + 2;
      continue;
    }
    if (dialect !== 'css' && !urlContexts.at(-1) && text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      const content = i;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i = escapeEnd(text, i);
        else if (/[\r\n]/.test(text[i] ?? '')) break;
        else i += 1;
      }
      const value = decodeStyleEscapes(text.slice(content, i));
      if (text[i] !== c) unread.push(start);
      else i += 1;
      tokens.push({ value, start, end: i, string: true });
      continue;
    }
    if (/[{}();,:]/.test(c)) i += 1;
    else {
      while (i < text.length && !/[\s{}();,:"']/.test(text[i] ?? '')) {
        if (text[i] === '\\') i = escapeEnd(text, i);
        else if (/^[#@$]\{/.test(text.slice(i, i + 2))) {
          const end = text.indexOf('}', i + 2);
          if (end < 0) { unread.push(i); i = text.length; }
          else i = end + 1;
        } else if (text.startsWith('/*', i)) break;
        else i += 1;
      }
    }
    if (i === start) { i += 1; continue; }
    if (c === '(') urlContexts.push(urlContexts.at(-1) === true || assetFunction(tokens.at(-1)?.value.toLowerCase() ?? '', dialect));
    if (c === ')') urlContexts.pop();
    tokens.push({ value: decodeStyleEscapes(text.slice(start, i)), start, end: i, string: false });
  }
  return tokens;
}

/** No resolution decisions here: a bare Sass target may refer to a local partial. */
export function scanStylesheet(text: string, dialect: StyleDialect = 'css'): StyleScan {
  const result: StyleScan = { targets: [], unread: [] };
  const tokens = tokenize(text, dialect, result.unread);
  const computed = (value: string, quoted: boolean): boolean => !quoted &&
    (dialect === 'less' && value.startsWith('@') || dialect === 'stylus' && /^[\w$-]+$/.test(value));
  // Resolve parentheses and declaration searches once, including failed searches.
  const closes = new Map<number, number>();
  const opens: number[] = [];
  const nextFrom: number[] = [];
  const boundary: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i]?.string && tokens[i]?.value === '(') opens.push(i);
    if (!tokens[i]?.string && tokens[i]?.value === ')') {
      const open = opens.pop();
      if (open !== undefined) closes.set(open, i);
    }
  }
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    nextFrom[i] = !tokens[i]?.string && tokens[i]?.value === 'from' ? i : nextFrom[i + 1] ?? tokens.length;
    boundary[i] = !tokens[i]?.string && /^[;{}]$/.test(tokens[i]?.value ?? '') ? i : boundary[i + 1] ?? tokens.length;
    if ((dialect === 'sass' || dialect === 'stylus') && i > 0 &&
        /[\r\n]/.test(text.slice(tokens[i - 1]?.end, tokens[i]?.start))) boundary[i] = i;
  }
  const matching = (start: number): number => closes.get(start) ?? -1;
  const assetArgument = (start: number, end: number): void => {
    const first = tokens[start];
    if (first === undefined || start >= end) { result.unread.push(first?.start ?? text.length); return; }
    const quoted = first.string && start + 1 === end;
    const value = quoted ? first.value : decodeStyleEscapes(text.slice(first.start, tokens[end - 1]?.end).trim());
    result.targets.push({ target: value, offset: first.start + (quoted ? 1 : 0), directive: 'url',
      computed: computed(value, quoted) || !quoted && (first.string || tokens.slice(start, end).some(token => !token.string && ['(', '+'].includes(token.value))) });
  };
  const targetAt = (start: number, directive: string): number => {
    const token = tokens[start];
    if (token === undefined || /^[;{}]$/.test(token.value)) {
      result.unread.push(token?.start ?? text.length);
      return start;
    }
    if (!token.string && token.value.toLowerCase() === 'url' && tokens[start + 1]?.value === '(') {
      const end = matching(start + 1);
      if (end < 0) { result.unread.push(token.start); return tokens.length; }
      const first = tokens[start + 2];
      const value = first?.string && start + 3 === end ? first.value
        : decodeStyleEscapes(text.slice(tokens[start + 1]?.end, tokens[end]?.start).trim());
      if (value !== '') result.targets.push({ target: value, offset: first === undefined ? token.start : first.start + (first.string ? 1 : 0), directive, cssImport: true,
        computed: computed(value, first?.string ?? false) || tokens.slice(start + 2, end).some(token => !token.string && ['(', '+'].includes(token.value)) });
      return end + 1;
    }
    // An unquoted expression can contain punctuation, for example pkg:foo or $name.
    let end = start + 1;
    if (!token.string) {
      while (tokens[end] && tokens[end]?.start === tokens[end - 1]?.end && !/^[;{},()]$/.test(tokens[end]?.value ?? '')) end += 1;
    }
    let value = token.string ? token.value : decodeStyleEscapes(text.slice(token.start, tokens[end - 1]?.end));
    if (!token.string && tokens[end]?.value === '(') {
      const close = matching(end);
      if (close < 0) result.unread.push(token.start);
      else {
        value = decodeStyleEscapes(text.slice(token.start, tokens[close]?.end));
        end = close + 1;
      }
    }
    if (tokens[end]?.value === '+') {
      // Concatenation cannot prove a complete static target. Preserve a proven package prefix.
      value += '${expression}';
    }
    result.targets.push({ target: value, offset: token.start + (token.string ? 1 : 0), directive, computed: computed(value, token.string) });
    return end;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.string) continue;
    const value = token.value.toLowerCase();
    if (/^@(import|use|forward|require|plugin|config|reference|source)$/.test(value)) {
      let start = i + 1;
      let importDialect: 'less' | 'css' | undefined;
      if (value === '@source' && ['inline', 'not'].includes(tokens[start]?.value ?? '')) {
        if (tokens[start]?.value === 'not') start += 1;
        if (tokens[start]?.value === 'inline') {
          const end = tokens[start + 1]?.value === '(' ? matching(start + 1) : -1;
          if (end < 0) result.unread.push(token.start);
          else i = end;
          continue;
        }
      }
      if ((value === '@import' || value === '@plugin') && dialect === 'less' && tokens[start]?.value === '(') {
        const end = matching(start);
        if (end < 0) { result.unread.push(token.start); continue; }
        if (value === '@import') {
          const options = tokens.slice(start + 1, end).map(option => option.value.toLowerCase());
          if (options.includes('less')) importDialect = 'less';
          else if (options.includes('css')) importDialect = 'css';
        }
        start = end + 1;
      }
      const firstTarget = result.targets.length;
      let end = targetAt(start, value);
      if (importDialect !== undefined) {
        for (const target of result.targets.slice(firstTarget)) target.dialect = importDialect;
      }
      // Import suffixes (media, layer, supports, Sass with/as) are not targets.
      // Only Sass permits a list of import targets separated by top-level commas.
      if (value === '@import' && (dialect === 'scss' || dialect === 'sass')) {
        while (tokens[end]?.value === ',') end = targetAt(end + 1, value);
      }
      i = Math.max(i, end - 1);
    } else if ((value === 'composes' && tokens[i + 1]?.value === ':') || value === '@value') {
      const from = nextFrom[i + 1] ?? tokens.length;
      if (from < (boundary[i + 1] ?? tokens.length)) {
        if (tokens[from + 1]?.value !== 'global' || tokens[from + 1]?.string) i = targetAt(from + 1, value) - 1;
      }
    } else if (styleFileKind(value, dialect) !== undefined && tokens[i + 1]?.value === '(') {
      const end = matching(i + 1);
      const first = tokens[i + 2];
      if (end < 0 || first === undefined || i + 2 === end) { result.unread.push(token.start); continue; }
      // Only a complete literal first argument proves a filename. Options may
      // contain nested loader calls, so keep walking rather than skipping them.
      const literal = first.string && (i + 3 === end || !tokens[i + 3]?.string && tokens[i + 3]?.value === ',');
      result.targets.push({ target: first.value, offset: first.start + (first.string ? 1 : 0),
        directive: value, computed: !literal });
    } else if (value !== 'url' && assetFunction(value, dialect) && tokens[i + 1]?.value === '(') {
      const end = matching(i + 1);
      if (end < 0) { result.unread.push(token.start); continue; }
      const args: Array<[number, number]> = [];
      let start = i + 2;
      for (let cursor = start; cursor < end; cursor += 1) {
        if (!tokens[cursor]?.string && tokens[cursor]?.value === '(') {
          cursor = matching(cursor);
          if (cursor < 0) break;
        } else if (!tokens[cursor]?.string && tokens[cursor]?.value === ',') {
          args.push([start, cursor]);
          start = cursor + 1;
        }
      }
      args.push([start, end]);
      if (imageSet(value)) {
        for (const [first, last] of args) {
          if (tokens[first]?.string) {
            assetArgument(first, tokens[first + 1]?.value === '+' ? last : first + 1);
          } else if (tokens[first]?.value.toLowerCase() === 'url' && tokens[first + 1]?.value === '(') targetAt(first, 'url');
          else result.unread.push(tokens[first]?.start ?? token.start);
        }
      } else {
        // Less permits an optional MIME type before the path; Stylus puts encoding after it.
        const argument = args[value === 'data-uri' && args.length > 1 ? 1 : 0];
        if (argument !== undefined) assetArgument(...argument);
        if (args.length > 2) result.unread.push(token.start);
      }
      i = end;
    } else if ((value === 'url' || value === 'import' && tokens[i - 1]?.value === ':' || isStyleLoader(value)) && tokens[i + 1]?.value === '(') {
      if (value === 'url') i = targetAt(i, 'url') - 1;
      else i = targetAt(i + 2, value) - 1;
    }
  }
  return result;
}
