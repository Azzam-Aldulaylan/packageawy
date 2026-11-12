import path from 'node:path';

/**
 * A resolved mutation target for coordinator fakes, shaped like the one
 * loadProject returns. Production always resolves one, and a source
 * without it is refused, so fakes that reach a change must carry one.
 */
export function resolvedTarget(root, {
  packageManager = 'npm',
  lockfileName = packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json',
  lockfileExists = true,
  importerId = '.',
  targetRoot = root,
} = {}) {
  const lockfilePath = path.join(targetRoot, lockfileName);
  return {
    ok: true,
    target: {
      root: targetRoot,
      lockfilePath,
      lockfileName,
      lockfileExists,
      packageManager,
      importerId,
      workspaceMember: importerId !== '.',
    },
    identity: JSON.stringify(['target', packageManager, targetRoot, lockfilePath, importerId]),
  };
}

/** A refusal shaped like the resolver's. */
export function refusedTarget(code, reason) {
  return { ok: false, refusal: { code, reason }, identity: JSON.stringify(['refused', code, reason]) };
}
