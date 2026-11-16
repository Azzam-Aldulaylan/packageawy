import type { RollbackFileResult } from './upgradeTransaction.js';

/** Check the whole set before the first swap so a known conflict cannot cause a partial restore. */
export async function precheckRestore(
  entries: readonly { path: string; check(): Promise<boolean> }[]
): Promise<RollbackFileResult[]> {
  const issues: RollbackFileResult[] = [];
  for (const entry of entries) {
    // Readers represent missing dependency files as { exists: false }. Only
    // an observed mismatch is a conflict. Exceptions cannot establish state.
    if (!await entry.check()) issues.push({ path: entry.path, status: 'conflict', message: `Dependency file changed: ${entry.path}` });
  }
  return issues;
}
