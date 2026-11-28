import { DEPENDENCY_CALL } from './importScan.js';
import type { ScriptLanguage } from './importScan.js';
import { scanStylesheet, styleDialect } from './styleScan.js';
import type { StyleDialect } from './styleScan.js';

/** Extract executable blocks before JS string masking can consume markup prose. */
export interface SourceCoverage {
  scripts: Array<{ text: string; language?: ScriptLanguage }>;
  localScripts: string[];
  styles: Array<{ text: string; dialect: StyleDialect; src?: string; offset: number }>;
  reasons: string[];
}

export const STYLESHEET_EXTENSION = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

function attributeDetails(attributes: string, name: string): { value: string; offset: number } | undefined {
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1]?.toLowerCase() !== name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const quote = match[2] !== undefined || match[3] !== undefined ? 1 : 0;
    return { value, offset: match.index + match[0].length - value.length - quote };
  }
  return undefined;
}

function attribute(attributes: string, name: string): string | undefined {
  return attributeDetails(attributes, name)?.value;
}

function staticScriptAttributes(attributes: string): boolean {
  const pattern = /\s+([^\s"'`=<>/{}]+)(?:\s*=\s*(?:"[^"{]*"|'[^'{]*'|[^\s"'`=<>{}]+))?/gy;
  let offset = 0;
  while (!/^\s*\/?\s*$/.test(attributes.slice(offset))) {
    pattern.lastIndex = offset;
    const match = pattern.exec(attributes);
    if (match === null || /^(?:[:@#]|v-)/i.test(match[1] ?? '')) return false;
    offset = pattern.lastIndex;
  }
  return true;
}

function jsonScriptType(attributes: string): boolean {
  const type = attribute(attributes, 'type');
  return type !== undefined && /^application\/(?:json|[!#$%&'*+.^_`|~\da-z-]+\+json)$/i.test(type);
}

function inertJsonScript(attributes: string): boolean {
  return jsonScriptType(attributes) && attribute(attributes, 'lang') === undefined && attribute(attributes, 'src') === undefined &&
    staticScriptAttributes(attributes);
}

function validJsonBody(body: string): boolean {
  // Only text that can start or end a script block or open a comment is a risk. Other HTML in strings is fine.
  if (/<\/?script|<!--/i.test(body)) return false;
  if (body.trim() === '') return true;
  try {
    JSON.parse(body.trim());
    return true;
  } catch {
    return false;
  }
}

function scriptLanguage(attributes: string): ScriptLanguage | undefined {
  const lang = attribute(attributes, 'lang')?.toLowerCase();
  const type = attribute(attributes, 'type')?.toLowerCase();
  if ((lang !== undefined && !/^(?:js|jsx|ts|tsx|javascript|typescript)$/.test(lang)) ||
      (type !== undefined && !/^(?:module|text\/(?:javascript|typescript)|application\/(?:javascript|typescript))$/.test(type))) return undefined;
  if (lang === 'typescript' || lang === 'ts') return 'ts';
  if (lang === 'jsx' || lang === 'tsx') return lang;
  if (lang === undefined && type?.endsWith('/typescript')) return 'ts';
  return 'js';
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

export function extractSourceCoverage(filePath: string, text: string, stylesHandled = false): SourceCoverage {
  if (!/\.(vue|svelte|astro)$/i.test(filePath)) return { scripts: [{ text }], localScripts: [], styles: [], reasons: [] };
  const scripts: SourceCoverage['scripts'] = [];
  const localScripts: string[] = [];
  const styles: SourceCoverage['styles'] = [];
  const reasons = new Set<string>();
  const markup = text.split('');
  const hide = (start: number, end: number): void => {
    for (let i = start; i < end; i += 1) markup[i] = /[\r\n]/.test(text[i] ?? '') ? text[i] ?? '' : ' ';
  };
  const addScript = (start: number, end: number, language: ScriptLanguage): void => {
    // Padding retains the original coordinates while isolating each block's lexical state.
    scripts.push({ text: blank(text.slice(0, start)) + text.slice(start, end), language });
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
        addScript(opening[0].length, end.index, 'ts');
        offset = end.index + end[0].length;
        hide(0, offset);
      }
    }
  }

  // Read HTML tags on the original text. Quotes in ordinary prose have no lexical meaning here.
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  tags.lastIndex = offset;
  let markupOffset = offset;
  let braceDepth = 0;
  let negativeBraceDepth = false;
  let exemptedJson = false;
  let quote: string | undefined;
  // Braces inside expression strings and comments do not change the depth. Quotes in plain markup are prose.
  const countBraces = (until: number): void => {
    for (; markupOffset < until; markupOffset += 1) {
      const char = markup[markupOffset];
      const next = markup[markupOffset + 1];
      if (quote === '//') {
        if (char === '\n' || char === '\r') quote = undefined;
      } else if (quote === '/*') {
        if (char === '*' && next === '/') {
          quote = undefined;
          markupOffset += 1;
        }
      } else if (quote !== undefined) {
        if (char === '\\') markupOffset += 1;
        else if (char === quote) quote = undefined;
      } else if (braceDepth > 0 && char === '/' && (next === '/' || next === '*')) {
        quote = `/${next}`;
        markupOffset += 1;
      } else if (braceDepth > 0 && (char === '"' || char === "'" || char === '`')) quote = char;
      else if (char === '{') braceDepth += 1;
      else if (char === '}') {
        braceDepth -= 1;
        if (braceDepth < 0) negativeBraceDepth = true;
      }
    }
  };
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(text)) !== null) {
    // Hidden blocks do not contribute template expression braces.
    countBraces(tag.index);
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
    const jsonScript = kind === 'script' && jsonScriptType(attributes);
    const attributeCalls = jsonScript && new RegExp(DEPENDENCY_CALL).test(attributes);
    const inertJson = kind === 'script' && braceDepth === 0 && quote === undefined && !negativeBraceDepth &&
      inertJsonScript(attributes) && !attributeCalls;
    if (attributeCalls) {
      reasons.add('script blocks with unsupported languages or types');
      reasons.add('import() calls in component markup');
    }
    // Only inert JSON tags can use Astro's self-closing form.
    if (inertJson && /\.astro$/i.test(filePath) && /\/\s*>$/.test(tag[0])) {
      exemptedJson = true;
      hide(tag.index, tags.lastIndex);
      continue;
    }
    const bodyStart = tags.lastIndex;
    const closing = new RegExp(`</${kind}\\s*>`, 'gi');
    closing.lastIndex = bodyStart;
    const end = closing.exec(text);
    if (end === null) {
      reasons.add('component blocks that could not be extracted');
      break;
    }
    const body = text.slice(bodyStart, end.index);
    const language = scriptLanguage(attributes);
    if (kind === 'style') {
      const lang = attribute(attributes, 'lang') ?? 'css';
      const dialect = styleDialect(lang);
      const src = attribute(attributes, 'src');
      if (dialect === undefined) reasons.add(`style blocks in ${filePath} with an unsupported language`);
      else {
        const padded = blank(text.slice(0, bodyStart)) + body;
        styles.push({ text: padded, dialect, offset: tag.index + kind.length + 1 + (attributeDetails(attributes, 'src')?.offset ?? 0), ...(src === undefined ? {} : { src }) });
        const scan = stylesHandled ? undefined : scanStylesheet(body, dialect);
        // Compatibility and any future consumers must opt in only after reading these targets.
        if (!stylesHandled && (src !== undefined || (scan?.targets.length ?? 0) > 0 || (scan?.unread.length ?? 0) > 0)) {
          reasons.add(`style dependencies in ${filePath} that were not read`);
        }
      }
    } else if (language === undefined) {
      const bodyCalls = jsonScript && new RegExp(DEPENDENCY_CALL).test(body);
      if (!inertJson || !validJsonBody(body) || bodyCalls) reasons.add('script blocks with unsupported languages or types');
      else exemptedJson = true;
      if (bodyCalls) reasons.add('import() calls in component markup');
    } else {
      const src = attribute(attributes, 'src');
      if (src !== undefined) localScripts.push(src);
      addScript(bodyStart, end.index, language);
    }
    hide(tag.index, closing.lastIndex);
    tags.lastIndex = closing.lastIndex;
  }
  // A string brace can make a fake tag look top-level. Exemptions need balanced braces in the whole file.
  countBraces(markup.length);
  if (exemptedJson && (braceDepth !== 0 || quote !== undefined || negativeBraceDepth)) reasons.add('script blocks with unsupported languages or types');
  const outside = markup.join('');
  if (/<\/?(?:script|style)\b/i.test(outside)) reasons.add('component blocks that could not be extracted');
  if (new RegExp(DEPENDENCY_CALL).test(outside)) reasons.add('import() calls in component markup');
  return { scripts, localScripts, styles, reasons: [...reasons] };
}

export const SOURCE_IMPORT_COVERAGE_REASON = "Automatic removals are unavailable because Packageawy could not fully check this project's source code for package imports.";

export function coverageExplanation(reasons: readonly string[]): string {
  const details = reasons.filter(reason => reason !== SOURCE_IMPORT_COVERAGE_REASON);
  return details.length === 0 ? SOURCE_IMPORT_COVERAGE_REASON
    : `${SOURCE_IMPORT_COVERAGE_REASON} Coverage is incomplete for ${details.join(', ')}.`;
}
