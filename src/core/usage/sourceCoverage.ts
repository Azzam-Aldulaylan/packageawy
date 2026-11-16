import { DEPENDENCY_CALL } from './importScan.js';

/** Extract executable blocks before JS string masking can consume markup prose. */
export interface SourceCoverage {
  scripts: string[];
  localScripts: string[];
  reasons: string[];
}

export const STYLE_DEPENDENCY_DIRECTIVE = /@(?:import|use|plugin)\b/i;
export const STYLESHEET_EXTENSION = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

function attribute(attributes: string, name: string): string | undefined {
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1]?.toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return undefined;
}

function supportedScript(attributes: string): boolean {
  const lang = attribute(attributes, 'lang')?.toLowerCase();
  const type = attribute(attributes, 'type')?.toLowerCase();
  return (lang === undefined || /^(?:js|jsx|ts|tsx|javascript|typescript)$/.test(lang)) &&
    (type === undefined || /^(?:module|text\/(?:javascript|typescript)|application\/(?:javascript|typescript))$/.test(type));
}

/** A fence inside JS literal/comment text belongs to the script, not Astro markup. */
function frontmatterEnd(text: string, start: number): number | null {
  const stack: Array<{ kind: 'code' | 'template' | 'expression'; depth: number }> = [{ kind: 'code', depth: 0 }];
  let index = start;
  while (index < text.length) {
    const frame = stack[stack.length - 1];
    const character = text[index];
    const next = text[index + 1];
    if (frame?.kind === 'code' && (index === start || text[index - 1] === '\n') &&
        /^---[^\S\r\n]*(?:\r?\n|$)/.test(text.slice(index))) return index;
    if (frame?.kind === 'template') {
      if (character === '\\') index += 1;
      else if (character === '`') stack.pop();
      else if (character === '$' && next === '{') {
        stack.push({ kind: 'expression', depth: 1 });
        index += 1;
      }
    } else if (character === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    } else if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return null;
      index = end + 2;
      continue;
    } else if (character === '/') {
      // Without parsing expressions, division and regex literals are ambiguous.
      return null;
    } else if (character === '"' || character === "'") {
      const quote = character;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\') {
          index += text[index + 1] === '\r' && text[index + 2] === '\n' ? 3 : 2;
        } else if (text[index] === '\n' || text[index] === '\r') return null;
        else index += 1;
      }
      if (index >= text.length) return null;
    } else if (character === '`') stack.push({ kind: 'template', depth: 0 });
    else if (frame?.kind === 'expression') {
      if (character === '{') frame.depth += 1;
      else if (character === '}' && --frame.depth === 0) stack.pop();
    }
    index += 1;
  }
  return null;
}

export function extractSourceCoverage(filePath: string, text: string): SourceCoverage {
  if (!/\.(vue|svelte|astro)$/i.test(filePath)) return { scripts: [text], localScripts: [], reasons: [] };
  const scripts: string[] = [];
  const localScripts: string[] = [];
  const reasons = new Set<string>();
  const markup = text.split('');
  const hide = (start: number, end: number): void => {
    for (let i = start; i < end; i += 1) markup[i] = /[\r\n]/.test(text[i] ?? '') ? text[i] ?? '' : ' ';
  };
  const addScript = (start: number, end: number): void => {
    // Padding retains the original coordinates while isolating each block's lexical state.
    scripts.push(blank(text.slice(0, start)) + text.slice(start, end));
  };

  let offset = 0;
  if (/\.astro$/i.test(filePath)) {
    const opening = /^(?:\uFEFF)?---[^\S\r\n]*(?:\r?\n|$)/.exec(text);
    if (opening !== null) {
      const closing = /^---[^\S\r\n]*(?:\r?$)/gm;
      const endIndex = frontmatterEnd(text, opening[0].length);
      closing.lastIndex = endIndex ?? text.length;
      const end = endIndex === null ? null : closing.exec(text);
      if (end === null) {
        reasons.add('Astro frontmatter that could not be extracted');
        hide(0, text.length);
        offset = text.length;
      } else {
        addScript(opening[0].length, end.index);
        offset = end.index + end[0].length;
        hide(0, offset);
      }
    }
  }

  // Read HTML tags on the original text. Quotes in ordinary prose have no lexical meaning here.
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  tags.lastIndex = offset;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(text)) !== null) {
    if (tag[0].startsWith('<!--')) {
      hide(tag.index, tags.lastIndex);
      continue;
    }
    const block = /^<(\/?)(script|style)\b([\s\S]*?)>$/i.exec(tag[0]);
    if (block === null) continue;
    if (block[1] === '/') {
      reasons.add('component blocks that could not be extracted');
      continue;
    }
    const kind = block[2]?.toLowerCase() ?? '';
    const attributes = block[3] ?? '';
    const bodyStart = tags.lastIndex;
    const closing = new RegExp(`</${kind}\\s*>`, 'gi');
    closing.lastIndex = bodyStart;
    const end = closing.exec(text);
    if (end === null) {
      reasons.add('component blocks that could not be extracted');
      break;
    }
    const body = text.slice(bodyStart, end.index);
    if (kind === 'style') {
      if (STYLE_DEPENDENCY_DIRECTIVE.test(body)) reasons.add('style blocks with @import, @use or @plugin');
    } else if (!supportedScript(attributes)) {
      reasons.add('script blocks with unsupported languages or types');
    } else {
      const src = attribute(attributes, 'src');
      if (src !== undefined) localScripts.push(src);
      addScript(bodyStart, end.index);
    }
    hide(tag.index, closing.lastIndex);
    tags.lastIndex = closing.lastIndex;
  }
  const outside = markup.join('');
  if (/<\/?(?:script|style)\b/i.test(outside)) reasons.add('component blocks that could not be extracted');
  if (new RegExp(DEPENDENCY_CALL).test(outside)) reasons.add('import() calls in component markup');
  return { scripts, localScripts, reasons: [...reasons] };
}

export function coverageExplanation(reasons: readonly string[]): string {
  return `Removals are not recommended automatically here because this project has ${reasons.join('; ')}, which are not read yet.`;
}
