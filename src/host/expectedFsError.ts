/** Ordinary refusals are operation-specific. Unlisted failures cannot establish an outcome. */
const expectedCodes = {
  missingPath: ['ENOENT', 'ENOTDIR'],
  missingFile: ['ENOENT'],
  exclusiveCreate: ['EEXIST'],
  read: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'],
  canonicalize: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'],
  restoreRename: ['ENOENT', 'EEXIST', 'EXDEV', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'EROFS'],
  cleanup: ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY'],
  processGone: ['ESRCH'],
  terminateGroup: ['EACCES', 'EPERM'],
  scanDirectory: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'],
  probe: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOEXEC', 'ETIMEDOUT'],
  exclusiveLink: ['EEXIST', 'EXDEV', 'EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EBUSY'],
} as const;

export type FsOperation = keyof typeof expectedCodes;

export function isExpectedFsError(error: unknown, operation: FsOperation): boolean {
  // A programming exception must never become ordinary even if it carries a code.
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return false;
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return false;
  return (expectedCodes[operation] as readonly string[]).includes(error.code);
}

/** Read-only callers preserve their fallback for every filesystem errno, including unknown codes. */
export function isFsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}
