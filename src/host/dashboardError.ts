import { UnsupportedLockfileError } from '../core/lockfile/parse.js';
import { UnsupportedPnpmLockfileError } from '../core/lockfile/pnpm.js';
import type { ProtocolError } from './webviewProtocol.js';
import { MISSING_MANIFEST_MESSAGE, PROJECT_UNAVAILABLE_MESSAGE } from '../core/upgrade/projectLoadCopy.js';

/** Node supplies structured paths on both Windows and POSIX. Do not parse display text. */
export function isMissingManifest(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { code?: unknown; path?: unknown };
  return error.code === 'ENOENT' && typeof error.path === 'string' && /(?:^|[\\/])package\.json$/i.test(error.path);
}

/** Raw runtime messages may contain absolute paths, home folders or file contents. */
export function dashboardError(cause: unknown, log?: (line: string) => void): ProtocolError {
  // A broken diagnostic sink must not replace a recoverable load failure.
  try { log?.(`Packageawy project load: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`); } catch { /* best effort local diagnostics */ }
  if (isMissingManifest(cause)) return { code: 'MISSING_MANIFEST', message: MISSING_MANIFEST_MESSAGE };
  if (cause instanceof UnsupportedLockfileError) return { code: 'UnsupportedLockfileError', message: 'Unsupported npm lockfile version. Supported versions are 1, 2 and 3.' };
  if (cause instanceof UnsupportedPnpmLockfileError) return { code: 'UnsupportedPnpmLockfileError', message: 'Unsupported pnpm-lock.yaml version. The supported version is 9.0.' };
  if (cause instanceof SyntaxError) return { code: 'SyntaxError', message: 'A project file could not be read because its format is invalid. Check the Packageawy log, fix the file, then choose Refresh.' };
  return { code: 'PROJECT_LOAD_FAILED', message: PROJECT_UNAVAILABLE_MESSAGE };
}
