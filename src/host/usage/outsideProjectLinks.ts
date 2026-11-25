/**
 * Linked AI tool folders that lead outside the project.
 *
 * Editor file search follows symlinks, so a project can list files whose real
 * location is another folder entirely, for example a `.claude` or `.agents`
 * folder linked in from a separate tool workspace. The analyzer never reads
 * files outside the project. Counting each one as an unreadable project file
 * would hold back every removal, so such files are left out, but only when:
 *
 * - The link is one of a fixed set of AI coding tool folders, or sits inside
 *   one. No build tool, framework or config loader reads these by convention.
 *   Any other link that leads outside the project stays unreadable and keeps
 *   removals blocked, exactly as before.
 * - No project file, config file or manifest names that folder or the place it
 *   leads to, in any letter case and after escapes are decoded. Imports,
 *   aliases, absolute paths and scripts that reach it all have to name one of
 *   them. JSON configs are parsed, and TypeScript configs are followed through
 *   `extends`, including config packages. Exclude and ignore lists in config
 *   files do not count.
 *
 * If the second rule fails, the analyzer reports a coverage reason, which keeps
 * removals blocked.
 */
import * as path from 'node:path';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { scanSourceForStaticSpecifiers } from '../../core/usage/importScan.js';
import type { ScriptLanguage } from '../../core/usage/importScan.js';
import { canonicalPath, relatePaths } from '../pathIdentity.js';
import { jsonStrings, parseJsonc } from './jsonc.js';

export const OUTSIDE_LINK_REFERENCE_REASON = 'linked AI tool folders outside the project that the project refers to';

/** Folders that hold AI coding tool settings, never application or build code. */
export const AI_TOOL_FOLDERS: ReadonlySet<string> = new Set([
  '.agents', '.aider', '.claude', '.claude-flow', '.codex', '.continue', '.cursor', '.gemini',
  '.hive-mind', '.junie', '.kiro', '.opencode', '.roo', '.serena', '.swarm', '.windsurf',
]);

const LSTAT_BATCH = 64;
/** Project files that can alias paths but are not part of usage discovery. */
const EXTRA_ALIAS_FILES = ['jsconfig.json'];
/**
 * Config entries that only exclude paths, such as tsconfig `exclude` or ESLint
 * `ignores`. Only lists of plain string literals qualify, so a list that runs
 * code, such as a spread of `require(...)`, is still checked.
 */
const EXCLUDE_LIST = /["']?\b(?:exclude|ignores|ignorePatterns|watchPathIgnorePatterns|testPathIgnorePatterns)\b["']?\s*:\s*\[\s*(?:(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')\s*(?:,\s*)?)*\]/gi;
/** The same entries at the top of a parsed JSON config. */
const EXCLUDE_KEYS = new Set(['exclude', 'ignores', 'ignorePatterns', 'watchPathIgnorePatterns', 'testPathIgnorePatterns']);
/** Objects whose keys are import names, so a key called `exclude` there is an alias. */
const ALIAS_MAP_KEY = /["']?\b(?:paths|alias|aliases|fallback|moduleNameMapper|imports|exports)\b["']?\s*:\s*$/i;
/** JavaScript, JSON and URL escapes that can spell a folder name. */
const ESCAPE = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|%([0-9a-fA-F]{2})|\\([^\r\n])/g;
const TS_CONFIG = /^[jt]sconfig.*\.json$/i;
const JSON_FILE = /\.json[c5]?$/i;
const MAX_EXTENDS = 512;
/** JSON files read from one config package before it counts as a reference. */
const MAX_PACKAGE_FILES = 200;

function stripExcludeLists(text: string): string {
  return text.replace(EXCLUDE_LIST, (match: string, offset: number) => (insideAliasMap(text, offset) ? match : ''));
}

/** True when the nearest object around `offset` is the value of an alias map key. */
function insideAliasMap(text: string, offset: number): boolean {
  let depth = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '}') depth += 1;
    else if (char === '{') {
      if (depth === 0) {
        const before = decodeEscapes(text.slice(Math.max(0, index - 400), index).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' '));
        return ALIAS_MAP_KEY.test(before);
      }
      depth -= 1;
    }
  }
  return false;
}

function decodeEscapes(text: string): string {
  return text.replace(ESCAPE, (match: string, braced?: string, unicode?: string, hex?: string, percent?: string, escaped?: string) => {
    if (escaped !== undefined) return escaped;
    const code = Number.parseInt(braced ?? unicode ?? hex ?? percent ?? '', 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const slashes = (value: string): string => value.replace(/\\/g, '/').toLowerCase();

export class OutsideProjectLinks {
  private readonly links: string[] = [];
  /** Lower-case AI tool folder names on the way to each excluded link, and where the links lead. */
  private readonly names = new Set<string>();
  private mentioned = false;

  constructor(
    private readonly projectRoot: string,
    private readonly canonicalProject: string | null,
    /** Files and folders this check read, so changing them invalidates the result. */
    private readonly recordFile: (file: string) => void = () => {}
  ) {}

  /**
   * Find links at or inside an AI tool folder that lead outside the project.
   * Paths are checked one depth at a time, so a link hides its descendants.
   */
  async prepare(
    files: readonly string[],
    isCancelled: () => boolean = () => false,
    findConfigs: () => Promise<readonly string[]> = async () => []
  ): Promise<void> {
    if (this.canonicalProject === null) return;
    const candidates = new Map<string, string>();
    for (const file of files) {
      const relative = path.relative(this.projectRoot, file);
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      let prefix = this.projectRoot;
      let toolFolder: string | undefined;
      for (const segment of relative.split(path.sep)) {
        prefix = path.join(prefix, segment);
        if (toolFolder === undefined && AI_TOOL_FOLDERS.has(segment.toLowerCase())) toolFolder = segment.toLowerCase();
        if (toolFolder !== undefined && !candidates.has(prefix)) candidates.set(prefix, toolFolder);
      }
    }
    const byDepth = new Map<number, string[]>();
    for (const candidate of candidates.keys()) {
      const depth = candidate.split(path.sep).length;
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), candidate]);
    }
    for (const depth of [...byDepth.keys()].sort((left, right) => left - right)) {
      const level = (byDepth.get(depth) ?? []).filter((candidate) => !this.covers(candidate));
      for (let offset = 0; offset < level.length; offset += LSTAT_BATCH) {
        if (isCancelled()) return;
        const batch = level.slice(offset, offset + LSTAT_BATCH);
        const flags = await Promise.all(batch.map((candidate) =>
          lstat(candidate).then((info) => info.isSymbolicLink(), () => false)));
        for (const [index, candidate] of batch.entries()) {
          if (flags[index] !== true) continue;
          let target: string;
          try {
            target = await canonicalPath(candidate);
          } catch {
            continue; // A broken link stays an ordinary unreadable file.
          }
          if (relatePaths(this.canonicalProject, target) !== 'outside') continue;
          this.links.push(candidate);
          this.recordFile(candidate);
          const name = candidates.get(candidate);
          if (name !== undefined) this.names.add(name);
          await this.addDestination(candidate, target);
        }
      }
    }
    if (this.links.length === 0) return;
    const configs = [
      ...EXTRA_ALIAS_FILES.map((name) => path.join(this.projectRoot, name)),
      ...[...files, ...await findConfigs()].filter((file) => TS_CONFIG.test(path.basename(file)) && !this.covers(file)),
    ];
    await this.followConfigs(configs, isCancelled);
  }

  /** Code can also reach the files through the place the link leads to. */
  private async addDestination(link: string, target: string): Promise<void> {
    const written = await readlink(link).then((value) => path.resolve(path.dirname(link), value), () => target);
    for (const destination of new Set([target, written])) {
      this.names.add(slashes(destination));
      const relative = slashes(path.relative(this.projectRoot, destination)).replace(/^(?:\.\.\/)+/, '');
      if (relative !== '' && !path.isAbsolute(relative)) this.names.add(`../${relative}`);
    }
  }

  /** Check TypeScript and JavaScript configs and every config they extend. */
  private async followConfigs(configs: readonly string[], isCancelled: () => boolean): Promise<void> {
    const queue = [...configs];
    const seen = new Set<string>();
    let extended = 0;
    while (queue.length > 0 && !this.mentioned && !isCancelled()) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      this.recordFile(file);
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) continue;
      const parsed = this.checkJson(text);
      if (parsed === undefined) {
        // An unreadable config could extend one that names the folder.
        if (/extends/i.test(text)) this.mentioned = true;
        continue;
      }
      const value = isRecord(parsed) ? parsed['extends'] : undefined;
      const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      for (const extension of values) {
        // A chain too long to follow could hide an alias, so it counts as a reference.
        if (++extended > MAX_EXTENDS) {
          this.mentioned = true;
          return;
        }
        queue.push(...await this.extendedConfigPaths(file, extension));
      }
    }
  }

  /**
   * Files an `extends` value can load. For a config package, every JSON file in
   * it, so its `tsconfig` and `exports` entries need no exact resolution.
   */
  private async extendedConfigPaths(from: string, value: string): Promise<string[]> {
    if (value === '') return [];
    if (value.startsWith('.') || path.isAbsolute(value)) {
      const base = path.resolve(path.dirname(from), value);
      return [base, `${base}.json`, path.join(base, 'tsconfig.json')];
    }
    const segments = value.split('/');
    const name = segments.slice(0, value.startsWith('@') ? 2 : 1).join('/');
    // Node looks beside the real file too, as in a pnpm store.
    const real = await realpath(from).catch(() => from);
    const found: string[] = [];
    for (const start of new Set([path.dirname(from), path.dirname(real)])) {
      for (let directory = start; ; directory = path.dirname(directory)) {
        // The exact file may be created later, so its path is watched too.
        const exact = path.join(directory, 'node_modules', value);
        for (const candidate of [exact, `${exact}.json`, path.join(exact, 'tsconfig.json')]) this.recordFile(candidate);
        // A nearer copy may lack the requested file, so every copy up the tree is read.
        const files = await this.packageJsonFiles(path.join(directory, 'node_modules', name));
        if (files !== null) found.push(...files);
        if (path.dirname(directory) === directory) break;
      }
    }
    return found;
  }

  private async packageJsonFiles(packageDir: string): Promise<string[] | null> {
    const found: string[] = [];
    const visit = async (directory: string): Promise<boolean> => {
      this.recordFile(directory);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
      if (entries === null) return directory !== packageDir;
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && !await visit(file)) return false;
        } else if (JSON_FILE.test(entry.name)) {
          found.push(file);
          if (found.length > MAX_PACKAGE_FILES) return false;
        }
      }
      return true;
    };
    if (!await visit(packageDir)) {
      if (found.length > MAX_PACKAGE_FILES) this.mentioned = true;
      return found.length > MAX_PACKAGE_FILES ? [] : null;
    }
    return found;
  }

  /** True when the file is reached through one of those links. */
  covers(absolutePath: string): boolean {
    return this.links.some((link) => absolutePath === link || absolutePath.startsWith(`${link}${path.sep}`));
  }

  /** Check a project file, reading JSON files as parsed values. */
  checkFile(text: string, filePath: string): void {
    if (JSON_FILE.test(filePath)) this.checkJson(text);
    else this.checkText(text);
  }

  /** Check every key and string in a JSON config except its exclude lists. Returns the parsed value. */
  private checkJson(text: string): unknown {
    if (this.names.size === 0) return undefined;
    const parsed = parseJsonc(text);
    if (parsed === undefined) {
      this.checkVariants(text);
      return undefined;
    }
    const kept = isRecord(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
        !(EXCLUDE_KEYS.has(key) && Array.isArray(value) && value.every((item) => typeof item === 'string'))))
      : parsed;
    this.checkVariants(jsonStrings(kept).join('\n'));
    return parsed;
  }

  /** Record whether project text names one of the linked tool folders, outside exclude lists. */
  checkText(text: string): void {
    this.checkVariants(stripExcludeLists(text));
  }

  private checkVariants(kept: string): void {
    if (this.mentioned || this.names.size === 0) return;
    const variants = [kept.toLowerCase()];
    if (kept.includes('\\') || kept.includes('%')) {
      const decoded = decodeEscapes(kept);
      // Windows paths can be written with escaped backslashes.
      variants.push(decoded.toLowerCase(), slashes(decoded), slashes(kept).replace(/\/{2,}/g, '/'));
    }
    for (const variant of variants) {
      for (const name of this.names) {
        if (variant.includes(name)) {
          this.mentioned = true;
          return;
        }
      }
    }
  }

  /** Same check on decoded import specifiers, which can spell a name with escapes. */
  checkScript(text: string, filePath: string, language?: ScriptLanguage): void {
    this.checkText(text);
    if (this.mentioned || this.names.size === 0 || !text.includes('\\')) return;
    for (const specifier of scanSourceForStaticSpecifiers(text, filePath, language)) this.checkText(specifier);
  }

  get referenced(): boolean {
    return this.mentioned;
  }
}
