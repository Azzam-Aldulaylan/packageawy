import { withoutFsync } from './helpers/without-fsync.mjs';
withoutFsync();
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { makeCoordinator, makeProject, review, lockfile } from './helpers/removal-project.mjs';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { RecoveryCoordinator } from '../out/host/recovery/coordinator.js';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { describeRemoveTransactionOutcome, describeUpgradeTransactionOutcome } from '../out/host/upgradeAssistantOutcome.js';
import { offerFrozenReconciliation } from '../out/host/frozenReconciliation.js';
import { precheckRestore } from '../out/host/restorePrecheck.js';
import { RecoveryError } from '../out/host/recovery/model.js';

const invocation = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
const note = manager => `node_modules may not match the dependency files. To reinstall by hand, review the dependency files and run ${manager} install in the project directory.`;

async function upgrade(f) {
  const snapshot = await f.read();
  const eligibility = { packageName: 'react', currentVersion: '18.2.0', targetVersion: '18.3.0', classification: 'prod' };
  f.coordinator.options.ensureController = async () => ({ root: snapshot.root, upgradeSource: snapshot,
    validateBulkUpgradeRequest: () => ({ ok: true, upgrades: [eligibility] }) });
  f.coordinator.analysis = { id: 'upgrade', requests: [{ package: 'react', target: '18.3.0' }],
    publishedTargetsByPackage: new Map(), eligibility, snapshot, proposal: { changes: [eligibility] },
    compatibilityStatus: 'compatible', smartPlanProposal: null, security: null,
    ignoreScripts: true, verificationScripts: [], suggestedScriptNames: [], projectCompatibilityEvidenceFingerprint: null,
    expiresAt: Date.now() + 60_000 };
  return 'upgrade';
}

function failRead(journal, candidate, fault, when = () => true) {
  const read = journal.files.read.bind(journal.files);
  let injected = false;
  journal.files.read = async file => {
    if (!injected && file === candidate && when()) {
      injected = true;
      throw fault === 'TypeError' ? new TypeError('precheck bug') : Object.assign(new Error('precheck EIO'), { code: 'EIO' });
    }
    return read(file);
  };
  return () => assert.equal(injected, true, `fault reached the restore pre-check at ${journal.data.step}`);
}

for (const fault of ['EIO', 'TypeError']) {
  for (const operation of ['removal', 'upgrade']) test(`${operation} rollback pre-check ${fault} settles OUTCOME_UNKNOWN without ROLLBACK_FAILED`, async t => {
    const project = await makeProject(t);
    const f = makeCoordinator(project, { mutationRoot: () => project.root });
    f.coordinator.session.invocationResolver = invocation;
    f.state.installExitCode = 1;
    let injected;
    const reserve = f.coordinator.reserve.bind(f.coordinator);
    f.coordinator.reserve = label => {
      const handle = reserve(label);
      const begin = handle.beginMutation.bind(handle);
      handle.beginMutation = async target => {
        const ok = await begin(target);
        injected = failRead(handle.journal, project.lockfilePath, fault, () => handle.journal.data.step === 'rollback');
        return ok;
      };
      return handle;
    };
    let id;
    if (operation === 'upgrade') id = await upgrade(f);
    else {
      await f.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
      id = f.messages.findLast(message => message.status === 'remove-analysis').analysis.analysisId;
    }
    await (operation === 'upgrade' ? f.coordinator.handleConfirmUpgrade({ analysisId: id }) : f.coordinator.handleConfirmRemove({ analysisId: id }));
    assert.ok(f.messages.some(message => message.error), JSON.stringify(f.messages));
    injected();
    assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error.code), ['OUTCOME_UNKNOWN']);
    assert.equal(f.coordinator.reservation.held.state, 'unknown');
    assert.equal(JSON.parse(await fs.readFile(path.join(project.root, '.packageawy-recovery/journal.json'), 'utf8')).outcome, 'unknown');
    assert.deepEqual(await fs.readdir(path.join(project.root, '.packageawy-recovery/displaced')), []);
    assert.deepEqual(f.prompts, []);
  });

  for (const operation of ['cleanup', 'upgrade']) test(`${operation === 'cleanup' ? 'Smart Cleanup' : 'recovery'} restore pre-check ${fault} settles OUTCOME_UNKNOWN without ROLLBACK_FAILED`, async t => {
    const f = await recoveryFixture(t, { operation });
    await f.prepare();
    const messages = [];
    const locks = new ProjectMutationLocks();
    const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks,
      target: async () => f.target, post: message => messages.push(message), removed: async () => {} });
    await coordinator.start(true, null);
    const session = coordinator.session;
    const selected = choices(await session.presentation(), 'restore');
    const injected = failRead(session.inspection.journal, f.lockfile, fault);
    let caught;
    const apply = session.apply.bind(session);
    session.apply = async (...args) => { try { return await apply(...args); } catch (error) { caught = error; throw error; } };
    await coordinator.apply(selected);
    injected();
    assert.equal(caught?.code, 'OUTCOME_UNKNOWN');
    assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
    assert.equal(messages.at(-1).recovery.state, 'blocked');
    assert.equal(coordinator.session, undefined, 'unknown restore requires a fresh confirmed recovery claim');
    assert.ok(locks.holderOf(canonicalProjectRoot(f.root)), 'unknown restore retains project ownership');
    assert.equal(messages.some(message => message.error?.code === 'ROLLBACK_FAILED'), false);
    assert.deepEqual(await fs.readdir(path.join(f.folder, 'displaced')), []);
  });
}

// Inject only after the shared whole-set check has completed.
for (const fault of ['EIO', 'TypeError']) {
  for (const operation of ['cleanup', 'upgrade']) {
    for (const phase of ['repeated-check', 'swap']) test(`${operation} restore post-precheck ${phase} ${fault} fences the session as OUTCOME_UNKNOWN`, async t => {
      const f = await recoveryFixture(t, { operation });
      await f.prepare();
      await fs.writeFile(f.lockfile, 'installed lockfile');
      if (phase === 'swap') await fs.writeFile(f.manifest, 'installed manifest');
      const messages = [];
      const locks = new ProjectMutationLocks();
      const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks,
        target: async () => f.target, post: message => messages.push(message), removed: async () => {} });
      await coordinator.start(true, null);
      const session = coordinator.session;
      const selected = choices(await session.presentation(), 'restore');
      const journal = session.inspection.journal;
      let injected = false;
      const fail = () => {
        injected = true;
        throw fault === 'TypeError' ? new TypeError('restore bug') : Object.assign(new Error('restore EIO'), { code: 'EIO' });
      };
      if (phase === 'repeated-check') {
        const backupState = journal.backupState.bind(journal);
        let checks = 0;
        journal.backupState = async backup => {
          if (backup.path === 'package.json' && ++checks === 2) fail();
          return backupState(backup);
        };
      } else {
        const replace = journal.replace.bind(journal);
        journal.replace = async (...args) => {
          const read = journal.files.read.bind(journal.files);
          journal.files.read = async file => {
            if (!injected && file === f.lockfile) fail();
            return read(file);
          };
          try { return await replace(...args); }
          finally { journal.files.read = read; }
        };
      }
      let caught;
      const apply = session.apply.bind(session);
      session.apply = async (...args) => { try { return await apply(...args); } catch (error) { caught = error; throw error; } };
      await coordinator.apply(selected);
      assert.equal(injected, true);
      assert.equal(caught?.code, 'OUTCOME_UNKNOWN');
      assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
      assert.equal(messages.at(-1).recovery.state, 'blocked');
      assert.equal(coordinator.session, undefined);
      assert.ok(locks.holderOf(canonicalProjectRoot(f.root)));
      await assert.rejects(session.apply(selected), error => error.code === 'OUTCOME_UNKNOWN');
      assert.equal((await session.presentation()).canApply, false);
    });
  }

  for (const operation of ['upgrade', 'removal', 'transitive']) test(`${operation} rollback post-precheck swap ${fault} settles OUTCOME_UNKNOWN`, async t => {
    const project = await makeProject(t);
    const f = makeCoordinator(project, { mutationRoot: () => project.root });
    f.coordinator.session.invocationResolver = invocation;
    f.state.installExitCode = 1;
    let injected;
    const reserve = f.coordinator.reserve.bind(f.coordinator);
    f.coordinator.reserve = label => {
      const handle = reserve(label);
      const begin = handle.beginMutation.bind(handle);
      handle.beginMutation = async target => {
        const ok = await begin(target);
        const journal = handle.journal;
        const replace = journal.replace.bind(journal);
        journal.replace = async (...args) => {
          injected = failRead(journal, project.lockfilePath, fault);
          return replace(...args);
        };
        return ok;
      };
      return handle;
    };
    if (operation === 'upgrade') await f.coordinator.handleConfirmUpgrade({ analysisId: await upgrade(f) });
    else if (operation === 'removal') await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
    else {
      f.coordinator.options.platform.getSetting = (key, fallback) => key === 'security.publicAdvisoryCheck' ? false : fallback;
      f.coordinator.remediationPlans.set('plan', {
        id: 'plan', packageName: 'react', snapshot: await f.read(), before: {}, targetAdvisories: [],
        proposedLockfileText: lockfile(true).replace('18.2.0', '18.3.1'), packageManagerVersion: null, ignoreScripts: true,
        verificationScripts: [], suggestedScriptNames: [],
        plan: { automaticApplyAllowed: true, target: { resolved: [] } },
        presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
        expiresAt: Date.now() + 60_000, stale: false,
      });
      await f.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
    }
    injected();
    assert.deepEqual(f.messages.filter(message => message.error).map(message => message.error.code), ['OUTCOME_UNKNOWN']);
    assert.equal(f.coordinator.reservation.held.state, 'unknown');
    assert.equal(JSON.parse(await fs.readFile(path.join(project.root, '.packageawy-recovery/journal.json'), 'utf8')).outcome, 'unknown');
    assert.deepEqual(f.prompts, []);
  });
}

for (const phase of ['ownership', 'journal-save', 'completion']) test(`recovery post-precheck ${phase} errors stay unknown`, async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  const session = await f.open();
  const selected = choices(await session.presentation(), 'keep');
  const journal = session.inspection.journal;
  let injected = false;
  if (phase === 'ownership') {
    const backupState = journal.backupState.bind(journal);
    let checks = 0;
    journal.backupState = async backup => {
      const state = await backupState(backup);
      if (++checks === journal.data.files.length) {
        injected = true;
        await fs.writeFile(path.join(f.folder, 'owner.json'), '{}');
      }
      return state;
    };
  } else if (phase === 'journal-save') {
    const save = journal.save.bind(journal);
    journal.save = async (...args) => {
      if (!injected && journal.data.files.some(file => file.progress === 'keep')) {
        injected = true;
        throw new RecoveryError('journal publication error');
      }
      return save(...args);
    };
  } else {
    const record = journal.record.bind(journal);
    journal.record = async (...args) => {
      if (args[0] === 'recovery-completion') {
        injected = true;
        throw new RecoveryError('completion error');
      }
      return record(...args);
    };
  }
  await assert.rejects(session.apply(selected), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(injected, true);
  assert.equal(journal.data.outcome, 'unknown');
  assert.throws(() => journal.assertWritable());
  await assert.rejects(session.apply(selected), error => error.code === 'OUTCOME_UNKNOWN');
  assert.ok(await fs.stat(path.join(f.folder, 'journal.json')));
});

for (const known of ['conflict', 'rename-failure']) test(`recovery post-precheck observed ${known} stays incomplete and retryable`, async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await fs.writeFile(f.lockfile, 'installed lockfile');
  const session = await f.open();
  const selected = choices(await session.presentation(), 'restore');
  const journal = session.inspection.journal;
  if (known === 'conflict') {
    const backupState = journal.backupState.bind(journal);
    let checks = 0;
    journal.backupState = async backup => {
      const state = await backupState(backup);
      if (++checks === journal.data.files.length) await fs.writeFile(f.lockfile, 'outside edit');
      return state;
    };
  } else {
    journal.storage.fs = { ...fs, async rename(source, destination) {
      if (source === f.lockfile) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      return fs.rename(source, destination);
    } };
  }
  await assert.rejects(session.apply(selected), error => error.code !== 'OUTCOME_UNKNOWN');
  assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
  assert.equal(journal.storage.publicationFailed, false);
  assert.equal((await session.presentation()).canApply, true);
});

for (const manager of ['npm', 'pnpm']) {
  for (const status of ['conflict', 'failed', 'not-needed']) {
    for (const operation of ['upgrade', 'removal']) test(`${manager} ${operation} ${status} incomplete result includes the shared manual note`, () => {
      const transaction = { completion: 'incomplete', reason: 'install-failed',
        rollback: status === 'not-needed' ? { status } : { status, files: [{ path: '/project/package.json', status }] } };
      const result = operation === 'upgrade' ? describeUpgradeTransactionOutcome('react', manager, transaction)
        : describeRemoveTransactionOutcome(['react'], manager, transaction);
      assert.ok(result.error.message.endsWith(note(manager)), result.error.message);
    });
  }

  for (const operation of ['cleanup', 'upgrade']) test(`${manager} ${operation === 'cleanup' ? 'Smart Cleanup' : 'recovery'} conflicted restore and reopened incomplete result include the shared manual note`, async t => {
    const f = await recoveryFixture(t, { operation });
    if (manager === 'pnpm') {
      await fs.rename(f.lockfile, path.join(f.root, 'pnpm-lock.yaml'));
      f.lockfile = path.join(f.root, 'pnpm-lock.yaml');
      f.target.allowlistedPaths = [f.manifest, f.lockfile];
    }
    await f.prepare();
    const session = await f.open();
    const selected = choices(await session.presentation(), 'restore');
    await fs.writeFile(f.lockfile, 'outside edit');
    await assert.rejects(session.apply(selected), error => {
      assert.ok(error.message.endsWith(note(manager)), error.message);
      return true;
    });
    const view = (await f.inspect()).view;
    assert.equal(view.state, 'incomplete');
    assert.ok(view.message.endsWith(note(manager)), view.message);
  });

  for (const operation of ['cleanup', 'upgrade']) test(`${manager} ${operation === 'cleanup' ? 'Smart Cleanup' : 'recovery'} failed restore result includes the shared manual note`, async t => {
    const f = await recoveryFixture(t, { operation });
    if (manager === 'pnpm') {
      await fs.rename(f.lockfile, path.join(f.root, 'pnpm-lock.yaml'));
      f.lockfile = path.join(f.root, 'pnpm-lock.yaml');
      f.target.allowlistedPaths = [f.manifest, f.lockfile];
    }
    await f.prepare();
    await fs.writeFile(f.lockfile, 'installed bytes');
    const session = await f.open({ fs: { ...fs, async rename(source, destination) {
      if (source === f.lockfile) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      return fs.rename(source, destination);
    } } });
    const messages = [];
    const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks: new ProjectMutationLocks(),
      target: async () => f.target, post: message => messages.push(message), removed: async () => {} });
    coordinator.session = session;
    await coordinator.apply(choices(await session.presentation(), 'restore'));
    assert.equal(messages.at(-1).recovery.state, 'incomplete');
    assert.ok(messages.at(-1).recovery.message.endsWith(note(manager)), messages.at(-1).recovery.message);
  });

  test(`${manager} unavailable frozen offer uses the identical manual note`, async t => {
    const f = await recoveryFixture(t, { absent: true });
    if (manager === 'pnpm') f.target.allowlistedPaths = [f.manifest, path.join(f.root, 'pnpm-lock.yaml')];
    const journal = await f.prepare();
    const warnings = [];
    assert.equal(await offerFrozenReconciliation(journal, { showWarningMessage: message => warnings.push(message) }, {}), 'skipped');
    assert.ok(warnings[0].endsWith(note(manager)), warnings[0]);
  });

  test(`${manager} partial recovery result includes the shared manual note`, async t => {
    const f = await recoveryFixture(t);
    if (manager === 'pnpm') {
      await fs.rename(f.lockfile, path.join(f.root, 'pnpm-lock.yaml'));
      f.lockfile = path.join(f.root, 'pnpm-lock.yaml');
      f.target.allowlistedPaths = [f.manifest, f.lockfile];
    }
    const journal = await f.prepare();
    journal.data.files[1].backup.path = '../outside.json';
    await journal.save();
    const session = await f.open();
    await session.apply(choices(await session.presentation(), 'restore'));
    assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
    const view = await session.presentation();
    assert.ok(view.message.endsWith(note(manager)), view.message);
  });
}

test('pre-check preserves ownership, journal absence and internal exceptions without converting them to conflicts', async () => {
  for (const error of [new RecoveryError('owner changed'), Object.assign(new Error('journal missing'), { code: 'ENOENT' }), new TypeError('bug')]) {
    await assert.rejects(precheckRestore([{ path: 'package.json', check: async () => { throw error; } }]), cause => cause === error);
  }
});

test('typed missing dependency-file state is an observed conflict before any swap', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  const session = await f.open();
  const selected = choices(await session.presentation(), 'restore');
  await fs.unlink(f.lockfile);
  await assert.rejects(session.apply(selected), /Dependency file changed: package-lock.json/);
  assert.equal((await f.inspect()).journal.data.outcome, 'recovery-incomplete');
  assert.deepEqual(await fs.readdir(path.join(f.folder, 'displaced')), []);
});

for (const status of ['conflict', 'failed']) test(`transitive ${status} incomplete result includes the shared manual note`, async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.coordinator.options.platform.getSetting = (key, fallback) => key === 'security.publicAdvisoryCheck' ? false : fallback;
  f.coordinator.remediationPlans.set('plan', {
    id: 'plan', packageName: 'react', snapshot: await f.read(), before: {}, targetAdvisories: [],
    proposedLockfileText: lockfile(true).replace('18.2.0', '18.3.1'), packageManagerVersion: null, ignoreScripts: true,
    verificationScripts: [], suggestedScriptNames: [],
    plan: { automaticApplyAllowed: true, target: { resolved: [] } },
    presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
    expiresAt: Date.now() + 60_000, stale: false,
  });
  f.coordinator.session.invocationResolver = invocation;
  f.state.installExitCode = 1;
  const reconcile = f.coordinator.reconcileRollback.bind(f.coordinator);
  f.coordinator.reconcileRollback = async (handle, completion) => {
    assert.equal(completion, 'incomplete');
    return reconcile(handle, completion);
  };
  const reserve = f.coordinator.reserve.bind(f.coordinator);
  f.coordinator.reserve = label => {
    const handle = reserve(label);
    const begin = handle.beginMutation.bind(handle);
    handle.beginMutation = async target => {
      const ok = await begin(target);
      const replace = handle.journal.replace.bind(handle.journal);
      handle.journal.replace = async (...args) => {
        if (status === 'conflict') return 'conflict';
        const { RestoreFileError } = await import('../out/host/upgradeTransaction.js');
        throw new RestoreFileError(new Error('move refused'));
      };
      t.after(() => { handle.journal.replace = replace; });
      return ok;
    };
    return handle;
  };
  await f.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
  const result = f.messages.findLast(message => message.status === 'remediation-apply-result')?.result;
  assert.equal(result?.outcome, 'recovery-required', JSON.stringify(f.messages));
  assert.equal(result.rollback, status);
  assert.ok(result.message.endsWith(note('npm')), result.message);
  assert.deepEqual(f.prompts, []);
});

test('Smart Cleanup removal rollback conflict includes the shared manual note', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.state.installExitCode = 1;
  f.state.holdInstall = () => fs.writeFile(project.manifestPath, '{"name":"outside edit"}');
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  const error = f.messages.findLast(message => message.status === 'remove-error').error;
  assert.equal(error.code, 'ROLLBACK_CONFLICT');
  assert.ok(error.message.endsWith(note('npm')), error.message);
  assert.deepEqual(f.prompts, []);
});
