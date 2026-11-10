/**
 * Guards that keep Packageawy from writing to a project it should leave alone:
 * Yarn and Bun projects stay read-only, pnpm catalog specifiers are never
 * rewritten, and one dependency change runs per project across panels.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { parseManifest, classifySpecifier } = await import('../out/core/manifest/parse.js');
const { otherPackageManagerForLockfiles } = await import('../out/core/workspace/scan.js');
const { loadProject } = await import('../out/host/projectResolution.js');
const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
const { ProjectMutationLocks } = await import('../out/host/projectMutationLock.js');
const { validateUpgradeRequest, validateBulkUpgradeRequest } = await import('../out/core/upgrade/validate.js');
const { buildStagedManifest, StagedManifestError } = await import('../out/core/upgrade/stagedManifest.js');
const { resolveActionState } = await import('../out/host/upgradeAction.js');
const { smartCleanupProjectCapability } = await import('../out/host/smartCleanupProjectCapability.js');

const YARN_MESSAGE =
  'This project uses Yarn. Packageawy shows its dependencies, and changes are available for npm and pnpm projects.';
const BUN_MESSAGE =
  'This project uses Bun. Packageawy shows its dependencies, and changes are available for npm and pnpm projects.';
const CATALOG_MESSAGE = 'Version comes from the pnpm catalog in pnpm-workspace.yaml.';

async function tempRoot(t, prefix) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// ------------------------------------------------- package manager detection

test('packageManager values other than npm and pnpm are recognized as read-only owners', () => {
  const owner = (value) => parseManifest(JSON.stringify({ packageManager: value })).otherPackageManager;
  assert.equal(owner('yarn@4.1.0'), 'yarn');
  assert.equal(owner('yarn'), 'yarn');
  assert.equal(owner('bun@1.1.0'), 'bun');
  assert.equal(owner('deno@2.0.0'), 'unknown');
  assert.equal(owner('pnpm@10.4.1'), null);
  assert.equal(owner('npm@11.0.0'), null);
  assert.equal(parseManifest('{}').otherPackageManager, null);
});

test('the nearest Yarn or Bun lockfile marks the project unless npm or pnpm locks the same directory', () => {
  assert.equal(otherPackageManagerForLockfiles('', new Map([['', ['yarn.lock']]])), 'yarn');
  assert.equal(otherPackageManagerForLockfiles('packages/a', new Map([['', ['bun.lockb']]])), 'bun');
  assert.equal(otherPackageManagerForLockfiles('', new Map([['', ['bun.lock']]])), 'bun');
  assert.equal(otherPackageManagerForLockfiles('', new Map([['', ['yarn.lock', 'package-lock.json']]])), null);
  assert.equal(
    otherPackageManagerForLockfiles('packages/a', new Map([['', ['yarn.lock']], ['packages/a', ['package-lock.json']]])),
    null
  );
  assert.equal(otherPackageManagerForLockfiles('', new Map()), null);
});

async function loadFixture(t, files) {
  const root = await tempRoot(t, 'packageawy-pm-');
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  const lockfiles = Object.keys(files).filter((name) => /(?:^|\/)(?:yarn\.lock|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml)$/.test(name));
  const folder = { id: 'folder', name: 'fixture', path: root };
  const platform = {
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => false,
    findFiles: async () => lockfiles.map((name) => path.join(root, name)),
  };
  return loadProject(platform, { id: 'project', dir: '', manifestPath: 'package.json', folder });
}

test('loadProject flags Yarn and Bun projects without creating npm state', async (t) => {
  const manifest = JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } });
  assert.equal((await loadFixture(t, { 'package.json': manifest, 'yarn.lock': '' })).otherPackageManager, 'yarn');
  assert.equal((await loadFixture(t, { 'package.json': manifest, 'bun.lock': '{}' })).otherPackageManager, 'bun');
  assert.equal(
    (await loadFixture(t, { 'package.json': JSON.stringify({ name: 'x', packageManager: 'yarn@4.0.0' }) })).otherPackageManager,
    'yarn'
  );
  assert.equal((await loadFixture(t, { 'package.json': manifest, 'package-lock.json': '{}' })).otherPackageManager, null);
});

function readOnlyCoordinator(kind, root = '/packageawy-read-only-fixture') {
  const messages = [];
  const processes = [];
  const coordinator = new UpgradeAssistantCoordinator({
    platform: {
      getSetting: (_key, fallback) => fallback,
      isWorkspaceTrusted: () => true,
      runProcess: (request) => {
        processes.push(request);
        throw new Error('no package manager may run for a read-only project');
      },
    },
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root,
      upgradeSource: {
        manifestText: '{}',
        lockfileText: null,
        lockfilePath: null,
        packageManager: 'npm',
        importerId: '.',
        lockfileName: null,
        otherPackageManager: kind,
      },
      lastResultRows: () => [],
      validateBulkUpgradeRequest: () => ({
        ok: true,
        upgrades: [{ packageName: 'react', currentVersion: '18.0.0', target: '18.3.0', classification: 'prod' }],
      }),
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: 'folder', name: 'fixture', path: root } }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    smartCleanupRemovalEvidence: () => ({ isCurrent: () => true }),
    loadProject: async () => {
      throw new Error('a read-only project is never re-read for a change');
    },
  });
  return { coordinator, messages, processes };
}

for (const [kind, expected] of [['yarn', YARN_MESSAGE], ['bun', BUN_MESSAGE]]) {
  test(`a ${kind} project cannot start upgrade, removal, Smart Cleanup, or transitive fix reviews`, async () => {
    const { coordinator, messages, processes } = readOnlyCoordinator(kind);

    await coordinator.handleAnalyzeUpgrade({ type: 'upgrade', requestId: 'u', package: 'react', target: '18.3.0' });
    await coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
    await coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'c', removalRequestId: 'i', packages: ['react'] });
    await coordinator.handleAnalyzeRemediation({ package: 'react' });

    assert.deepEqual(
      messages.map((message) => [message.status, message.error?.code, message.error?.message]),
      [
        ['upgrade-error', 'PACKAGE_MANAGER_READ_ONLY', expected],
        ['remove-error', 'PACKAGE_MANAGER_READ_ONLY', expected],
        ['remove-error', 'PACKAGE_MANAGER_READ_ONLY', expected],
        ['remediation-error', 'PACKAGE_MANAGER_READ_ONLY', expected],
      ]
    );
    assert.equal(coordinator.isBusy(), false, 'no reservation is left behind');
    assert.deepEqual(processes, []);
  });
}

test('Smart Cleanup reports the read-only reason as its capability', () => {
  const capability = smartCleanupProjectCapability({
    packageManager: 'npm',
    importerId: '.',
    lockfileName: null,
    otherPackageManager: 'yarn',
  });
  assert.deepEqual(capability, { executionSupported: false, reason: YARN_MESSAGE });
});

// ------------------------------------------------------------ pnpm catalogs

test('catalog specifiers keep registry lookup but are marked as catalog owned', () => {
  assert.deepEqual(classifySpecifier('catalog:'), { catalog: true });
  assert.deepEqual(classifySpecifier('catalog:react18'), { catalog: true });
  const [dependency] = parseManifest(JSON.stringify({ dependencies: { react: 'catalog:' } })).dependencies;
  assert.equal(dependency.catalog, true);
  assert.equal(dependency.unresolvable, undefined);
});

test('a catalog dependency is not upgradable, alone or in a batch', () => {
  const row = {
    name: 'react',
    current: '18.0.0',
    wanted: '18.3.0',
    latest: '19.0.0',
    dev: false,
    range: 'catalog:',
    advisories: [],
    worstSeverity: null,
    upgradeTo: '18.3.0',
    upgradeReason: 'update',
  };
  const declared = [{ name: 'react', range: 'catalog:', dev: false, optional: false, catalog: true }];
  assert.deepEqual(validateUpgradeRequest([row], declared, { package: 'react', target: '18.3.0' }), {
    ok: false,
    reason: 'catalog-specifier',
  });
  const batch = validateBulkUpgradeRequest([row], declared, [{ package: 'react', target: '18.3.0' }]);
  assert.equal(batch.ok, false);
  assert.equal(batch.changeReason, 'catalog-specifier');
});

test('a staged manifest never replaces a catalog specifier with a version', () => {
  const manifest = `${JSON.stringify({ dependencies: { react: 'catalog:react18', lodash: '^4.17.0' } }, null, 2)}\n`;
  assert.throws(
    () => buildStagedManifest(manifest, [
      { packageName: 'lodash', target: '4.17.21', classification: 'prod' },
      { packageName: 'react', target: '18.3.1', classification: 'prod' },
    ]),
    (error) => error instanceof StagedManifestError && error.code === 'CATALOG_SPECIFIER'
  );
});

test('the action cell explains catalog ownership instead of offering an upgrade', () => {
  const state = resolveActionState({
    name: 'react',
    current: '18.0.0',
    wanted: '18.3.0',
    latest: '19.0.0',
    dev: false,
    range: 'catalog:',
    advisories: [],
    worstSeverity: null,
    upgradeTo: null,
    upgradeReason: null,
  });
  assert.deepEqual(state, { kind: 'unavailable', tooltip: CATALOG_MESSAGE });
});

// ------------------------------------------------- one change per project

function heldCoordinator(root, lifecycle = []) {
  let rejectLoad;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const messages = [];
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      lastResultRows: () => [],
      validateBulkUpgradeRequest: () => ({
        ok: true,
        upgrades: [{ packageName: 'dep', currentVersion: '1.0.0', target: '2.0.0', classification: 'prod' }],
      }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: 'folder', name: 'fixture', path: root } }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => lifecycle.push('flush'),
    onMutationLockReleased: () => lifecycle.push('resume'),
    loadProject: async () => {
      markStarted();
      return await new Promise((_, reject) => {
        rejectLoad = reject;
      });
    },
  });
  return { coordinator, messages, started, release: () => rejectLoad(new Error('done')) };
}

test('two coordinators for the same project root cannot both hold the change lock', async (t) => {
  const root = await tempRoot(t, 'packageawy-lock-');
  const first = heldCoordinator(root);
  const secondLifecycle = [];
  const second = heldCoordinator(root, secondLifecycle);
  const other = heldCoordinator(await tempRoot(t, 'packageawy-lock-other-'));

  const running = first.coordinator.handleAnalyzeUpgrade({ type: 'upgrade', requestId: 'a', package: 'dep', target: '2.0.0' });
  await first.started;

  // A reopened panel sees the change the closed one is still running.
  assert.equal(second.coordinator.isBusy(), true);
  assert.equal(second.coordinator.isMutationBusy(), true);
  await second.coordinator.handleAnalyzeUpgrade({ type: 'upgrade', requestId: 'b', package: 'dep', target: '2.0.0' });
  assert.deepEqual(second.messages.map((message) => [message.status, message.error?.code]), [
    ['upgrade-error', 'UPGRADE_IN_PROGRESS'],
  ]);

  // A different project root is unaffected.
  assert.equal(other.coordinator.isBusy(), false);

  first.release();
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.coordinator.isBusy(), false);
  assert.deepEqual(secondLifecycle, ['flush', 'resume'], 'deferred watcher changes are applied after the other change ends');
});

test('the lock registry keys symlinked spellings of a root together and only the owner releases', async (t) => {
  const root = await tempRoot(t, 'packageawy-lock-link-');
  const link = `${root}-link`;
  const { symlink } = await import('node:fs/promises');
  await symlink(root, link);
  t.after(() => rm(link, { force: true }));
  const locks = new ProjectMutationLocks();
  const a = {};
  const b = {};
  const key = locks.tryAcquire(root, a);
  assert.ok(key);
  assert.equal(locks.tryAcquire(link, b), null);
  locks.release(key, b);
  assert.equal(locks.isHeldByOther(key, b), true);
  locks.release(key, a);
  assert.ok(locks.tryAcquire(link, b));
});
