import path from 'node:path';
import { lstat, opendir } from 'node:fs/promises';
import { DEFAULT_EXCLUDED_DIRS } from '../../core/workspace/scan.js';
import type { HostPlatform, WorkspaceFolder } from '../platform/hostPlatform.js';
import { resolveMutationTarget } from '../mutationTarget.js';
import { canonicalPath, isMissingPathError, relatePaths } from '../pathIdentity.js';
import { isOwner, RECOVERY_FOLDER, type RecoveryTarget } from './model.js';
import { Storage, code } from './storage.js';

/** A journal is discoverable even when an interrupted restore moved package.json aside. */
export async function targetFromRecoveryFolder(folder: WorkspaceFolder, root: string, platform: HostPlatform): Promise<RecoveryTarget | undefined> {
  const canonicalFolder = await canonicalPath(folder.path);
  if (relatePaths(canonicalFolder, await canonicalPath(root)) === 'outside') return undefined;
  const provisional: RecoveryTarget = { workspaceRoot: folder.path, root, identity: '', allowlistedPaths: [path.join(root, 'package.json')], operation: 'upgrade', hostKind: platform.hostKind ?? 'vscode' };
  const storage = new Storage(provisional);
  await storage.initialize();
  try { await lstat(storage.folder); }
  catch (error) { if (isMissingPathError(error)) return undefined; throw error; }
  const owner = await storage.json('owner.json');
  let packageManager: 'npm' | 'pnpm' = 'npm';
  let importer = '.';
  let recordedLockfile: string | undefined;
  if (isOwner(owner)) {
    let identity: unknown;
    try { identity = JSON.parse(owner.targetIdentity); } catch { return undefined; }
    if (!Array.isArray(identity) || identity.length !== 5 || identity[0] !== 'target' ||
        (identity[1] !== 'npm' && identity[1] !== 'pnpm') || typeof identity[4] !== 'string') return undefined;
    packageManager = identity[1]; importer = identity[4];
    if (typeof identity[2] !== 'string' || typeof identity[3] !== 'string') return undefined;
    const name = path.basename(identity[3]);
    if (!(packageManager === 'pnpm' ? ['pnpm-lock.yaml'] : ['package-lock.json', 'npm-shrinkwrap.json']).includes(name)) return undefined;
    recordedLockfile = path.join(root, name);
    const canonicalRoot = await canonicalPath(root);
    if (owner.targetIdentity !== JSON.stringify(['target', packageManager, canonicalRoot, await canonicalPath(recordedLockfile), importer])) return undefined;
    if (importer !== '.' && (path.isAbsolute(importer) || importer.includes('\\') || importer.split('/').some(segment => segment === '..' || segment === '.' || segment === ''))) return undefined;
  }
  const projectDir = path.join(root, importer);
  if (recordedLockfile !== undefined) {
    // Recovery starts no package manager. Even an unreadable staged manifest
    // must remain recoverable, using only fixed dependency filenames and
    // independently authorized paths under the recorded mutation root.
    await storage.safeAbsolute(path.join(projectDir, 'package.json'));
    await storage.safeAbsolute(recordedLockfile);
    return { ...provisional, identity: isOwner(owner) ? owner.targetIdentity : '', allowlistedPaths: [path.join(projectDir, 'package.json'), recordedLockfile] };
  }
  const resolution = await resolveMutationTarget({ projectDir, folderPath: folder.path, packageManager });
  if (!resolution.ok || await canonicalPath(resolution.target.root) !== await canonicalPath(root)) return undefined;
  return { ...provisional, identity: resolution.identity, allowlistedPaths: [path.join(projectDir, 'package.json'), resolution.target.lockfilePath] };
}

/** Scan directories, so even an empty folder or a displaced manifest is reachable. */
export async function findRecoveryTargets(platform: HostPlatform): Promise<RecoveryTarget[]> {
  const targets = new Map<string, RecoveryTarget>();
  if (typeof platform.workspaceFolders !== 'function') return [];
  // Stop at fixed work limits rather than walking dependencies or build output.
  let entriesLeft = 100000;
  let directoriesLeft = 10000;
  for (const folder of platform.workspaceFolders()) {
    if (directoriesLeft <= 0 || entriesLeft <= 0 || targets.size >= 1000) break;
    const direct = await targetFromRecoveryFolder(folder, folder.path, platform);
    if (direct !== undefined) targets.set(direct.root, direct);
    const queue = [{ root: folder.path, depth: 0 }];
    for (let index = 0; index < queue.length && directoriesLeft > 0 && entriesLeft > 0 && targets.size < 1000; index++) {
      const current = queue[index]!;
      directoriesLeft--;
      // Directory entries never authorize recovery writes. Each discovered
      // target still goes through component and identity checks above.
      let directory;
      try { directory = await opendir(current.root); }
      catch (error) {
        if (isMissingPathError(error) || code(error) === 'EACCES' || code(error) === 'EPERM') continue;
        throw error;
      }
      for await (const entry of directory) {
        if (--entriesLeft <= 0) break;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === RECOVERY_FOLDER) {
          const target = await targetFromRecoveryFolder(folder, current.root, platform);
          if (target !== undefined) targets.set(target.root, target);
        } else if (!DEFAULT_EXCLUDED_DIRS.includes(entry.name) && current.depth < 20 && queue.length < 10000) {
          queue.push({ root: path.join(current.root, entry.name), depth: current.depth + 1 });
        }
      }
    }
  }
  return [...targets.values()].sort((left, right) => left.root.localeCompare(right.root));
}

export async function findOrphanedRecoveryTarget(platform: HostPlatform): Promise<RecoveryTarget | undefined> {
  return (await findRecoveryTargets(platform))[0];
}
