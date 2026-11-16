import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'js-yaml';
import { offerFrozenReconciliation } from '../out/host/frozenReconciliation.js';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';
import { resolveMutationTarget } from '../out/host/mutationTarget.js';
import { OperationReservation } from '../out/host/operationReservation.js';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { recoveryFixture } from './helpers/recovery.mjs';

async function fixture(t, manager = 'npm', options = {}) {
  const f = await recoveryFixture(t, { manifest: '{"name":"fixture"}', absent: options.absent });
  if (manager === 'pnpm') {
    await fs.unlink(f.lockfile);
    f.lockfile = path.join(f.root, 'pnpm-lock.yaml');
    await fs.writeFile(f.lockfile, 'lockfileVersion: 9');
    f.target.allowlistedPaths = [f.manifest, f.lockfile];
  }
  if (options.member) {
    const dir = path.join(f.root, 'packages', 'app'); await fs.mkdir(dir, { recursive: true });
    if (manager === 'pnpm') {
      await fs.writeFile(f.manifest, '{"name":"fixture","private":true}');
      await fs.writeFile(path.join(f.root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      await fs.writeFile(f.lockfile, "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  packages/app: {}\n");
    } else await fs.writeFile(f.manifest, '{"name":"fixture","workspaces":["packages/*"]}');
    f.manifest = path.join(dir, 'package.json'); await fs.writeFile(f.manifest, '{"name":"app"}');
    f.target.allowlistedPaths = [f.manifest, f.lockfile];
  }
  const resolved = await resolveMutationTarget({ projectDir: path.dirname(f.manifest), folderPath: f.root, packageManager: manager });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.target.root, f.root);
  assert.equal(resolved.target.lockfilePath, f.lockfile);
  assert.equal(resolved.target.importerId, options.member ? 'packages/app' : '.');
  assert.equal(resolved.target.workspaceMember, options.member === true);
  f.target.identity = resolved.identity;
  const locks = new ProjectMutationLocks();
  const reservation = new OperationReservation({ locks, reserve: () => true, release() {}, flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  const handle = reservation.reserve('restore', f.root);
  assert.equal(await handle.beginMutation(f.target), true);
  const prompts = [], requests = [], states = [], warnings = [];
  const platform = { isWorkspaceTrusted: () => true, showWarningMessage(message) { warnings.push(message); },
    async showModalWarning(...args) { prompts.push(args); await options.onPrompt?.(f); return options.choice; },
    async runProcess(request) {
      requests.push(request);
      assert.equal(locks.holderOf(canonicalProjectRoot(f.root)), handle);
      return { onDidExit(listener) { setImmediate(() => listener(options.unknown ? undefined : options.exitCode ?? 0)); return { dispose() {} }; } };
    },
  };
  const session = new UpgradeExecutionSession(platform, () => ({ executable: 'node', prefixArgs: ['manager.js'], version: '10.0.0' }), state => states.push(state));
  return { ...f, journal: handle.journal, platform, session, prompts, requests, states, warnings, handle, locks };
}

for (const manager of ['npm', 'pnpm']) for (const member of [false, true]) {
  test(`${manager} frozen reconciliation is opt-in and runs at the ${member ? 'workspace member' : 'project'} mutation target`, async t => {
    const f = await fixture(t, manager, { choice: 'Reinstall', member });
    assert.deepEqual(f.requests, []);
    assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'succeeded');
    assert.equal(f.prompts.length, 1);
    assert.equal(f.requests[0].cwd, path.dirname(f.manifest));
    assert.equal(f.journal.storage.target.root, f.root);
    assert.ok(f.journal.storage.target.allowlistedPaths.includes(f.lockfile));
    if (manager === 'pnpm' && member) {
      const lock = load(await fs.readFile(f.lockfile, 'utf8'));
      assert.deepEqual(Object.keys(lock.importers), ['.', 'packages/app']);
    }
    assert.deepEqual(f.requests[0].args.slice(1), manager === 'npm' ? ['ci', '--ignore-scripts'] : ['install', '--frozen-lockfile', '--ignore-scripts']);
    assert.deepEqual(f.states, ['running', 'idle']);
    assert.equal(f.journal.data.phase, 'finished');
  });
}

test('declining or closing the reinstall offer starts no task', async t => {
  const f = await fixture(t);
  assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'skipped');
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.requests, []);
});

test('restoring without a lockfile never offers frozen reconciliation', async t => {
  const f = await fixture(t, 'npm', { absent: true, choice: 'Reinstall' });
  assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'skipped');
  assert.deepEqual(f.prompts, []); assert.deepEqual(f.requests, []);
  assert.match(f.warnings.join(' '), /node_modules may not match the dependency files/);
  assert.match(f.warnings.join(' '), /npm install/);
});

test('topology changes during the offer refuse frozen reconciliation', async t => {
  const f = await fixture(t, 'npm', { choice: 'Reinstall', onPrompt: f => fs.writeFile(path.join(f.root, 'npm-shrinkwrap.json'), '{}') });
  assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'skipped');
  assert.deepEqual(f.requests, []);
  assert.match(f.warnings.join(' '), /node_modules may not match the dependency files/);
  assert.match(f.warnings.join(' '), /npm install/);
});

test('unknown frozen task keeps the owner and journal fenced through failure settlement', async t => {
  const f = await fixture(t, 'npm', { choice: 'Reinstall', unknown: true });
  assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'unknown');
  await f.handle.fail('Reinstall result lost');
  assert.equal(f.handle.state, 'unknown');
  assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
  assert.equal(f.locks.holderOf(canonicalProjectRoot(f.root)), f.handle);
});

test('dependency file changes during the offer stop frozen reconciliation before dispatch', async t => {
  const f = await fixture(t, 'npm', { choice: 'Reinstall', onPrompt: f => fs.writeFile(f.manifest, '{"name":"edited"}') });
  assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'skipped');
  assert.deepEqual(f.requests, []);
  assert.match(f.warnings.join(' '), /node_modules may not match the dependency files/);
  assert.match(f.warnings.join(' '), /npm install/);
});

for (const scenario of ['refused target', 'missing lockfile', 'changed files']) test(`pnpm ${scenario} explains manual reinstall when the offer cannot run`, async t => {
  const f = await fixture(t, 'pnpm', { choice: 'Reinstall',
    onPrompt: scenario === 'missing lockfile' ? f => fs.unlink(f.lockfile)
      : scenario === 'changed files' ? f => fs.writeFile(f.manifest, '{"name":"edited"}') : undefined,
  });
  if (scenario === 'refused target') await fs.writeFile(path.join(f.root, 'pnpm-workspace.yml'), 'packages: []');
  assert.equal(await offerFrozenReconciliation(f.journal, f.platform, f.session), 'skipped');
  assert.deepEqual(f.requests, []);
  assert.match(f.warnings.join(' '), /node_modules may not match the dependency files/);
  assert.match(f.warnings.join(' '), /pnpm install/);
});
