/** Reads JSON with comments and trailing commas, as TypeScript and VS Code configs allow. */
export function parseJsonc(text: string): unknown {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      index += 1;
      output += text.slice(start, index);
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      output += ' ';
    } else {
      output += char;
      index += 1;
    }
  }
  try {
    return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

/** Every key and string value in a parsed JSON value. */
export function jsonStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      jsonStrings(item, into);
    }
  }
  return into;
}
