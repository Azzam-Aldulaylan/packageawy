import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { assertSafeCanonicalPath } from '../nodeUpgradeTransactionFiles.js';
import { canonicalPath, isMissingPathError, nativeRealpath, relatePaths } from '../pathIdentity.js';
import { isClaim, isOwner, newId, RECOVERY_FOLDER, RECOVERY_MESSAGES, RecoveryError, type RecoveryTarget } from './model.js';

export interface StorageHooks {
  fs?: typeof fs;
  boundary?(name: string): Promise<void>;
  platform?: NodeJS.Platform;
}
export function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** All journal I/O rechecks components, including existing directories and leaves. */
export class Storage {
  readonly fs: typeof fs;
  readonly folder: string;
  publicationFailed = false;
  private canonicalRoot = '';
  constructor(readonly target: RecoveryTarget, readonly hooks: StorageHooks = {}) {
    this.fs = hooks.fs ?? fs;
    this.folder = path.join(target.root, RECOVERY_FOLDER);
  }
  async initialize(): Promise<void> {
    this.canonicalRoot = await canonicalPath(this.target.workspaceRoot);
    try {
      if ((await this.fs.lstat(this.target.workspaceRoot)).isSymbolicLink()) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    } catch (error) { if (!isMissingPathError(error)) throw error; }
    await this.safeAbsolute(this.folder);
    if (relatePaths(await canonicalPath(this.target.root), await canonicalPath(this.folder)) !== 'inside') throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
  }
  async safeAbsolute(candidate: string): Promise<string> {
    await assertSafeCanonicalPath({ path, lstat: (name) => this.fs.lstat(name), realpath: nativeRealpath }, this.canonicalRoot, candidate);
    return candidate;
  }
  async at(relative: string): Promise<string> {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..' || part === '' || part === '.')) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    const candidate = path.join(this.folder, relative);
    if (relatePaths(this.folder, candidate) !== 'inside') throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    await this.safeAbsolute(candidate);
    return candidate;
  }
  async exists(relative: string): Promise<boolean> {
    try { await this.fs.lstat(await this.at(relative)); return true; }
    catch (error) { if (isMissingPathError(error)) return false; throw error; }
  }
  async read(relative: string): Promise<Buffer> {
    const handle = await this.fs.open(await this.at(relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async json(relative: string): Promise<unknown> {
    try { return JSON.parse((await this.read(relative)).toString('utf8')) as unknown; }
    catch (error) { if (isMissingPathError(error) || error instanceof SyntaxError) return undefined; throw error; }
  }
  async list(relative?: string): Promise<string[]> {
    return this.fs.readdir(relative === undefined ? await this.safeAbsolute(this.folder) : await this.at(relative));
  }
  async mkdir(relative: string): Promise<void> { await this.fs.mkdir(await this.at(relative)); }
  async unlink(relative: string): Promise<void> {
    try { await this.fs.unlink(await this.at(relative)); }
    catch (error) { if (!isMissingPathError(error)) throw error; }
  }
  async rmdir(relative: string): Promise<void> {
    try { await this.fs.rmdir(await this.at(relative)); }
    catch (error) { if (!isMissingPathError(error)) throw error; }
  }
  async syncDirectory(candidate = this.folder): Promise<void> {
    // Node cannot fsync directories on Windows (EPERM/EISDIR). POSIX errors
    // still propagate because directory durability is required there.
    if ((this.hooks.platform ?? process.platform) === 'win32') return;
    const same = await canonicalPath(candidate) === this.canonicalRoot;
    if (same && (await this.fs.lstat(candidate)).isSymbolicLink()) throw new RecoveryError(RECOVERY_MESSAGES.unsafe);
    const handle = await this.fs.open(same ? candidate : await this.safeAbsolute(candidate), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async boundary(name: string): Promise<void> { await this.hooks.boundary?.(name); }

  /** No unlink-first or copy fallback: failed publication keeps its previous durable state. */
  async publish(relative: string, data: Uint8Array | string, exclusive = false, guard?: () => Promise<void>, mode = 0o600): Promise<void> {
    try { await this.publishPrepared(relative, data, exclusive, guard, mode); }
    catch (error) { this.publicationFailed = true; throw error; }
  }

  private async publishPrepared(relative: string, data: Uint8Array | string, exclusive: boolean, guard: (() => Promise<void>) | undefined, mode: number): Promise<void> {
    await guard?.();
    const temporary = `${relative}.tmp-${newId()}`;
    const handle = await this.fs.open(await this.at(temporary), 'wx', mode);
    try { await handle.writeFile(data); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    await this.boundary(`synced:${relative}`);
    await guard?.();
    const source = await this.at(temporary);
    const destination = await this.at(relative);
    if (exclusive) {
      try { await this.fs.link(source, destination); }
      catch (error) {
        // Even EEXIST can be an uncertain link result. Only a different,
        // complete publication proves an ordinary competing owner won.
        if (code(error) === 'EEXIST') {
          const existing = await this.read(relative).catch(() => undefined);
          if (existing !== undefined && !existing.equals(Buffer.from(data))) {
            let value: unknown;
            try { value = JSON.parse(existing.toString('utf8')); } catch { value = undefined; }
            if (relative === 'owner.json' ? isOwner(value) : isClaim(value)) throw new RecoveryError(RECOVERY_MESSAGES.blocked);
          }
        }
        throw new RecoveryError(RECOVERY_MESSAGES.unsupported);
      }
      await this.boundary(`linked:${relative}`);
      await this.unlink(temporary);
    } else {
      await this.fs.rename(source, destination);
    }
    await this.syncDirectory(path.dirname(destination));
    await this.boundary(`published:${relative}`);
  }
  async writeJson(relative: string, value: unknown, exclusive = false, guard?: () => Promise<void>): Promise<void> {
    await this.publish(relative, JSON.stringify(value), exclusive, guard);
  }
}
