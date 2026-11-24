/** Coverage proof for loaders that can select a directory of local modules. */
import * as path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { isExcluded } from '../../core/workspace/scan.js';
import { canonicalPath, isMissingPathError, relatePaths } from '../pathIdentity.js';
import type { CancellationToken, HostPlatform, WorkspaceFolder } from '../platform/hostPlatform.js';
import { readTextFileCapped } from './workspaceFiles.js';

export class LocalImportCoverage {
  private readonly directories = new Set<string>();
  /** Queue proof until the source scan has finished, including followed styles/scripts. */
  readonly request = (directory: string): boolean => { this.directories.add(directory); return true; };

  constructor(
    private readonly platform: HostPlatform,
    private readonly folder: WorkspaceFolder,
    private readonly dir: string,
    private readonly maxFiles: number,
    private readonly token: CancellationToken,
    private readonly scannedPaths: ReadonlySet<string>,
    private readonly recordFile: (file: string) => void = () => {},
  ) {}

  async complete(): Promise<boolean> {
    if (this.directories.size === 0) return true;
    try {
      const root = await canonicalPath(path.resolve(this.folder.path, this.dir));
      const scanned = new Set(await Promise.all([...this.scannedPaths].map(file => canonicalPath(file))));
      const visited = new Set<string>();
      let count = 0;
      const visit = async (directory: string): Promise<boolean> => {
        if (this.token.isCancellationRequested || ++count > this.maxFiles) return false;
        // Missing/excluded prefixes are still inputs to the loader's proof.
        this.recordFile(directory);
        const canonical = await canonicalPath(directory);
        if (relatePaths(root, canonical) === 'outside' ||
            isExcluded(path.relative(root, directory).split(path.sep).join('/') + '/_') ||
            isExcluded(path.relative(root, canonical).split(path.sep).join('/') + '/_')) return false;
        if (visited.has(canonical)) return true;
        visited.add(canonical);
        // Native directory enumeration includes excluded files and symlink entries;
        // discovery globs cannot prove that such potential matches are absent.
        let entries;
        try { entries = await readdir(canonical, { withFileTypes: true }); }
        catch (error) { if (isMissingPathError(error)) return true; throw error; }
        for (const entry of entries) {
          if (this.token.isCancellationRequested || ++count > this.maxFiles) return false;
          const file = path.join(canonical, entry.name);
          if (entry.isDirectory()) {
            if (!await visit(file)) return false;
            continue;
          }
          // A symlink may be a directory; inspect its canonical destination too.
          if (entry.isSymbolicLink()) {
            const target = await canonicalPath(file);
            if (relatePaths(root, target) === 'outside') return false;
            const info = await stat(target);
            if (info.isDirectory()) { if (!await visit(target)) return false; continue; }
          }
          const target = await canonicalPath(file);
          if (relatePaths(root, target) === 'outside' || isExcluded(path.relative(root, target).split(path.sep).join('/'))) return false;
          if (scanned.has(target)) continue;
          // Bulk loaders can select data, which source discovery does not read.
          // Validate JSON explicitly: it cannot execute a hidden package loader.
          if (!/\.json$/i.test(file)) return false;
          this.recordFile(target);
          const text = await readTextFileCapped(this.platform, target);
          if (text === null) return false;
          JSON.parse(text);
        }
        return true;
      };
      for (const directory of this.directories) {
        if (!await visit(path.resolve(this.folder.path, directory))) return false;
      }
      return !this.token.isCancellationRequested;
    } catch { return false; }
  }
}
