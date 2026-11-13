import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeCoordinator, makeProject, review, blocker, MANIFEST, lockfile } from './helpers/removal-project.mjs';
import { recoveryFixture } from './helpers/recovery.mjs';
import { OperationReservation } from '../out/host/operationReservation.js';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { runUpgradeTransaction } from '../out/host/upgradeTransaction.js';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';

const execFileAsync = promisify(execFile);

const invocation = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });

function owner(target) {
  const locks = new ProjectMutationLocks();
  const releases = [];
  const reservation = new OperationReservation({ locks, reserve: () => true, release: () => releases.push('release'),
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  return { locks, releases, reservation, handle: reservation.reserve('change', target.root) };
}

async function assertUnknown(fixture, project, status = 'remove-error') {
  const handle = fixture.coordinator.reservation.held;
  assert.equal(handle?.state, 'unknown');
  const journal = JSON.parse(await readFile(`${project.root}/.packageawy-recovery/journal.json`, 'utf8'));
  assert.equal(journal.outcome, 'unknown');
  assert.equal(fixture.coordinator.isMutationBusy(), true);
  assert.equal(fixture.coordinator.reservation.locks.holderOf(canonicalProjectRoot(project.root)), handle);
  if (status !== null) assert.equal(fixture.messages.some(message => message.status === status && message.error.code === 'OUTCOME_UNKNOWN'), true);
  assert.equal(fixture.messages.some(message => message.status === 'recovery' && message.recovery.state === 'blocked'), true);
  assert.equal(fixture.messages.some(message => message.status === 'remove-result' || message.status === 'upgrade-result' || message.status === 'remediation-apply-result'), false);
  assert.equal(await handle.complete('kept'), false);
  assert.equal(await handle.releaseReadOnly(), false);
}

for (const phase of ['snapshot', 'manifest-stage', 'file-stage', 'install', 'verification', 'decision', 'rollback']) {
  test(`internal throw during ${phase} after preparation stays unknown without restoration`, async t => {
    const f = await recoveryFixture(t);
    const o = owner(f.target);
    assert.equal(await o.handle.beginMutation(f.target), true);
    const journal = o.handle.journal;
    const adapter = journal.adapter();
    let installs = 0;
    const fail = () => { throw new TypeError(`internal ${phase}`); };
    const result = await runUpgradeTransaction({ journal, allowlistedPaths: f.target.allowlistedPaths,
      files: { read: phase === 'snapshot' ? fail : adapter.read,
        compareAndSwap: phase === 'manifest-stage' || phase === 'file-stage' ? fail : adapter.compareAndSwap },
      ...(phase === 'manifest-stage' ? { manifestStage: { path: f.manifest, expectedContents: await readFile(f.manifest), contents: Buffer.from('staged') } } : {}),
      ...(phase === 'file-stage' ? { fileStages: [{ path: f.lockfile, expectedContents: await readFile(f.lockfile), contents: Buffer.from('staged') }] } : {}),
      install: { execute: async () => {
        installs++;
        await writeFile(f.lockfile, 'installed');
        if (phase === 'install') fail();
        return { status: 'succeeded' };
      } },
      verifier: { verify: async () => {
        if (phase === 'verification') fail();
        return phase === 'decision' || phase === 'rollback' ? { status: 'failed', checks: [] } : { status: 'passed', checks: [] };
      } },
      verificationFailureDecider: { decide: phase === 'decision' ? fail : async () => 'rollback' },
      beforeRestore: phase === 'rollback' ? fail : undefined,
    });
    assert.equal(result.completion, 'unknown');
    assert.equal(result.rollback.status, 'not-needed');
    await o.handle.complete(result.completion);
    assert.equal(o.handle.state, 'unknown');
    assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
    assert.deepEqual(o.releases, []);
    assert.equal(installs, ['snapshot', 'manifest-stage', 'file-stage'].includes(phase) ? 0 : 1);
    if (installs) assert.equal(await f.read('package-lock.json'), 'installed');
  });
}

test('an internal throw before preparation reports a normal failure and releases', async t => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const id = await review(fixture);
  fixture.coordinator.projectLoader = async () => { throw new TypeError('preflight bug'); };
  await fixture.coordinator.handleConfirmRemove({ analysisId: id });
  assert.equal(fixture.coordinator.reservation.held, undefined);
  assert.equal(fixture.coordinator.isBusy(), false);
  assert.equal(fixture.messages.at(-1).error.code, 'TypeError');
  assert.equal(await readFile(project.manifestPath, 'utf8'), MANIFEST);
  await assert.rejects(readFile(`${project.root}/.packageawy-recovery/journal.json`), { code: 'ENOENT' });
});

for (const phase of ['preparing', 'install', 'verification']) test(`Smart Cleanup internal ${phase} failure settles the real owner as unknown`, async t => {
  const project = await makeProject(t);
  let fixture;
  fixture = makeCoordinator(project, {
    mutationRoot: () => project.root,
    sink: { postMessage(message) {
      fixture.messages.push(message);
    } },
  });
  const id = await review(fixture);
  fixture.coordinator.session.invocationResolver = invocation;
  if (phase === 'preparing') {
    const reserve = fixture.coordinator.reserve.bind(fixture.coordinator);
    fixture.coordinator.reserve = label => {
      const handle = reserve(label);
      const begin = handle.beginMutation.bind(handle);
      handle.beginMutation = async target => { await begin(target); throw new TypeError('prepared boundary bug'); };
      return handle;
    };
  }
  if (phase === 'install') fixture.coordinator.session.prepareManifestReconciliation = () => ({ ok: true, execute: async () => { throw new TypeError('reconciliation bug'); } });
  if (phase === 'verification') {
    const run = fixture.coordinator.options.platform.runProcess;
    fixture.coordinator.options.platform.runProcess = async request => {
      const result = await run(request);
      // Exercise the caught graph verifier, after a successful task result.
      await writeFile(project.lockfilePath, '{');
      return result;
    };
  }
  await fixture.coordinator.handleConfirmRemove({ analysisId: id });
  await assertUnknown(fixture, project);
});

test('generic removal final refresh failure preserves the known removal', async t => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project, { mutationRoot: () => project.root,
    reloadFinalState: async () => { throw new TypeError('reload bug'); } });
  fixture.coordinator.session.invocationResolver = invocation;
  await fixture.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const id = fixture.messages.findLast(message => message.status === 'remove-analysis').analysis.analysisId;
  await fixture.coordinator.handleConfirmRemove({ analysisId: id });
  assert.equal(fixture.coordinator.reservation.held, undefined);
  assert.equal(fixture.messages.findLast(message => message.status === 'remove-result').result.outcome, 'verified');
  assert.equal(fixture.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
});

async function upgrade(fixture) {
  const snapshot = await fixture.read();
  const eligibility = { packageName: 'react', currentVersion: '18.2.0', targetVersion: '18.3.0', classification: 'prod' };
  fixture.coordinator.options.ensureController = async () => ({ root: snapshot.root, upgradeSource: snapshot,
    validateBulkUpgradeRequest: () => ({ ok: true, upgrades: [eligibility] }) });
  fixture.coordinator.analysis = { id: 'upgrade', requests: [{ package: 'react', target: '18.3.0' }],
    publishedTargetsByPackage: new Map(), eligibility, snapshot, proposal: { changes: [eligibility] },
    compatibilityStatus: 'compatible', smartPlanProposal: null, security: null,
    ignoreScripts: true, verificationScripts: [], suggestedScriptNames: [], projectCompatibilityEvidenceFingerprint: null,
    expiresAt: Date.now() + 60_000 };
  fixture.coordinator.session.invocationResolver = invocation;
}

test('upgrade final-state presentation failure preserves its known install', async t => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project, { mutationRoot: () => project.root });
  await upgrade(fixture);
  let loads = 0;
  fixture.coordinator.projectLoader = async () => { if (++loads > 1) throw new TypeError('read bug'); return fixture.read(); };
  await fixture.coordinator.handleConfirmUpgrade({ analysisId: 'upgrade' });
  assert.equal(fixture.coordinator.reservation.held, undefined);
  assert.equal(fixture.messages.findLast(message => message.status === 'upgrade-result').result.install, 'succeeded');
  assert.equal(fixture.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
});

// Fatal handlers permanently close admission, so each scenario needs its own process.
for (const context of ['unhandled-rejection', 'uncaught-exception']) test(`${context} fences a detached writer, notifies the client and ignores late success`, async () => {
  await execFileAsync(process.execPath, ['test/helpers/sidecar-failure-probe.mjs', context, 'detached']);
});

test('session disposal settles its task as unknown without releasing the owner slot', async () => {
  let started;
  const arrived = new Promise(resolve => { started = resolve; });
  const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true,
    runProcess: async () => ({ onDidExit() { started(); return { dispose() {} }; } }),
  }, invocation);
  session.reserve('change');
  const running = (await session.prepareManifestReconciliation({ cwd: '/fixture', ignoreScripts: true, packageManager: 'npm' })).execute();
  await arrived;
  session.dispose();
  assert.equal((await running).status, 'unknown');
  assert.equal(session.isBusy(), true);
  session.release('change');
  assert.equal(session.isBusy(), false);
});

test('mutation exits use explicit completion and teardown cannot clear ownership', () => {
  for (const file of ['upgradeAssistantCoordinator', 'upgradeRunner', 'upgradeTracker']) {
    const source = readFileSync(`src/host/${file}.ts`, 'utf8');
    assert.doesNotMatch(source, /this\.lock\.clear\(/);
    assert.doesNotMatch(source, /finally\s*\{\s*(?:await\s+)?(?:this\.)?(?:session|handle|reservation)\.(?:release|releaseReadOnly)\(/);
  }
});

for (const phase of ['preparing', 'apply', 'security-verification', 'reconciliation']) test(`transitive fix internal ${phase} failure keeps its prepared journal`, async t => {
  const project = await makeProject(t);
  let fixture;
  fixture = makeCoordinator(project, { mutationRoot: () => project.root,
    sink: { postMessage(message) {
      if (phase === 'preparing' && message.status === 'remediation-applying' && message.phase === 'preparing') throw new TypeError('preparation bug');
      fixture.messages.push(message);
    } },
  });
  const snapshot = await fixture.read();
  fixture.coordinator.remediationPlans.set('plan', {
    id: 'plan', packageName: 'react', snapshot, before: {}, targetAdvisories: [],
    proposedLockfileText: lockfile(true).replace('18.2.0', '18.3.1'), packageManagerVersion: null, ignoreScripts: true,
    verificationScripts: [], suggestedScriptNames: [],
    plan: { automaticApplyAllowed: true, target: { resolved: [] } },
    presentation: { resolvedAdvisories: [], remainingAdvisories: [], verification: {} },
    expiresAt: Date.now() + 60_000, stale: false,
  });
  fixture.coordinator.session.invocationResolver = invocation;
  if (phase === 'apply') {
    fixture.coordinator.session.prepareLockfileReconciliation = () => ({ ok: true, execute: async () => { throw new TypeError('apply bug'); } });
  }
  let reconciliations = 0;
  if (phase === 'reconciliation') {
    fixture.state.reinstallChoice = 'Reinstall';
    fixture.coordinator.options.platform.getSetting = (key, fallback) => key === 'security.publicAdvisoryCheck' ? false : fallback;
    fixture.coordinator.session.prepareLockfileReconciliation = () => ({ ok: true, execute: async () => {
      if (++reconciliations > 1) throw new TypeError('restored tree reconciliation bug');
      return { ok: true };
    } });
  }
  if (phase === 'security-verification') {
    let loads = 0;
    fixture.coordinator.projectLoader = async () => { if (++loads > 1) throw new TypeError('verifier bug'); return fixture.read(); };
  }
  await fixture.coordinator.handleConfirmRemediation({ analysisId: 'plan' });
  await assertUnknown(fixture, project, 'remediation-error');
  if (phase === 'reconciliation') {
    assert.equal(reconciliations, 2, 'the fault is after a known successful rollback');
    assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  }
});


for (const boundary of ['journal:completion:finished', 'removal:1']) test(`failure during ${boundary} fences an in-flight known settlement`, async t => {
  const f = await recoveryFixture(t, { operation: boundary === 'journal:completion:finished' ? 'cleanup' : 'upgrade' });
  const hold = blocker();
  t.after(() => hold.release());
  const journal = await f.prepare({ boundary: async name => { if (name === boundary) await hold.wait(); } });
  const o = owner(f.target);
  o.handle.journal = journal;
  o.handle.state = 'mutating';
  const completing = o.handle.complete('kept');
  await hold.arrived;
  await o.handle.fail('internal settlement failure');
  hold.release();
  assert.equal(await completing, false);
  assert.equal(o.handle.state, 'unknown');
  assert.equal(o.handle.result, 'unknown');
  assert.equal((await f.inspect()).journal.data.outcome, 'unknown');
  assert.deepEqual(o.releases, []);
  await assert.rejects(journal.record('late-result', 'finished'));
});
