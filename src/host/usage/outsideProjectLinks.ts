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
 * - No project file, config file or manifest names that folder, in any letter
 *   case. Imports, aliases, absolute paths and scripts that reach it all have to
 *   name it. Exclude and ignore lists in config files do not count.
 *
 * If the second rule fails, the analyzer reports a coverage reason, which keeps
 * removals blocked.
 */
import * as path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { scanSourceForStaticSpecifiers } from '../../core/usage/importScan.js';
import type { ScriptLanguage } from '../../core/usage/importScan.js';
import { canonicalPath, relatePaths } from '../pathIdentity.js';

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
const EXCLUDE_LIST = /["']?\b(?:exclude|ignores|ignorePatterns|watchPathIgnorePatterns|testPathIgnorePatterns)\b["']?\s*:\s*\[\s*(?:(?:"[^"\\\r\n]*"|'[^'\\\r\n]*')\s*(?:,\s*)?)*\]/gi;

export class OutsideProjectLinks {
  private readonly links: string[] = [];
  /** Lower-case AI tool folder names on the way to each excluded link. */
  private readonly names = new Set<string>();
  private mentioned = false;

  constructor(
    private readonly projectRoot: string,
    private readonly canonicalProject: string | null
  ) {}

  /**
   * Find links at or inside an AI tool folder that lead outside the project.
   * Paths are checked one depth at a time, so a link hides its descendants.
   */
  async prepare(files: readonly string[], isCancelled: () => boolean = () => false): Promise<void> {
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
          const name = candidates.get(candidate);
          if (name !== undefined) this.names.add(name);
        }
      }
    }
    if (this.links.length === 0) return;
    for (const name of EXTRA_ALIAS_FILES) {
      const text = await readFile(path.join(this.projectRoot, name), 'utf8').catch(() => null);
      if (text !== null) this.checkText(text);
    }
  }

  /** True when the file is reached through one of those links. */
  covers(absolutePath: string): boolean {
    return this.links.some((link) => absolutePath === link || absolutePath.startsWith(`${link}${path.sep}`));
  }

  /** Record whether project text names one of the linked tool folders, outside exclude lists. */
  checkText(text: string): void {
    if (this.mentioned || this.names.size === 0) return;
    const lower = text.replace(EXCLUDE_LIST, '').toLowerCase();
    for (const name of this.names) {
      if (lower.includes(name)) {
        this.mentioned = true;
        return;
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
