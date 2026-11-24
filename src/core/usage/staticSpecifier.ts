/** Shared bounded literal decoding for ordinary and bulk imports. */
export const QUOTED = "(['\"`])((?:\\\\(?:\\r\\n|[\\s\\S])|(?!\\1)[^\\\\])*)\\1";

/** Decode only specified JS escapes; legacy numeric escapes stay uncertain. */
function decodeSpecifier(raw: string, template: boolean): string | undefined {
  let value = '';
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
  for (let index = 0; index < raw.length; index += 1) {
    let character = raw[index] ?? '';
    if (character !== '\\') {
      if (template && character === '\r') {
        if (raw[index + 1] === '\n') index += 1;
        character = '\n';
      }
      value += character;
      continue;
    }
    const escape = raw[++index];
    if (escape === undefined) return undefined;
    if (escape === '\r') {
      if (raw[index + 1] === '\n') index += 1;
    } else if (/[\n\u2028\u2029]/.test(escape)) {
      // A line continuation contributes no characters.
    } else if (escape === 'x' || escape === 'u') {
      const braced = escape === 'u' && raw[index + 1] === '{';
      const tail = raw.slice(index + 1);
      const hex = (braced ? /^\{([\da-fA-F]+)\}/ : escape === 'x' ? /^([\da-fA-F]{2})/ : /^([\da-fA-F]{4})/).exec(tail);
      if (hex === null) return undefined;
      const point = Number.parseInt(hex[1] ?? '', 16);
      if (point > 0x10ffff) return undefined;
      value += String.fromCodePoint(point);
      index += hex[0].length;
    } else if (escape === '0' && !/[0-9]/.test(raw[index + 1] ?? '')) value += '\0';
    else if (/[0-9]/.test(escape)) return undefined;
    else value += escapes[escape] ?? escape;
  }
  return value;
}

export function staticSpecifier(match: RegExpExecArray): string | undefined {
  const raw = match[2] ?? '';
  if (match[1] === '`' && hasUnescapedTemplateInterpolation(raw)) return undefined;
  return decodeSpecifier(raw, match[1] === '`');
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
