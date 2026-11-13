import { withoutFsync } from './helpers/without-fsync.mjs';
withoutFsync();
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { makeCoordinator, makeProject, review } from './helpers/removal-project.mjs';

async function fileIdentity(file) {
  // Node exposes the Windows file ID as ino. BigInt avoids rounding 64-bit IDs.
  const { dev, ino } = await fs.stat(file, { bigint: true });
  assert.ok(ino > 0n, 'the filesystem must provide a real file identity');
  return { dev, ino };
}

for (const operation of ['upgrade', 'removal']) {
  test(`${operation} rollback pre-check names a late conflict before touching any file`, async t => {
    const f = await recoveryFixture(t, { operation });
    const journal = await f.prepare();
    const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(), journal,
      install: { async execute() {
        await fs.writeFile(f.manifest, 'installed manifest'); await fs.writeFile(f.lockfile, 'installed lock');
        return { status: 'failed', code: 'FAILED', message: 'failed' };
      } },
      beforeRestore: async () => { await fs.writeFile(f.lockfile, 'outside edit'); return null; },
    });
    assert.equal(result.completion, 'incomplete');
    assert.equal(result.rollback.status, 'conflict');
    assert.equal(result.rollback.files[0].path, f.lockfile);
    assert.match(result.rollback.files[0].message, /package-lock.json/);
    assert.equal(await f.read('package.json'), 'installed manifest');
    assert.equal(await f.read('package-lock.json'), 'outside edit');
    assert.deepEqual(await fs.readdir(path.join(f.folder, 'displaced')), []);
  });

  for (const platform of [process.platform, ...(process.platform === 'win32' ? [] : ['win32'])]) {
    test(`${operation} rollback preserves actual displaced file identity and retains an incomplete second swap (${platform})`, async t => {
      const f = await recoveryFixture(t, { operation });
      let hits = 0;
      const journal = await f.prepare({ platform, fs: { ...fs, async rename(source, dest) {
        if (source === f.lockfile && path.dirname(dest) === path.join(f.folder, 'displaced')) {
          hits++;
          throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
        }
        return fs.rename(source, dest);
      } } });
      let identity;
      const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(), journal,
        install: { async execute() {
          await fs.writeFile(f.manifest, 'installed manifest'); await fs.writeFile(f.lockfile, 'installed lock');
          identity = await fileIdentity(f.manifest);
          return { status: 'failed', code: 'FAILED', message: 'failed' };
        } },
      });
      assert.equal(hits, 1, 'the second displacement rename must reach the injected fault');
      assert.equal(result.completion, 'incomplete');
      assert.equal(result.rollback.status, 'failed');
      assert.match(result.rollback.files.at(-1).message, /sharing violation/);
      assert.equal(await journal.finish('incomplete'), false);
      assert.equal((await f.inspect()).journal.data.outcome, 'rollback-incomplete');
      const displaced = path.join(f.folder, 'displaced', `${journal.data.files[0].displacedIds[0]}.bin`);
      assert.deepEqual(await fileIdentity(displaced), identity);
      assert.notDeepEqual(await fileIdentity(f.manifest), identity, 'replacement must be a different file');
      assert.equal(await fs.readFile(displaced, 'utf8'), 'installed manifest');
      assert.equal(await f.read('package-lock.json'), 'installed lock', 'failed rename must prevent replacement without a copy fallback');
    });
  }
}

for (const operation of ['upgrade', 'cleanup']) {
  test(`${operation === 'cleanup' ? 'Smart Cleanup' : 'recovery'} restore pre-check stops all swaps and names the changed file`, async t => {
    const f = await recoveryFixture(t, { operation });
    await f.prepare();
    await fs.writeFile(f.manifest, 'current manifest'); await fs.writeFile(f.lockfile, 'current lock');
    const session = await f.open(); const view = await session.presentation();
    await fs.writeFile(f.lockfile, 'outside edit');
    await assert.rejects(session.apply(choices(view, 'restore')), /package-lock.json/);
    assert.equal(await f.read('package.json'), 'current manifest');
    assert.deepEqual(await fs.readdir(path.join(f.folder, 'displaced')), []);
    assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
  });

  for (const platform of [process.platform, ...(process.platform === 'win32' ? [] : ['win32'])]) {
    test(`${operation === 'cleanup' ? 'Smart Cleanup' : 'recovery'} restore uses rename displacement and keeps it after a later rename fails (${platform})`, async t => {
      const f = await recoveryFixture(t, { operation });
      await f.prepare();
      await fs.writeFile(f.manifest, 'current manifest'); await fs.writeFile(f.lockfile, 'current lock');
      const identity = await fileIdentity(f.manifest);
      let hits = 0;
      const session = await f.open({ platform, fs: { ...fs, async rename(source, dest) {
        if (source === f.lockfile && path.dirname(dest) === path.join(f.folder, 'displaced')) {
          hits++;
          throw Object.assign(new Error('rename refused'), { code: 'EPERM' });
        }
        return fs.rename(source, dest);
      } } });
      const view = await session.presentation();
      await assert.rejects(session.apply(choices(view, 'restore')), /rename refused/);
      assert.equal(hits, 1, 'the second displacement rename must reach the injected fault');
      const file = session.inspection.journal.data.files[0];
      const displaced = path.join(f.folder, 'displaced', `${file.displacedIds[0]}.bin`);
      assert.deepEqual(await fileIdentity(displaced), identity);
      assert.equal(await fs.readFile(displaced, 'utf8'), 'current manifest');
      assert.notDeepEqual(await fileIdentity(f.manifest), identity, 'replacement must be a different file');
      assert.equal(await f.read('package-lock.json'), 'current lock');
      assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
    });
  }
}

test('Smart Cleanup recovery offers frozen reinstall only after a successful restore and uses the held owner', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  const analysisId = await review(f);
  await f.coordinator.handleConfirmRemove({ analysisId });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  f.state.reinstallChoice = 'Reinstall';
  await f.coordinator.recovery.apply(choices(f.messages.at(-1).recovery, 'restore'));
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.commands, ['install', 'ci']);
  assert.equal(f.requests.at(-1).cwd, project.root);
  assert.equal(f.coordinator.isMutationBusy(), true, 'restoration and reinstall keep recovery ownership until dismissal');
});

test('Smart Cleanup conflict never offers reinstall', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  const selected = choices(f.messages.at(-1).recovery, 'restore');
  await fs.writeFile(project.lockfilePath, 'outside edit');
  await f.coordinator.recovery.apply(selected);
  assert.deepEqual(f.prompts, []);
  assert.match(f.messages.at(-1).recovery.message, /package-lock.json/);
  assert.deepEqual(f.commands, ['install']);
});

for (const accept of [false, true]) test(`removal rollback ${accept ? 'runs' : 'skips'} frozen reinstall only after successful file restoration`, async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.state.installExitCode = 1;
  f.state.reinstallChoice = accept ? 'Reinstall' : 'Skip';
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.commands, accept ? ['install', 'ci'] : ['install']);
  assert.equal(f.coordinator.reservation.held.state, 'retained');
  assert.equal(f.messages.findLast(message => message.status === 'remove-result').result.outcome, 'rolled-back');
});

test('removal rollback with a pre-check conflict never offers reinstall', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.state.installExitCode = 1;
  f.state.holdInstall = () => fs.writeFile(project.manifestPath, '{"name":"outside edit"}');
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.commands, ['install']);
  assert.match(f.messages.findLast(message => message.status === 'remove-error').error.message, /package.json/);
});

test('unknown reinstall after removal rollback posts no known terminal result and retains ownership', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.state.installExitCode = 1; f.state.reinstallChoice = 'Reinstall'; f.state.reinstallUnknown = true;
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  assert.equal(f.coordinator.reservation.held.state, 'unknown');
  assert.equal(f.messages.some(message => message.status === 'remove-result'), false);
  assert.equal(f.messages.findLast(message => message.status === 'remove-error').error.code, 'OUTCOME_UNKNOWN');
});

test('unknown frozen reinstall during recovery keeps the claim and requires fresh confirmed recovery', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  f.state.reinstallChoice = 'Reinstall'; f.state.reinstallUnknown = true;
  await f.coordinator.recovery.apply(choices(f.messages.at(-1).recovery, 'restore'));
  assert.equal(f.coordinator.isMutationBusy(), true);
  assert.equal(f.messages.at(-1).recovery.state, 'blocked');
  const journal = JSON.parse(await fs.readFile(path.join(project.root, '.packageawy-recovery/journal.json'), 'utf8'));
  assert.equal(journal.outcome, 'unknown');
  assert.ok(journal.claimToken);
  await f.coordinator.recovery.dismiss(true, true);
  assert.ok(await fs.stat(path.join(project.root, '.packageawy-recovery')));
});

test('recovery Keep current does not offer a reinstall', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  await f.coordinator.recovery.apply(choices(f.messages.at(-1).recovery));
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.commands, ['install']);
});

test('partial recovery with an unsafe omitted file never offers reinstall', async t => {
  const f = await recoveryFixture(t);
  const journal = await f.prepare();
  journal.data.files[1].backup.path = '../outside.json';
  await journal.save();
  const { RecoveryCoordinator } = await import('../out/host/recovery/coordinator.js');
  const { ProjectMutationLocks } = await import('../out/host/projectMutationLock.js');
  const messages = []; let offers = 0;
  const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks: new ProjectMutationLocks(),
    target: async () => f.target, post: message => messages.push(message), removed: async () => {},
    restored: async () => { offers++; return 'skipped'; },
  });
  await coordinator.inspect();
  await coordinator.start(true, messages.at(-1).recovery.claim);
  await coordinator.apply(choices(messages.at(-1).recovery, 'restore'));
  assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
  assert.equal(offers, 0);
});

test('a recovery frozen reinstall is untimed and shares Still running with a reopened panel', async t => {
  const { blocker } = await import('./helpers/removal-project.mjs');
  const { STILL_RUNNING_THRESHOLD_MS } = await import('../out/host/upgradeRunner.js');
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  const hold = blocker();
  f.state.reinstallChoice = 'Reinstall'; f.state.holdReinstall = hold.wait;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const applying = f.coordinator.recovery.apply(choices(f.messages.at(-1).recovery, 'restore'));
  await hold.arrived;
  t.mock.timers.tick(STILL_RUNNING_THRESHOLD_MS * 10);
  const reopened = makeCoordinator(project, { mutationRoot: () => project.root });
  await reopened.coordinator.recovery.inspect();
  assert.equal(reopened.messages.findLast(message => message.status === 'dependency-task').state, 'still-running');
  assert.equal(reopened.messages.at(-1).recovery.state, 'running');
  assert.equal(f.requests.at(-1).timeoutMs, undefined);
  assert.equal(f.coordinator.isMutationBusy(), true);
  hold.release(); await applying;
  assert.equal(f.messages.findLast(message => message.status === 'dependency-task').state, 'idle');
  assert.equal(f.messages.at(-1).recovery.canApply, false);
});
