import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { makeCoordinator, makeProject, review, lockfile } from './helpers/removal-project.mjs';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

async function transitive(t) {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  const warnings = [];
  f.coordinator.options.platform.showWarningMessage = message => warnings.push(message);
  f.coordinator.options.platform.getSetting = (key, fallback) => key === 'security.publicAdvisoryCheck' ? false : fallback;
  f.coordinator.remediationPlans.set('plan', {
    id: 'plan', packageName: 'react', snapshot: await f.read(), before: {}, targetAdvisories: [],
    proposedLockfileText: lockfile(true).replace('18.2.0', '18.3.1'), packageManagerVersion: null, ignoreScripts: true,
    verificationScripts: [], suggestedScriptNames: [],
    plan: { automaticApplyAllowed: true, target: { resolved: [] } },
    presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
    expiresAt: Date.now() + 60_000, stale: false,
  });
  f.coordinator.session.invocationResolver = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
  return { ...f, project, warnings };
}

test('failed optional frozen reinstall preserves a validator-backed successful transitive rollback', async t => {
  const f = await transitive(t);
  f.state.installExitCode = 1;
  f.state.reinstallChoice = 'Reinstall';
  f.state.reinstallExitCode = 1;
  await f.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
  const message = f.messages.findLast(message => message.status === 'remediation-apply-result');
  assert.ok(message, JSON.stringify(f.messages));
  assert.equal(isHostToWebviewMessage(message), true);
  assert.equal(message.result.outcome, 'rolled-back');
  assert.equal(message.result.rollback, 'succeeded');
  assert.doesNotMatch(message.result.message, /Check \./);
  assert.ok(f.warnings.some(message => /reinstall.*failed/i.test(message)), JSON.stringify(f.warnings));
  assert.equal(await fs.readFile(f.project.lockfilePath, 'utf8'), lockfile(true));
  assert.equal(f.coordinator.reservation.held.state, 'retained');
  const journal = JSON.parse(await fs.readFile(path.join(f.project.root, '.packageawy-recovery/journal.json'), 'utf8'));
  assert.equal(journal.outcome, 'rolled-back');
});

test('failed optional reinstall keeps a completed recovery restore successful', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  await f.coordinator.recovery.inspect();
  await f.coordinator.recovery.start(true, f.messages.at(-1).recovery.claim);
  f.state.reinstallChoice = 'Reinstall'; f.state.reinstallExitCode = 1;
  await f.coordinator.recovery.apply(choices(f.messages.at(-1).recovery, 'restore'));
  const journal = JSON.parse(await fs.readFile(path.join(project.root, '.packageawy-recovery/journal.json'), 'utf8'));
  assert.equal(journal.outcome, 'completed');
  assert.equal(await fs.readFile(project.lockfilePath, 'utf8'), lockfile(true));
});

test('shrinkwrap introduced after transitive rollback explains manual node_modules reconciliation', async t => {
  const f = await transitive(t);
  f.state.installExitCode = 1;
  const reconcile = f.coordinator.reconcileRollback.bind(f.coordinator);
  f.coordinator.reconcileRollback = async (...args) => {
    assert.equal(args[1], 'rolled-back');
    assert.equal(await fs.readFile(f.project.lockfilePath, 'utf8'), lockfile(true));
    await fs.writeFile(path.join(f.project.root, 'npm-shrinkwrap.json'), '{}');
    return reconcile(...args);
  };
  await f.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.commands, ['ci']);
  assert.ok(f.warnings.some(message => /node_modules may not match the dependency files/.test(message) && /npm install/.test(message)), JSON.stringify(f.warnings));
  assert.equal(f.messages.findLast(message => message.status === 'remediation-apply-result').result.outcome, 'rolled-back');
});

for (const fault of ['publication', 'ownership', 'internal']) {
  test(`rollback displacement ${fault} failure propagates unknown before any ordinary rollback failure`, async t => {
    const project = await makeProject(t);
    const f = makeCoordinator(project, { mutationRoot: () => project.root });
    f.state.installExitCode = 1;
    const reserve = f.coordinator.reserve.bind(f.coordinator);
    let injected = false;
    f.coordinator.reserve = label => {
      const handle = reserve(label);
      const begin = handle.beginMutation.bind(handle);
      handle.beginMutation = async target => {
        const ok = await begin(target);
        const journal = handle.journal;
        if (fault === 'internal') {
          const replace = journal.replace.bind(journal);
          journal.replace = (...args) => { injected = true; throw new TypeError('internal displacement failure'); };
          t.after(() => { journal.replace = replace; });
        } else {
          const writeJson = journal.storage.writeJson.bind(journal.storage);
          journal.storage.writeJson = async (relative, data, ...args) => {
            if (!injected && relative === 'journal.json' && data.files.some(file => file.progress === 'displace')) {
              injected = true;
              if (fault === 'ownership') {
                await fs.writeFile(path.join(project.root, '.packageawy-recovery/owner.json'), '{}');
              } else {
                const rename = journal.storage.fs.rename;
                journal.storage.fs = { ...journal.storage.fs, async rename(source, destination) {
                  if (destination === path.join(project.root, '.packageawy-recovery/journal.json')) throw Object.assign(new Error('displacement intent EIO'), { code: 'EIO' });
                  return rename(source, destination);
                } };
              }
            }
            return writeJson(relative, data, ...args);
          };
        }
        return ok;
      };
      return handle;
    };
    await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
    assert.equal(injected, true);
    const errors = f.messages.filter(message => message.status === 'remove-error');
    assert.deepEqual(errors.map(message => message.error.code), ['OUTCOME_UNKNOWN']);
    assert.equal(f.messages.some(message => message.status === 'remove-result'), false);
    assert.equal(f.coordinator.reservation.held.state, 'unknown');
  });
}

test('EIO publishing rollback displacement intent returns unknown with the durable intent retained', async t => {
  const f = await recoveryFixture(t);
  let injected = false;
  const journal = await f.prepare({ fs: { ...fs, async rename(source, destination) {
    if (destination === path.join(f.folder, 'journal.json')) {
      const data = JSON.parse(await fs.readFile(source, 'utf8'));
      if (data.files.some(file => file.progress === 'displace')) {
        injected = true;
        throw Object.assign(new Error('displacement intent EIO'), { code: 'EIO' });
      }
    }
    return fs.rename(source, destination);
  } } });
  const result = await runUpgradeTransaction({ allowlistedPaths: f.target.allowlistedPaths, files: journal.adapter(), journal,
    install: { async execute() {
      await fs.writeFile(f.lockfile, 'installed lock');
      return { status: 'failed', code: 'FAILED', message: 'failed' };
    } },
  });
  assert.equal(injected, true);
  assert.equal(result.completion, 'unknown');
  assert.equal(result.rollback.status, 'not-needed');
  assert.equal(journal.storage.publicationFailed, true);
  const durable = JSON.parse(await fs.readFile(path.join(f.folder, 'journal.json'), 'utf8'));
  assert.equal(durable.step, 'rollback');
  assert.equal(durable.phase, 'intent');
  assert.equal(await f.read('package-lock.json'), 'installed lock');
});
