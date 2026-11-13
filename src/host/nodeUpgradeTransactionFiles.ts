/**
 * Real Node filesystem adapter for upgrade transactions.
 *
 * The factory binds an explicit host-owned allowlist to one canonical
 * workspace root. Every operation revalidates containment and refuses a
 * symlink at the file itself or the nearest existing ancestor. The adapter
 * never accepts a path merely because it happens to be under the workspace;
 * it must exactly match an entry supplied to the factory.
 *
 * Node does not expose a general filesystem compare-and-swap primitive for an
 * existing pathname. We therefore use the strongest practical construction:
 * read/compare, prepare exact replacement bytes in the same directory,
 * read/compare again immediately before an atomic rename. The transaction
 * relies on that compare-and-swap contract for host-generated manifest staging
 * as well as rollback. Restoring a file
 * that is expected to be absent uses `link`, which is atomically no-clobber;
 * deleting a transaction-created file similarly performs a second comparison
 * immediately before unlink. Callers must still serialize dashboard-owned
 * operations around a transaction.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  open,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';

import { canonicalPath, nativeRealpath, relatePaths, rootAndSegments } from './pathIdentity.js';
import type {
  CompareAndSwapResult,
  FileState,
  UpgradeTransactionFileAdapter,
} from './upgradeTransaction.js';

export type UpgradeTransactionPathErrorCode =
  | 'PATH_NOT_ALLOWLISTED'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SYMLINK_NOT_ALLOWED'
  | 'INVALID_ALLOWLIST';

export class UpgradeTransactionPathError extends Error {
  constructor(
    readonly code: UpgradeTransactionPathErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'UpgradeTransactionPathError';
  }
}

export interface NodeUpgradeTransactionFileAdapterOptions {
  /** Workspace-folder root, not a selected workspace member's project root. */
  workspaceRoot: string;
  /** Absolute manifest/active-lockfile paths resolved by the trusted host. */
  allowlistedPaths: readonly string[];
}

function stateEquals(left: FileState, right: FileState): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return Buffer.from(left.contents).equals(Buffer.from(right.contents));
}

function cloneState(state: FileState): FileState {
  if (!state.exists) return { exists: false };
  return { exists: true, contents: Uint8Array.from(state.contents) };
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

/** The filesystem calls the path checks make. Node's, or Windows rules and fakes in a test. */
export interface TransactionPathChecks {
  path: path.PlatformPath;
  lstat(candidate: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(candidate: string): Promise<string>;
}

const NODE_CHECKS: TransactionPathChecks = {
  path,
  lstat: (candidate) => lstat(candidate),
  realpath: (candidate) => nativeRealpath(candidate),
};

/**
 * A path is accepted whatever valid spelling it uses (a Windows short name
 * such as RUNNER~1, another drive-letter case, a link above the folder),
 * as long as no part of it below the opened folder is a symbolic link and
 * its native realpath is inside the folder's.
 *
 * The link check walks every part of the path as written, from the
 * filesystem root, so a differently spelled prefix (C:\WORKSPACE for
 * C:\workspace) cannot skip it. Whether a part is below the folder is
 * decided by the realpath of its parent, not by how it is spelled. Links
 * above the folder are allowed (/tmp on macOS, a home directory alias), so
 * only a link whose parent resolves to the folder or below it is refused.
 */
async function assertSafeCanonicalPath(
  checks: TransactionPathChecks,
  canonicalRoot: string,
  candidate: string
): Promise<void> {
  const { root, segments } = rootAndSegments(candidate, checks.path);
  let parent = root;
  for (const segment of segments) {
    const current = checks.path.join(parent, segment);
    let isLink: boolean;
    try {
      isLink = (await checks.lstat(current)).isSymbolicLink();
    } catch (cause) {
      // Nothing below a missing part exists, so nothing below it is a link.
      if (isMissing(cause)) break;
      throw cause;
    }
    if (isLink) {
      const parentCanonical = await canonicalPath(parent, checks).catch(() => undefined);
      const relation = parentCanonical === undefined ? undefined : relatePaths(canonicalRoot, parentCanonical, checks.path);
      if (relation === undefined || relation === 'same' || relation === 'inside') {
        throw new UpgradeTransactionPathError(
          'SYMLINK_NOT_ALLOWED',
          `Upgrade transaction path uses a symbolic link: ${current}`
        );
      }
    }
    parent = current;
  }

  // The same comparison the mutation target resolver used to accept this
  // path: native realpath, then exact segments.
  const canonical = await canonicalPath(candidate, checks).catch(() => undefined);
  if (canonical === undefined || relatePaths(canonicalRoot, canonical, checks.path) !== 'inside') {
    throw new UpgradeTransactionPathError(
      'PATH_OUTSIDE_WORKSPACE',
      `Upgrade transaction path is outside the workspace: ${candidate}`
    );
  }
}

class NodeUpgradeTransactionFileAdapter implements UpgradeTransactionFileAdapter {
  constructor(
    private readonly checks: TransactionPathChecks,
    private readonly canonicalRoot: string,
    /** Canonical path to the allowlisted spelling that gets read and written. */
    private readonly allowed: ReadonlyMap<string, string>
  ) {}

  /**
   * Membership is decided by the shared path identity: the native realpath
   * of the request (through its nearest existing parent) must equal one of
   * the allowlisted files' exactly. A request that cannot be canonicalized
   * is refused.
   */
  private async resolveAllowed(candidate: string): Promise<string> {
    const canonical = await canonicalPath(path.resolve(candidate), this.checks).catch(() => undefined);
    const resolved = canonical === undefined ? undefined : this.allowed.get(canonical);
    if (resolved === undefined) {
      throw new UpgradeTransactionPathError(
        'PATH_NOT_ALLOWLISTED',
        `Path is not owned by this upgrade transaction: ${candidate}`
      );
    }
    await assertSafeCanonicalPath(this.checks, this.canonicalRoot, resolved);
    return resolved;
  }

  private async readWithMode(
    candidate: string
  ): Promise<{ state: FileState; mode?: number }> {
    const resolved = await this.resolveAllowed(candidate);
    let handle;
    try {
      // O_NOFOLLOW closes the leaf-symlink race between the lstat/realpath
      // validation above and opening the file on platforms that support it.
      handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadata = await handle.stat();
      return {
        state: { exists: true, contents: Uint8Array.from(await handle.readFile()) },
        // Preserve ordinary owner/group/other permissions. File-type and
        // set-id/sticky bits are deliberately not copied to a new inode.
        mode: metadata.mode & 0o777,
      };
    } catch (cause) {
      if (isMissing(cause)) return { state: { exists: false } };
      throw cause;
    } finally {
      await handle?.close();
    }
  }

  async read(candidate: string): Promise<FileState> {
    return (await this.readWithMode(candidate)).state;
  }

  async compareAndSwap(
    candidate: string,
    expected: FileState,
    replacement: FileState
  ): Promise<CompareAndSwapResult> {
    const resolved = await this.resolveAllowed(candidate);
    const current = await this.read(resolved);
    if (!stateEquals(current, expected)) return 'conflict';

    if (!replacement.exists) {
      if (!expected.exists) return 'restored';
      const justBeforeDelete = await this.read(resolved);
      if (!stateEquals(justBeforeDelete, expected)) return 'conflict';
      try {
        await unlink(resolved);
        return 'restored';
      } catch (cause) {
        // Disappearance after the second comparison is a concurrent change,
        // not a rollback write failure.
        if (isMissing(cause)) return 'conflict';
        throw cause;
      }
    }

    const temporary = path.join(
      path.dirname(resolved),
      `.${path.basename(resolved)}.packageawy-${randomUUID()}.tmp`
    );
    let temporaryCreated = false;
    let temporaryHandle;
    try {
      temporaryHandle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600
      );
      temporaryCreated = true;
      await temporaryHandle.writeFile(replacement.contents);

      const justBeforeReplace = await this.readWithMode(resolved);
      if (!stateEquals(justBeforeReplace.state, expected)) return 'conflict';

      if (expected.exists) {
        // A same-directory rename installs the temporary inode, so its mode
        // would otherwise remain the private 0600 creation mode. Apply the
        // existing target's safely-opened permission bits to that inode before
        // it becomes visible. chmod on the open handle avoids following a
        // workspace-controlled pathname.
        await temporaryHandle.chmod(justBeforeReplace.mode ?? 0o600);
      }
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      if (!expected.exists) {
        // Unlike rename, link never overwrites a file that appeared after the
        // comparison. Both paths are in one directory/filesystem.
        try {
          await link(temporary, resolved);
        } catch (cause) {
          const code =
            typeof cause === 'object' && cause !== null && 'code' in cause
              ? (cause as { code?: unknown }).code
              : undefined;
          if (code === 'EEXIST') return 'conflict';
          throw cause;
        }
        return 'restored';
      }

      // Same-directory rename is atomic for readers. Node/filesystems do not
      // offer a conditional rename, hence the second exact-byte check above.
      await rename(temporary, resolved);
      temporaryCreated = false;
      return 'restored';
    } finally {
      await temporaryHandle?.close().catch(() => {});
      if (temporaryCreated) await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export async function createNodeUpgradeTransactionFileAdapter(
  options: NodeUpgradeTransactionFileAdapterOptions,
  /** Test seam. Production uses Node's lstat and native realpath. */
  checks: TransactionPathChecks = NODE_CHECKS
): Promise<UpgradeTransactionFileAdapter> {
  const root = checks.path.resolve(options.workspaceRoot);
  const rootStat = await checks.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new UpgradeTransactionPathError(
      'SYMLINK_NOT_ALLOWED',
      `Workspace root must not be a symbolic link: ${root}`
    );
  }
  const canonicalRoot = await canonicalPath(root, checks);

  const allowed = new Map<string, string>();
  for (const raw of options.allowlistedPaths) {
    if (raw.length === 0 || !checks.path.isAbsolute(raw)) {
      throw new UpgradeTransactionPathError(
        'INVALID_ALLOWLIST',
        'Upgrade transaction allowlist entries must be non-empty absolute paths.'
      );
    }
    const resolved = checks.path.resolve(raw);
    await assertSafeCanonicalPath(checks, canonicalRoot, resolved);
    allowed.set(await canonicalPath(resolved, checks), resolved);
  }

  if (allowed.size === 0) {
    throw new UpgradeTransactionPathError(
      'INVALID_ALLOWLIST',
      'An upgrade transaction requires at least one allowlisted file.'
    );
  }

  return new NodeUpgradeTransactionFileAdapter(checks, canonicalRoot, allowed);
}

/** Exposed for adapters/tests that need exact FileState comparison semantics. */
export function fileStatesEqual(left: FileState, right: FileState): boolean {
  return stateEquals(cloneState(left), cloneState(right));
}
