import path from 'node:path';

/** Identical guidance for an unavailable offer and an incomplete file restore. */
export function manualReinstallNote(packageManager: 'npm' | 'pnpm'): string {
  return `node_modules may not match the dependency files. To reinstall by hand, review the dependency files and run ${packageManager} install in the project directory.`;
}

export function recoveryPackageManager(allowlistedPaths: readonly string[]): 'npm' | 'pnpm' {
  return allowlistedPaths.some(candidate => path.basename(candidate) === 'pnpm-lock.yaml') ? 'pnpm' : 'npm';
}

/** Shared result guidance after a known optional reinstall outcome. */
export function reinstallResultNote(packageManager: 'npm' | 'pnpm', result: 'skipped' | 'succeeded' | 'failed' | undefined): string {
  return result === 'succeeded'
    ? 'Dependencies were reinstalled using the restored lockfile.'
    : manualReinstallNote(packageManager);
}
