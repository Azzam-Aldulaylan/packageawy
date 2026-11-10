/**
 * A `KeyValueStore` that keeps each key in its own JSON file under one
 * directory. Used for bulky caches (registry responses, packuments) that
 * would otherwise bloat the editor's global state, which VS Code loads and
 * saves as a single value.
 *
 * `get` is synchronous, as `KeyValueStore` requires: each file is read once,
 * on first access, and then served from memory. `update` changes the
 * in-memory value at once and writes the file in the background, one write
 * at a time per key, through a temporary file and a rename so a crash never
 * leaves half a file behind. A missing, unreadable, or corrupt file reads as
 * `undefined`. Callers validate what they read anyway.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { KeyValueStore } from '../../core/cache/keyValueStore.js';

const NOT_LOADED = Symbol('not-loaded');

function fileNameFor(key: string): string {
  return `${encodeURIComponent(key)}.json`;
}

export class FileKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  get(key: string): unknown {
    const cached = this.values.has(key) ? this.values.get(key) : NOT_LOADED;
    if (cached !== NOT_LOADED) return cached;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath(key), 'utf8'));
    } catch {
      value = undefined;
    }
    this.values.set(key, value);
    return value;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.write(key, value)).catch(() => undefined);
    this.writes.set(key, next);
    return next;
  }

  private filePath(key: string): string {
    return path.join(this.directory, fileNameFor(key));
  }

  private async write(key: string, value: unknown): Promise<void> {
    const target = this.filePath(key);
    if (value === undefined) {
      await rm(target, { force: true });
      return;
    }
    await mkdir(this.directory, { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), 'utf8');
    await rename(temporary, target);
  }
}

/**
 * Moves `keys` from `from` (the old home, usually global state) to `to`.
 * A value already in `to` wins: it is newer than anything left behind.
 * The old key is cleared either way, so this runs only once in effect.
 */
export async function migrateStoreKeys(
  from: KeyValueStore,
  to: KeyValueStore,
  keys: readonly string[]
): Promise<void> {
  for (const key of keys) {
    const legacy = from.get(key);
    if (legacy === undefined) continue;
    if (to.get(key) === undefined) await to.update(key, legacy);
    await from.update(key, undefined);
  }
}
