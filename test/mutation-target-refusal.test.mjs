/**
 * Every dependency change reads the resolved mutation target. A refusal
 * blocks every entry point before anything is reserved, run or written,
 * and it is an expected answer, never an internal error.
 */

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { UpgradeAssistantCoordinator } = await import('../out/host/upgradeAssistantCoordinator.js');
const { loadProject } = await import('../out/host/projectResolution.js');
const { OUTSIDE_FOLDER_REASON, PATH_ESCAPES_REASON } = await import('../out/host/mutationTarget.js');
const {
  LOCKFILE_UNDETERMINED_REASON,
  PNPMFILE_REASON,
  PNPM_CONFIG_DEPENDENCIES_REASON,
} = await import('../out/host/pnpmLockfileSettings.js');
const {
  UpgradeExecutionSession,
  NPM_TOO_OLD_FOR_MEMBER_CODE,
  NPM_TOO_OLD_FOR_MEMBER_MESSAGE,
  npmFindsWorkspaceRoot,
} = await import('../out/host/upgradeRunner.js');
const { computeSourceFingerprint, sourceFingerprintsMatch } = await import('../out/core/cache/sourceFingerprint.js');
const { isHostToWebviewMessage } = await import('../out/host/webviewProtocol.js');
import { refusedTarget, resolvedTarget } from './helpers/mutation-target.mjs';

const REFUSALS = [
  refusedTarget('OUTSIDE_FOLDER', OUTSIDE_FOLDER_REASON),
  refusedTarget('PATH_ESCAPES', PATH_ESCAPES_REASON),
  refusedTarget('LOCKFILE_UNDETERMINED', LOCKFILE_UNDETERMINED_REASON),
  refusedTarget('LOCKFILE_UNDETERMINED', `${LOCKFILE_UNDETERMINED_REASON} Setting found: lockfile-dir in your user .npmrc.`),
  refusedTarget('PNPMFILE', PNPMFILE_REASON),
  refusedTarget('PNPM_CONFIG_DEPENDENCIES', PNPM_CONFIG_DEPENDENCIES_REASON),
];

function refusingCoordinator(mutationTarget) {
  const messages = [];
  const processes = [];
  const failures = [];
  let loads = 0;
  const coordinator = new UpgradeAssistantCoordinator({
    platform: {
      getSetting: (_key, fallback) => fallback,
      isWorkspaceTrusted: () => true,
      runProcess: (request) => {
        processes.push(request);
        throw new Error('no package manager may run for a refused project');
      },
    },
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root: '/packageawy-refused-fixture',
      upgradeSource: {
        manifestText: '{}',
        lockfileText: null,
        lockfilePath: null,
        packageManager: 'npm',
        importerId: '.',
        lockfileName: null,
        otherPackageManager: null,
        ...(mutationTarget === undefined ? {} : { mutationTarget }),
      },
      lastResultRows: () => [],
      validateBulkUpgradeRequest: () => ({
        ok: true,
        upgrades: [{ packageName: 'react', currentVersion: '18.0.0', target: '18.3.0', classification: 'prod' }],
      }),
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: 'folder', name: 'fixture', path: '/packageawy-refused-fixture' } }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    smartCleanupRemovalEvidence: () => ({ isCurrent: () => true }),
    reportBackgroundFailure: (...args) => failures.push(args),
    loadProject: async () => {
      loads += 1;
      throw new Error('a refused project is never re-read for a change');
    },
  });
  return { coordinator, messages, processes, failures, loads: () => loads };
}

for (const refusal of [...REFUSALS, undefined]) {
  const label = refusal === undefined ? 'a source without a resolved target' : `${refusal.refusal.code}: ${refusal.refusal.reason}`;
  test(`every change entry point refuses ${label}`, async () => {
    const { coordinator, messages, processes, failures, loads } = refusingCoordinator(refusal);
    const expected = refusal?.refusal.reason ?? LOCKFILE_UNDETERMINED_REASON;

    await coordinator.handleAnalyzeUpgrade({ type: 'upgrade', requestId: 'u', package: 'react', target: '18.3.0' });
    await coordinator.handleAnalyzeBulkUpgrade({ type: 'bulk-upgrade', requestId: 'b', changes: [{ package: 'react', target: '18.3.0' }] });
    await coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
    await coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'c', removalRequestId: 'i', packages: ['react'] });
    await coordinator.handleAnalyzeRemediation({ package: 'react' });

    assert.deepEqual(
      messages.map((message) => [message.status, message.error?.code, message.error?.message]),
      [
        ['upgrade-error', 'CHANGES_UNAVAILABLE', expected],
        ['upgrade-error', 'CHANGES_UNAVAILABLE', expected],
        ['remove-error', 'CHANGES_UNAVAILABLE', expected],
        ['remove-error', 'CHANGES_UNAVAILABLE', expected],
        ['remediation-error', 'CHANGES_UNAVAILABLE', expected],
      ]
    );
    for (const message of messages) assert.ok(isHostToWebviewMessage(message));
    assert.equal(coordinator.isBusy(), false, 'no reservation is left behind');
    assert.deepEqual(processes, [], 'no process was launched');
    assert.equal(loads(), 0, 'nothing was read for a change');
    assert.deepEqual(failures, [], 'an expected refusal is not reported as an internal failure');
  });
}

// ------------------------------------------------- real files, confirm time

async function tempRoot(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-refusal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, entries) {
  for (const [name, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') found.push(...(await walk(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

const exists = (filePath) => access(filePath).then(() => true, () => false);
const MEMBER_MANIFEST = `${JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { react: '^18.0.0' } }, null, 2)}\n`;
const MEMBER_LOCKFILE = `${JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: { '': { dependencies: { react: '^18.0.0' } }, 'node_modules/react': { version: '18.2.0' } },
}, null, 2)}\n`;

/** The real coordinator, project loader and file adapter on a temporary folder. Only the package manager is faked. */
function realCoordinator(folderPath, dir, onInstall) {
  const messages = [];
  const commands = [];
  const folder = { id: `file://${folderPath}`, name: 'fixture', path: folderPath };
  const candidate = { id: 'project', dir, manifestPath: dir === '' ? 'package.json' : `${dir}/package.json`, folder };
  const platform = {
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => true,
    findFiles: async ({ include }) => {
      const names = include.replace(/^\*\*\/\{?/, '').replace(/\}$/, '').split(',');
      return (await walk(folderPath)).filter((file) => names.includes(path.basename(file)));
    },
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    async updateWorkspaceSetting() {},
    async runProcess(request) {
      const command = request.args.find((arg) => arg === 'install' || arg === 'ci');
      commands.push({ command, cwd: request.cwd });
      const exitCode = await onInstall();
      return { onDidExit: (listener) => { setImmediate(() => listener(exitCode)); return { dispose() {} }; } };
    },
  };
  const environment = { env: {}, homeDir: path.join(folderPath, '.no-home'), platform: process.platform, nodePrefixes: [] };
  const read = () => loadProject(platform, candidate, undefined, environment);
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => {
      assert.ok(isHostToWebviewMessage(message), `invalid host message ${JSON.stringify(message)}`);
      messages.push(message);
    } },
    httpClient: {},
    etagStore: {},
    ensureController: async () => {
      const source = await read();
      return {
        root: source.root,
        upgradeSource: source,
        validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
      };
    },
    getSelectedProject: () => candidate,
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    loadProject: read,
  });
  return { coordinator, messages, commands };
}

async function reviewRemoval(fixture) {
  await fixture.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const review = fixture.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(review, `the removal review was posted: ${JSON.stringify(fixture.messages.at(-1))}`);
  return review.analysis.analysisId;
}

test('a topology change between review and apply invalidates the review and writes nothing', async (t) => {
  const root = await tempRoot(t);
  // No lockfile anywhere, so only the target itself changes below.
  await write(root, {
    'package.json': JSON.stringify({ name: 'repo', private: true }),
    'packages/app/package.json': MEMBER_MANIFEST,
  });
  const fixture = realCoordinator(root, 'packages/app', async () => 0);
  const analysisId = await reviewRemoval(fixture);

  // The root starts claiming the package: npm would now write the root lockfile.
  await write(root, { 'package.json': JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }) });
  await fixture.coordinator.handleConfirmRemove({ analysisId });

  const error = fixture.messages.at(-1);
  assert.equal(error.status, 'remove-error');
  assert.equal(error.error.code, 'STALE_SOURCE');
  assert.deepEqual(fixture.commands, []);
  assert.equal(await readFile(path.join(root, 'packages/app/package.json'), 'utf8'), MEMBER_MANIFEST);
  assert.equal(await exists(path.join(root, 'package-lock.json')), false);
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('a refusal that appears between review and apply is reported as itself and writes nothing', async (t) => {
  const root = await tempRoot(t);
  const elsewhere = await tempRoot(t);
  await write(root, { 'package.json': MEMBER_MANIFEST, 'package-lock.json': MEMBER_LOCKFILE });
  await write(elsewhere, { 'package-lock.json': MEMBER_LOCKFILE });
  const fixture = realCoordinator(root, '', async () => 0);
  const analysisId = await reviewRemoval(fixture);

  await rm(path.join(root, 'package-lock.json'));
  await symlink(path.join(elsewhere, 'package-lock.json'), path.join(root, 'package-lock.json'));
  await fixture.coordinator.handleConfirmRemove({ analysisId });

  assert.deepEqual(fixture.messages.at(-1), {
    status: 'remove-error',
    package: 'react',
    error: { code: 'CHANGES_UNAVAILABLE', message: PATH_ESCAPES_REASON },
  });
  assert.deepEqual(fixture.commands, []);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), MEMBER_MANIFEST);
  assert.equal(await readFile(path.join(elsewhere, 'package-lock.json'), 'utf8'), MEMBER_LOCKFILE);
});

test('a workspace lockfile the install creates is captured as absent and removed on rollback', async (t) => {
  const root = await tempRoot(t);
  await write(root, {
    'package.json': JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }),
    'packages/app/package.json': MEMBER_MANIFEST,
  });
  const rootLockfile = path.join(root, 'package-lock.json');
  // npm writes the workspace root lockfile, then fails.
  const fixture = realCoordinator(root, 'packages/app', async () => {
    await writeFile(rootLockfile, MEMBER_LOCKFILE);
    return 1;
  });
  const analysisId = await reviewRemoval(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });

  const result = fixture.messages.findLast((message) => message.status === 'remove-result');
  assert.ok(result, `the removal finished: ${JSON.stringify(fixture.messages.at(-1))}`);
  assert.equal(result.result.rollback, 'succeeded');
  assert.deepEqual(fixture.commands.map(({ command, cwd }) => [command, cwd]), [['install', path.join(root, 'packages/app')]]);
  assert.equal(await exists(rootLockfile), false, 'the created root lockfile was deleted');
  assert.equal(await exists(path.join(root, 'packages/app/package-lock.json')), false);
  assert.equal(await readFile(path.join(root, 'packages/app/package.json'), 'utf8'), MEMBER_MANIFEST);
});

test('the dashboard reads the lockfile the target names, not a stray one in the member', async (t) => {
  const root = await tempRoot(t);
  await write(root, {
    'package.json': JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }),
    'packages/app/package.json': MEMBER_MANIFEST,
    'packages/app/package-lock.json': MEMBER_LOCKFILE,
  });
  const fixture = realCoordinator(root, 'packages/app', async () => 0);
  const project = await fixture.coordinator.projectLoader({
    id: 'project', dir: 'packages/app', manifestPath: 'packages/app/package.json',
    folder: { id: 'f', name: 'fixture', path: root },
  });
  assert.equal(project.mutationTarget.ok, true);
  assert.equal(project.mutationTarget.target.lockfilePath, path.join(root, 'package-lock.json'));
  // The root lockfile does not exist yet, so the dashboard reports it missing.
  assert.equal(project.lockfilePath, null);
  assert.equal(project.lockfileName, null);
  assert.equal(project.importerId, 'packages/app');
  assert.equal(project.lockfileRoot, root);
});

// ------------------------------------------------------------- npm version

test('npm 8.5.0 is the first version that writes the workspace root lockfile from a member', async () => {
  assert.equal(npmFindsWorkspaceRoot('8.5.0'), true);
  assert.equal(npmFindsWorkspaceRoot('10.9.8'), true);
  assert.equal(npmFindsWorkspaceRoot('8.4.1'), false);
  assert.equal(npmFindsWorkspaceRoot('6.14.18'), false);
  assert.equal(npmFindsWorkspaceRoot(undefined), false);

  const processes = [];
  const sessionFor = (version) => new UpgradeExecutionSession(
    { isWorkspaceTrusted: () => true, showErrorMessage: () => {}, runProcess: (request) => processes.push(request) },
    () => ({ executable: '/node', prefixArgs: ['/npm-cli.js'], version })
  );
  const prepare = (version, workspaceMember, kind = 'manifest') => {
    const session = sessionFor(version);
    const params = { cwd: '/repo/packages/app', ignoreScripts: true, packageManager: 'npm', workspaceMember };
    return kind === 'manifest' ? session.prepareManifestReconciliation(params) : session.prepareLockfileReconciliation(params);
  };
  for (const kind of ['manifest', 'lockfile']) {
    assert.equal(prepare('8.5.0', true, kind).ok, true, kind);
    assert.deepEqual(prepare('8.4.1', true, kind), {
      ok: false, code: NPM_TOO_OLD_FOR_MEMBER_CODE, message: NPM_TOO_OLD_FOR_MEMBER_MESSAGE,
    }, kind);
    // A standalone project is unaffected at any version.
    assert.equal(prepare('6.14.18', false, kind).ok, true, kind);
  }
  assert.deepEqual(processes, []);
});

// ------------------------------------------------------------- fingerprint

test('a cached snapshot does not survive a change of mutation target', () => {
  const base = { manifestText: '{}', lockfileText: null, lockfilePath: null };
  const before = computeSourceFingerprint({ ...base, mutationTargetIdentity: resolvedTarget('/repo/app').identity });
  const same = computeSourceFingerprint({ ...base, mutationTargetIdentity: resolvedTarget('/repo/app').identity });
  const moved = computeSourceFingerprint({
    ...base,
    mutationTargetIdentity: resolvedTarget('/repo/app', { targetRoot: '/repo', importerId: 'app' }).identity,
  });
  const refused = computeSourceFingerprint({ ...base, mutationTargetIdentity: REFUSALS[0].identity });
  assert.equal(sourceFingerprintsMatch(before, same), true);
  assert.equal(sourceFingerprintsMatch(before, moved), false);
  assert.equal(sourceFingerprintsMatch(before, refused), false);
});

// ------------------------------------------------- restore after a change

test('an automatic rollback resolves the target again and leaves files alone when it moved', async (t) => {
  const root = await tempRoot(t);
  await write(root, {
    'package.json': JSON.stringify({ name: 'repo', private: true }),
    'packages/app/package.json': MEMBER_MANIFEST,
    'packages/app/package-lock.json': MEMBER_LOCKFILE,
  });
  const memberLockfile = path.join(root, 'packages/app/package-lock.json');
  // The install rewrites the lockfile, the root starts claiming the package, and the install fails.
  const fixture = realCoordinator(root, 'packages/app', async () => {
    await writeFile(memberLockfile, 'written by the failed install');
    await write(root, { 'package.json': JSON.stringify({ name: 'repo', private: true, workspaces: ['packages/*'] }) });
    return 1;
  });
  const analysisId = await reviewRemoval(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });

  assert.equal(fixture.messages.findLast(message => message.status === 'remove-error').status, 'remove-error');
  assert.equal(fixture.messages.findLast(message => message.status === 'remove-error').error.code, 'ROLLBACK_FAILED');
  assert.equal(fixture.messages.at(-1).recovery.state, 'incomplete');
  assert.equal(await readFile(memberLockfile, 'utf8'), 'written by the failed install', 'nothing was restored');
  assert.doesNotMatch(await readFile(path.join(root, 'packages/app/package.json'), 'utf8'), /react/);
});

test("a transitive fix's reinstall after rollback resolves the target again first", async (t) => {
  const root = await tempRoot(t);
  await write(root, { 'package.json': MEMBER_MANIFEST, 'package-lock.json': MEMBER_LOCKFILE });
  const commands = [];
  let loads = 0;
  const read = async () => {
    loads += 1;
    return {
      root,
      manifestText: await readFile(path.join(root, 'package.json'), 'utf8'),
      lockfileText: await readFile(path.join(root, 'package-lock.json'), 'utf8'),
      lockfilePath: path.join(root, 'package-lock.json'),
      lockfileName: 'package-lock.json',
      registry: 'https://registry.npmjs.org/',
      resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} },
      peerPolicy: { strictPeerDeps: false, legacyPeerDeps: false },
      packageManager: 'npm',
      importerId: '.',
      // Loads: the confirm, the security check, the rollback, then the reinstall check.
      mutationTarget: loads < 4 ? resolvedTarget(root) : resolvedTarget(root, { targetRoot: path.dirname(root), importerId: path.basename(root) }),
    };
  };
  const snapshot = await read();
  loads = 0;
  const coordinator = new UpgradeAssistantCoordinator({
    platform: {
      getSetting: (_key, fallback) => fallback,
      isWorkspaceTrusted: () => true,
      showWarningMessage: () => {},
      showErrorMessage: () => {},
      async runProcess(request) {
        commands.push(request.args.find((arg) => arg === 'install' || arg === 'ci'));
        return { onDidExit: (listener) => { setImmediate(() => listener(0)); return { dispose() {} }; } };
      },
    },
    sink: { postMessage: () => {} },
    httpClient: { post: async () => { throw new Error('offline'); }, get: async () => { throw new Error('offline'); } },
    etagStore: { get: () => undefined, set: () => {} },
    ensureController: async () => ({ root, upgradeSource: snapshot }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: 'f', name: 'fixture', path: root } }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    loadProject: read,
  });
  const proposed = MEMBER_LOCKFILE.replace('18.2.0', '18.3.1');
  coordinator.remediationPlans.set('plan', {
    id: 'plan', packageName: 'react', snapshot, before: {}, targetAdvisories: [],
    proposedLockfileText: proposed, packageManagerVersion: null, ignoreScripts: true,
    verificationScripts: [], suggestedScriptNames: [],
    plan: { automaticApplyAllowed: true, target: { resolved: [] } },
    presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
    expiresAt: Date.now() + 60_000, stale: false,
  });
  await coordinator.handleConfirmRemediation({ analysisId: 'plan' });

  assert.equal(commands.length, 1, 'only the fix itself ran, not the reinstall');
  assert.equal(await readFile(path.join(root, 'package-lock.json'), 'utf8'), MEMBER_LOCKFILE, 'the reviewed restore still ran');
});

test('no lock without a resolved target: the selected folder is never used as a key', async (t) => {
  const { ProjectMutationLocks } = await import('../out/host/projectMutationLock.js');
  const root = await tempRoot(t);
  const locks = new ProjectMutationLocks();
  assert.ok(locks.tryAcquire(root, {}), 'another window holds the folder as a target root');
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage: () => {} },
    httpClient: {},
    etagStore: {},
    ensureController: async () => undefined,
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: 'f', name: 'fixture', path: root } }),
    mutationRoot: () => undefined,
    mutationLocks: locks,
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
  });
  assert.equal(coordinator.isBusy(), false);
});
