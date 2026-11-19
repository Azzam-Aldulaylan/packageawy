import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { otherPackageManagerMessage, requireMutationTarget } from '../out/host/packageManagerSupport.js';
import { loadProject } from '../out/host/projectResolution.js';
import { LOCKFILE_UNDETERMINED_REASON, PNPMFILE_REASON } from '../out/host/pnpmLockfileSettings.js';
import { refusedTarget, resolvedTarget } from './helpers/mutation-target.mjs';

import { smartCleanupProjectCapability } from '../out/host/smartCleanupProjectCapability.js';

function source(overrides = {}) {
  return {
    packageManager: 'npm',
    importerId: '.',
    lockfileName: 'package-lock.json',
    ...overrides,
  };
}

test('Smart Cleanup execution supports covered npm and pnpm root projects', () => {
  assert.deepEqual(smartCleanupProjectCapability(source()), { executionSupported: true });
  assert.deepEqual(
    smartCleanupProjectCapability(source({ packageManager: 'pnpm', lockfileName: 'pnpm-lock.yaml' })),
    { executionSupported: true }
  );
});

for (const importerId of new Set([path.join('packages', 'web'), path.win32.join('packages', 'web')])) {
  test(`workspace member ${importerId} stays blocked with a plain reason`, () => {
    assert.deepEqual(smartCleanupProjectCapability(source({
      importerId,
      mutationTarget: resolvedTarget(path.join(tmpdir(), 'workspace'), { importerId }),
    })), {
      executionSupported: false,
      reason: "This package shares the workspace lockfile, so Smart Cleanup can't remove it here. You can remove it from Manage dependency.",
    });
  });

  test(`refused workspace member ${importerId} shows the removal refusal without advice`, () => {
    assert.deepEqual(smartCleanupProjectCapability(source({
      packageManager: 'pnpm',
      lockfileName: 'pnpm-lock.yaml',
      importerId,
      mutationTarget: refusedTarget('PNPMFILE', PNPMFILE_REASON),
    })), {
      executionSupported: false,
      reason: `This package shares the workspace lockfile, so Smart Cleanup can't remove it here. ${PNPMFILE_REASON}`,
    });
  });
}

test('a workspace member without a resolved target shows the shared removal refusal', () => {
  assert.deepEqual(smartCleanupProjectCapability(source({ importerId: path.join('packages', 'web') })), {
    executionSupported: false,
    reason: `This package shares the workspace lockfile, so Smart Cleanup can't remove it here. ${LOCKFILE_UNDETERMINED_REASON}`,
  });
});

test('a workspace member without refusal text shows only the workspace reason', () => {
  assert.deepEqual(smartCleanupProjectCapability(source({
    importerId: path.join('packages', 'web'),
    mutationTarget: refusedTarget('LOCKFILE_UNDETERMINED', ''),
  })), {
    executionSupported: false,
    reason: "This package shares the workspace lockfile, so Smart Cleanup can't remove it here.",
  });
});

async function workspaceMember(t, packageManager, withPnpmfile = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-cleanup-capability-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join('packages', 'web');
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }));
  await writeFile(path.join(root, dir, 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0' }));
  const lockfileName = packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  await writeFile(path.join(root, lockfileName), packageManager === 'npm' ? '{"lockfileVersion":3,"packages":{}}' : 'lockfileVersion: "9.0"\n');
  if (packageManager === 'pnpm') await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  if (withPnpmfile) await writeFile(path.join(root, '.pnpmfile.cjs'), 'module.exports = { hooks: {} };\n');
  return loadProject({
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => true,
    findFiles: async () => [path.join(root, lockfileName)],
  }, {
    id: 'web', dir, manifestPath: path.join(dir, 'package.json'),
    folder: { id: 'workspace', name: 'repo', path: root },
  }, undefined, { env: {}, homeDir: path.join(root, '.no-home'), platform: process.platform, nodePrefixes: [] });
}

test('a loaded npm workspace member shows Manage dependency advice when removal is allowed', async t => {
  const project = await workspaceMember(t, 'npm');
  assert.notEqual(project.importerId, '.');
  assert.equal(requireMutationTarget(project).ok, true);
  assert.deepEqual(smartCleanupProjectCapability(project), {
    executionSupported: false,
    reason: "This package shares the workspace lockfile, so Smart Cleanup can't remove it here. You can remove it from Manage dependency.",
  });
});

test('a loaded pnpm workspace member with .pnpmfile.cjs shows its removal refusal without advice', async t => {
  const project = await workspaceMember(t, 'pnpm', true);
  assert.notEqual(project.importerId, '.');
  assert.deepEqual(requireMutationTarget(project), {
    ok: false, error: { code: 'CHANGES_UNAVAILABLE', message: PNPMFILE_REASON },
  });
  assert.deepEqual(smartCleanupProjectCapability(project), {
    executionSupported: false,
    reason: `This package shares the workspace lockfile, so Smart Cleanup can't remove it here. ${PNPMFILE_REASON}`,
  });
});

test('projects without a lockfile stay blocked and name the supported lockfiles', () => {
  assert.deepEqual(smartCleanupProjectCapability(source({ lockfileName: null })), {
    executionSupported: false,
    reason: 'Smart Cleanup needs a package-lock.json or pnpm-lock.yaml to remove packages.',
  });
});

test('npm-shrinkwrap projects stay blocked with a plain reason', () => {
  assert.deepEqual(smartCleanupProjectCapability(source({ lockfileName: 'npm-shrinkwrap.json' })), {
    executionSupported: false,
    reason: "Smart Cleanup can't remove packages in projects that use npm-shrinkwrap.json.",
  });
});

for (const otherPackageManager of ['yarn', 'bun', 'unknown']) {
  test(`${otherPackageManager} keeps the shared package manager reason`, () => {
    assert.deepEqual(smartCleanupProjectCapability(source({ otherPackageManager })), {
      executionSupported: false,
      reason: otherPackageManagerMessage(otherPackageManager),
    });
  });
}

test('an unsupported package manager stays blocked without execution jargon', () => {
  assert.deepEqual(smartCleanupProjectCapability(source({ packageManager: 'unsupported' })), {
    executionSupported: false,
    reason: "Smart Cleanup can't remove packages in projects that use unsupported.",
  });
});
