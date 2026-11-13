import assert from 'node:assert/strict';
import { test } from 'node:test';
import io from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { panel, until } from './helpers/dashboard-startup.mjs';
import { lockfile } from './helpers/removal-project.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { createTransitiveRemediationPlan } from '../out/core/advisories/transitiveRemediationPlan.js';

withoutFsync();
const codes = ['EMFILE', 'EINVAL', 'UNKNOWN', 'EBUSY', 'ENAMETOOLONG', 'ENETUNREACH'];

async function completedFixture(t, operation, mode = 'local') {
  const f = await rollbackFixture(t, operation === 'reinstall' ? 'upgrade' : operation);
  if (operation !== 'reinstall') f.state.installExitCode = 0;
  if (operation === 'transitive') {
    const before = JSON.parse(lockfile(true));
    before.packages['node_modules/react'].dependencies = { leaf: '*' };
    before.packages['node_modules/leaf'] = { version: '1.0.0' };
    await io.writeFile(f.project.lockfilePath, JSON.stringify(before));
    const stored = f.coordinator.remediationPlans.get('plan');
    stored.snapshot = await f.read();
    const graph = text => buildDependencyGraph({ root: f.project.root, manifest: parseManifest(stored.snapshot.manifestText), lockfileText: text, packageManager: 'npm', importerId: '.' });
    const advisory = { id: 'GHSA-AAAA-BBBB-CCCC', severity: 'high', title: 'Fixture issue', vulnerableVersions: '<2.0.0', url: 'https://example.com/issue' };
    stored.before = { graph: graph(stored.snapshot.lockfileText), advisoriesByName: new Map([['leaf', [advisory]]]), advisories: 'complete' };
    before.packages['node_modules/leaf'].version = '2.0.0';
    stored.proposedLockfileText = JSON.stringify(before);
    stored.targetAdvisories = [{ advisory, flaggedPackage: 'leaf', path: ['react', 'leaf'], flaggedVersion: '1.0.0', patchedVersion: { status: 'known', version: '2.0.0' } }];
    stored.plan = createTransitiveRemediationPlan({ rootPackageName: 'react', targetAdvisories: stored.targetAdvisories, before: stored.before,
      after: { graph: graph(stored.proposedLockfileText), advisoriesByName: new Map(), advisories: 'complete' }, manifestUnchanged: true });
    assert.equal(stored.plan.automaticApplyAllowed, true);
    f.coordinator.options.platform.getSetting = (_key, fallback) => fallback;
    f.coordinator.options.httpClient.post = async () => ({ status: 200, headers: {}, body: '{}' });
  }
  // The upgrade installs the reviewed version. Removal's shared fake removes react.
  const run = f.coordinator.options.platform.runProcess;
  f.coordinator.options.platform.runProcess = async request => {
    const result = await run(request);
    if (operation === 'upgrade' && request.args.includes('install')) {
      await io.writeFile(f.project.lockfilePath, lockfile(true).replaceAll('^18.0.0', '^18.3.0').replaceAll('18.2.0', '18.3.0'));
    } else if (operation === 'transitive') {
      await io.writeFile(f.project.lockfilePath, f.coordinator.remediationPlans.get('plan').proposedLockfileText);
    }
    return result;
  };
  const saved = await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file)));
  const s = await panel(t, { workspace: f.project.root, projects: ['.'], target: '.', early: false });
  await Promise.all([f.project.manifestPath, f.project.lockfilePath].map((file, index) => io.writeFile(file, saved[index])));
  s.gate.resolve();
  await s.ready();
  assert.equal(s.current.controller.isEligible(), true);
  const options = s.current.upgradeCoordinator.options;
  for (const key of ['reloadFinalState', 'reloadSmartCleanupFinalState', 'readAndApplyMutationLocalState', 'refreshMutationEnrichmentInBackground', 'invalidateSnapshot']) {
    if (options[key]) f.coordinator.options[key] = options[key];
  }
  if (mode === 'fallback') {
    delete f.coordinator.options.readAndApplyMutationLocalState;
    delete f.coordinator.options.refreshMutationEnrichmentInBackground;
  }
  let handle;
  const reserve = f.coordinator.reserve.bind(f.coordinator);
  f.coordinator.reserve = (...args) => { handle = reserve(...args); return handle; };
  return { ...f, s, owner: () => handle };
}

function failRefresh(t, f, code, occurrence = 1) {
  let refreshing = false, reads = 0, hits = 0, known = false;
  const reconcile = f.coordinator.reconcileRollback.bind(f.coordinator);
  f.coordinator.reconcileRollback = async (...args) => {
    const result = await reconcile(...args);
    assert.notEqual(result.completion, 'unknown');
    known = true;
    if (!f.coordinator.options.readAndApplyMutationLocalState) {
      f.coordinator.projectLoader = (_candidate, strict) => f.s.current.loadProjectMeasured(f.s.current.selectedProject, 'Fallback refresh test', strict);
    }
    return result;
  };
  const refresh = f.coordinator.refreshAfterCompletion.bind(f.coordinator);
  f.coordinator.refreshAfterCompletion = read => refresh(async () => {
    assert.equal(known, true, 'refresh must follow a known transaction and finished writer');
    refreshing = true;
    try { return await read(); } finally { refreshing = false; }
  });
  const original = io.readFile;
  io.readFile = async (file, ...args) => {
    if (refreshing && String(file) === path.join(f.project.root, '.npmrc') && ++reads === occurrence) {
      hits++;
      throw Object.assign(new Error(`optional registry read ${code}`), { code });
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { io.readFile = original; syncBuiltinESMExports(); });
  return () => assert.equal(hits, 1, 'the fault must reach the real post-completion optional evidence read');
}

for (const operation of ['upgrade', 'removal', 'cleanup', 'transitive', 'reinstall']) {
  const modes = operation === 'upgrade' || operation === 'transitive' ? ['local', 'fallback'] : operation === 'cleanup' ? ['local', 'final-reread'] : ['local'];
  for (const mode of modes) for (const code of codes) test(`${operation} completed ${mode} refresh ${code} preserves its known result and recovers`, async t => {
    const f = await completedFixture(t, operation, mode);
    const reached = failRefresh(t, f, code, mode === 'final-reread' ? 2 : 1);
    await f.confirm();
    reached();
    const expected = operation === 'reinstall' ? 'rolled-back' : 'kept';
    assert.equal(f.owner().result, expected);
    assert.notEqual(f.owner().state, 'unknown');
    assert.equal(f.coordinator.mutationLocks.admissionClosed, false);
    assert.equal(f.messages.some(message => message.status === 'recovery' && message.recovery.state === 'blocked'), false);
    // Cleanup restore points and displaced rollback files retain their normal recovery ownership.
    if (f.coordinator.reservation.held) {
      assert.equal(f.owner().state, 'retained');
      assert.equal(f.owner().journal.data.outcome, expected === 'kept' ? 'completed' : 'rolled-back');
    } else {
      assert.equal(f.coordinator.isBusy(), false);
    }
    const terminal = f.messages.findLast(message => ['upgrade-result', 'remove-result', 'remediation-apply-result'].includes(message.status));
    assert.ok(terminal, 'the known transaction result must still be delivered');
    if (operation === 'cleanup') {
      assert.equal(terminal.result.outcome, 'verified');
      assert.equal(terminal.result.smartCleanup.status, 'partial');
      assert.match(terminal.result.smartCleanup.reason, /evidence is unavailable/);
      assert.equal(terminal.result.restoreAvailable, true);
    }
    if (operation === 'reinstall') assert.deepEqual(f.commands, ['install', 'ci']);
    if (operation === 'transitive') assert.equal(terminal.result.outcome, 'verified');
    assert.equal(f.s.current.controller, undefined);
    assert.equal(f.s.current.runtimeFailed, false);
    assert.equal(f.s.posted.findLast(message => ['fatal-error', 'loading', 'ready', 'stale'].includes(message.status))?.status, 'fatal-error');
    assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
    // Retained restore points keep their existing recovery workflow. Exercise its read-only reload directly.
    if (f.coordinator.reservation.held) await f.s.ready();
    else await f.s.refresh();
    assert.equal(f.s.current.controller.isEligible(), true);
  });
}

test('a timer refresh rereads disk after completed mutation evidence failed despite a fresh cache age', async t => {
  const f = await completedFixture(t, 'upgrade');
  const reached = failRefresh(t, f, 'EMFILE');
  await f.confirm();
  reached();
  assert.equal(f.s.current.controller, undefined);
  f.s.current.onBackgroundTick();
  await until(() => f.s.current.controller?.isEligible());
  assert.equal(JSON.parse(f.s.current.controller.upgradeSource.manifestText).dependencies.react, '^18.3.0');
});

for (const operation of ['upgrade', 'removal', 'cleanup', 'transitive', 'reinstall']) {
  for (const boundary of ['journal', 'ownership']) {
    for (const code of codes) test(`${operation} completed writer still becomes unknown on ${boundary} ${code}`, async t => {
      const f = await completedFixture(t, operation);
      const reconcile = f.coordinator.reconcileRollback.bind(f.coordinator);
      let hits = 0;
      f.coordinator.reconcileRollback = async (handle, completion) => {
        const result = await reconcile(handle, completion);
        assert.notEqual(result.completion, 'unknown');
        if (operation === 'reinstall') assert.deepEqual(f.commands, ['install', 'ci']);
        const journal = handle.journal;
        const method = boundary === 'journal' ? 'record' : 'assertOwner';
        const original = journal[method].bind(journal);
        journal[method] = async (...args) => {
          if (hits === 0 && (boundary === 'ownership' || args[0] === 'completion')) {
            hits++;
            throw Object.assign(new Error(`completion ${boundary} ${code}`), { code });
          }
          return original(...args);
        };
        return result;
      };
      await f.confirm();
      assert.equal(hits, 1);
      assert.equal(f.owner().state, 'unknown');
      assert.equal(f.owner().result, 'unknown');
      assert.equal(f.owner().journal.data.outcome, 'unknown');
      assert.equal(f.coordinator.reservation.held, f.owner());
      assert.equal(f.coordinator.isMutationBusy(), true);
      assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), true);
      assert.throws(() => f.owner().journal.assertWritable());
    });
  }
}

test('Smart Cleanup refresh TypeError reports partial evidence and keeps the observed result', async t => {
  const f = await completedFixture(t, 'cleanup');
  f.coordinator.options.reloadSmartCleanupFinalState = async () => { throw new TypeError('presentation bug'); };
  await f.confirm();
  assert.equal(f.owner().result, 'kept');
  assert.equal(f.owner().journal.data.outcome, 'completed');
  const result = f.messages.findLast(message => message.status === 'remove-result').result;
  assert.equal(result.outcome, 'verified');
  assert.equal(result.smartCleanup.status, 'partial');
  assert.match(result.smartCleanup.reason, /evidence is unavailable/);
  assert.equal(f.s.current.controller, undefined);
});

test('a failure while reporting snapshot invalidation cannot enter mutation settlement', async t => {
  const f = await completedFixture(t, 'upgrade');
  const invalidate = f.coordinator.options.invalidateSnapshot;
  f.coordinator.options.invalidateSnapshot = () => { invalidate(); throw new TypeError('invalidation delivery bug'); };
  const reached = failRefresh(t, f, 'EMFILE');
  await f.confirm();
  reached();
  assert.equal(f.owner().result, 'kept');
  assert.equal(f.coordinator.reservation.held, undefined);
  assert.equal(f.s.current.controller, undefined);
  assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
});

for (const code of codes) test(`a known failed reinstall keeps its rollback result after refresh ${code}`, async t => {
  const f = await completedFixture(t, 'reinstall');
  f.state.reinstallExitCode = 1;
  const reached = failRefresh(t, f, code);
  await f.confirm();
  reached();
  assert.equal(f.owner().result, 'rolled-back');
  assert.equal(f.owner().journal.data.outcome, 'rolled-back');
  assert.match(f.messages.findLast(message => message.status === 'upgrade-result').result.rollbackMessage, /node_modules may not match/);
  assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
  assert.equal(f.s.current.controller, undefined);
});
