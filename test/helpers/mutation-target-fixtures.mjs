/** Temporary folders and an injected host for resolving mutation targets in tests. */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { resolveMutationTarget } = await import('../../out/host/mutationTarget.js');

export async function tempDir(t, prefix = 'packageawy-target-') {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function files(root, entries) {
  for (const [name, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
}

export const manifest = (extra = {}) => JSON.stringify({ name: 'x', version: '1.0.0', ...extra });

/** An empty host: no environment, an empty home, one empty Node prefix. */
export async function environment(t, overrides = {}) {
  const host = await tempDir(t, 'packageawy-host-');
  await mkdir(path.join(host, 'home'), { recursive: true });
  await mkdir(path.join(host, 'prefix', 'etc'), { recursive: true });
  return {
    env: {},
    homeDir: path.join(host, 'home'),
    platform: 'linux',
    nodePrefixes: [path.join(host, 'prefix')],
    host,
    ...overrides,
  };
}

export async function resolve(t, { folder, project, packageManager = 'npm', env }) {
  return resolveMutationTarget({
    projectDir: project,
    folderPath: folder,
    packageManager,
    environment: env ?? (await environment(t)),
  });
}

export function assertRefused(result, code, reason) {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.refusal.code, code);
  if (reason instanceof RegExp) assert.match(result.refusal.reason, reason);
  else assert.equal(result.refusal.reason, reason);
}

