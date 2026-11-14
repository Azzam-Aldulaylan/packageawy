import { recoveryFixture, choices } from './helpers/recovery.mjs';
/**
 * Owner handles: only the handle a reservation returned can end it, each
 * handle is single-use, and a late call from a finished flow can never end
 * another owner's reservation.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { blocker, lockfile, makeCoordinator, makeProject, review } from './helpers/removal-project.mjs';

const { OperationReservation } = await import('../out/host/operationReservation.js');
const { ProjectMutationLocks, canonicalProjectRoot } = await import('../out/host/projectMutationLock.js');

// Mixed case on purpose: the registry stores a canonical, lowercased key (and
// on Windows adds the drive), so a handle that released with the key it was
// given would miss the entry on every platform.
const KEY = '/Workspace';
const LOCK = canonicalProjectRoot(KEY);

function panel(locks = new ProjectMutationLocks()) {
  const calls = [];
  const logs = [];
  let held = false;
  const reservation = new OperationReservation({
    locks,
    reserve() {
      if (held) return false;
      held = true;
      return true;
    },
    release(label) {
      held = false;
      calls.push(`release:${label}`);
    },
    async flushDeferredChanges() {
      calls.push('flush');
    },
    resumePendingBackground() {
      calls.push('resume');
    },
    isDisposed: () => false,
    dispose() {
      calls.push('dispose');
    },
    log: (line) => logs.push(line),
  });
  return { reservation, locks, calls, logs };
}

test('a stale handle cannot end another owner reservation, even for the same package', async () => {
  const { reservation, locks, calls, logs } = panel();
  const first = reservation.reserve('left-pad', KEY);
  assert.equal(await first.releaseReadOnly(), true);
  const second = reservation.reserve('left-pad', KEY);
  assert.equal(second.ok, true);

  assert.equal(await first.releaseReadOnly(), false);
  assert.equal(await first.complete('kept'), false);
  assert.equal(await first.beginMutation(), false);
  assert.equal(first.markUnknown('late result'), false);

  assert.equal(reservation.held, second);
  assert.equal(second.state, 'reserved');
  assert.equal(locks.holderOf(LOCK), second, 'the project lock stores the live handle');
  assert.deepEqual(calls, ['release:left-pad', 'flush', 'resume'], 'only the first release ran');
  assert.equal(logs.length, 4, 'every ignored call is logged');
  assert.ok(logs.every((line) => line.startsWith('Ignored ') && line.includes('released reservation for left-pad')));
});

test('settling twice is a logged no-op', async t => {
  const f = await recoveryFixture(t);
  const KEY = f.root;
  const LOCK = canonicalProjectRoot(KEY);
  const { reservation, locks, calls, logs } = panel();
  const handle = reservation.reserve('react', KEY);
  assert.equal(await handle.beginMutation(f.target), true);
  assert.equal(await handle.beginMutation(f.target), false, 'a mutation begins once');
  assert.equal(await handle.releaseReadOnly(), false, 'a mutation is never released as read-only');
  assert.equal(reservation.isMutationBusy, true);
  assert.equal(await handle.complete('kept'), true);
  assert.equal(await handle.complete('rolled-back'), false);
  assert.equal(await handle.releaseReadOnly(), false);
  assert.equal(handle.result, 'kept', 'the first known end stands');
  assert.equal(handle.state, 'completed');
  assert.equal(reservation.held, undefined);
  assert.equal(locks.holderOf(LOCK), undefined);
  assert.deepEqual(calls, ['release:react', 'flush', 'resume']);
  assert.equal(logs.length, 4);
});

test('concurrent reservations on the same target admit exactly one owner', async () => {
  const locks = new ProjectMutationLocks();
  const left = panel(locks);
  const right = panel(locks);
  const [winner, sameWindow, otherWindow] = await Promise.all([
    Promise.resolve().then(() => left.reservation.reserve('left-pad', KEY)),
    Promise.resolve().then(() => left.reservation.reserve('react', KEY)),
    Promise.resolve().then(() => right.reservation.reserve('left-pad', KEY)),
  ]);
  assert.equal(winner.ok, true);
  assert.deepEqual(sameWindow, { ok: false, reason: 'held' });
  assert.deepEqual(otherWindow, { ok: false, reason: 'project-locked' });
  assert.equal(locks.holderOf(LOCK), winner);
  assert.equal(right.reservation.held, undefined, 'a refused panel holds nothing');
  assert.deepEqual(right.calls, []);

  await winner.complete('not-started');
  const next = right.reservation.reserve('left-pad', KEY);
  assert.equal(next.ok, true, 'the project is free once the owner ends its reservation');
  assert.equal(locks.holderOf(LOCK), next);
});

test('markUnknown keeps the reservation and the project lock, and nothing else in this process can release them', async t => {
  const f = await recoveryFixture(t);
  const KEY = f.root;
  const LOCK = canonicalProjectRoot(KEY);
  const locks = new ProjectMutationLocks();
  const { reservation, calls, logs } = panel(locks);
  const other = panel(locks);
  const handle = reservation.reserve('react', KEY);
  await handle.beginMutation(f.target);
  assert.equal(handle.markUnknown('the task result was lost'), true);
  assert.equal(handle.settled, true);
  assert.equal(handle.state, 'unknown');

  assert.equal(await handle.complete('kept'), false);
  assert.equal(await handle.releaseReadOnly(), false);
  assert.equal(handle.markUnknown('again'), false);
  assert.equal(await reservation.held?.releaseReadOnly(), false, 'the panel abandonment path cannot release it');
  reservation.disposeIfIdle();

  assert.equal(reservation.isMutationBusy, true);
  assert.equal(reservation.held, handle);
  assert.equal(locks.holderOf(LOCK), handle);
  assert.deepEqual(reservation.reserve('react', KEY), { ok: false, reason: 'held' });
  assert.deepEqual(other.reservation.reserve('react', KEY), { ok: false, reason: 'project-locked' });
  assert.deepEqual(calls, [], 'no release, reload or disposal ran');
  assert.ok(logs[0].includes('the task result was lost'));
});

test('a coordinator whose change has an unknown outcome stays locked through webview reload and panel close', async (t) => {
  const project = await makeProject(t);
  const locks = new ProjectMutationLocks();
  const fixture = makeCoordinator(project, { mutationLocks: locks, mutationRoot: () => project.root });
  const handle = fixture.coordinator.reserve('react');
  assert.equal(await handle.beginMutation({ workspaceRoot: project.root, root: project.root, identity: (await fixture.read()).mutationTarget.identity, allowlistedPaths: [project.manifestPath, project.lockfilePath], operation: 'removal', hostKind: 'vscode' }), true);
  handle.markUnknown('the task result was lost');
  await fixture.coordinator.handleWebviewReady();
  fixture.coordinator.disposeWhenIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.coordinator.isMutationBusy(), true);
  assert.equal(fixture.coordinator.isBusy(), true);

  const reopened = makeCoordinator(project, { mutationLocks: locks, mutationRoot: () => project.root });
  assert.equal(reopened.coordinator.isMutationBusy(), true, 'a panel opened later sees the project locked');
  await reopened.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'cleanup', removalRequestId: 'impact', packages: ['react'] });
  assert.equal(reopened.messages.at(-1).error?.code, 'UPGRADE_IN_PROGRESS');
});

/**
 * Holds a removal review in its project read after it reserved. The review
 * reads once for the controller before reserving, so the second read is held.
 */
function holdReviewRead(fixture) {
  const hold = blocker();
  let reads = 0;
  fixture.state.holdRead = async () => {
    reads += 1;
    if (reads === 2) await hold.wait();
  };
  return hold;
}

/** Starts a second removal review of the same package and holds it after it reserved. */
async function holdSecondReview(fixture) {
  const hold = holdReviewRead(fixture);
  const analyzing = fixture.coordinator.handleAnalyzeSmartCleanupRemove({
    requestId: 'cleanup-2', removalRequestId: 'impact-2', packages: ['react'],
  });
  await hold.arrived;
  assert.equal(fixture.coordinator.isBusy(), true, 'the second review holds the reservation');
  return async () => {
    fixture.state.holdRead = undefined;
    hold.release();
    await analyzing;
  };
}

test('cancelling an older review never releases a newer review of the same package', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const oldId = await review(fixture);
  const finish = await holdSecondReview(fixture);
  await fixture.coordinator.handleCancelRemove({ analysisId: oldId });
  assert.equal(fixture.coordinator.isBusy(), true, 'the newer review still owns the reservation');
  await finish();
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('confirming an expired review never releases a newer review of the same package', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const oldId = await review(fixture);
  const finish = await holdSecondReview(fixture);
  fixture.coordinator.removal.expiresAt = 0;
  await fixture.coordinator.handleConfirmRemove({ analysisId: oldId });
  assert.equal(fixture.messages.at(-1).error?.code, 'STALE_ANALYSIS');
  assert.equal(fixture.coordinator.isBusy(), true, 'the newer review still owns the reservation');
  await finish();
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('a source change that drops an older review never releases a newer review of the same package', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  await review(fixture);
  const finish = await holdSecondReview(fixture);
  fixture.coordinator.handleProjectSourceChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.coordinator.isBusy(), true, 'the newer review still owns the reservation');
  await finish();
  assert.equal(fixture.coordinator.isBusy(), false);
});

/** Confirms, holds the confirmation in its first project read, reloads the webview, then lets it continue. */
async function reloadDuringConfirm(fixture, confirm) {
  const hold = blocker();
  fixture.state.holdRead = hold.wait;
  const confirming = confirm();
  await hold.arrived;
  await fixture.coordinator.handleWebviewReady();
  assert.equal(fixture.coordinator.isBusy(), false, 'the reload abandoned the confirmation before it wrote');
  fixture.state.holdRead = undefined;
  hold.release();
  await confirming;
}

test('a removal stopped before writing answers with a terminal message', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  await reloadDuringConfirm(fixture, () => fixture.coordinator.handleConfirmRemove({ analysisId }));
  assert.deepEqual(fixture.messages.at(-1), {
    status: 'remove-error',
    package: 'react',
    error: { code: 'CHANGE_STOPPED', message: 'This change stopped before any files were changed. Review it again to continue.' },
  });
  assert.deepEqual(fixture.commands, []);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('an upgrade stopped before writing answers with a terminal message', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project, {
    ensureController: async () => ({
      root: project.root,
      upgradeSource: await fixture.read(),
      validateBulkUpgradeRequest: () => ({ ok: true }),
    }),
  });
  fixture.coordinator.analysis = {
    id: 'upgrade-review',
    snapshot: await fixture.read(),
    eligibility: { packageName: 'left-pad', currentVersion: '1.3.0', target: '1.3.1', classification: 'prod' },
    projectCompatibilityEvidenceFingerprint: null,
    compatibilityStatus: 'compatible',
    expiresAt: Date.now() + 60_000,
    smartPlanProposal: null,
    proposal: { changes: [{ packageName: 'left-pad', targetVersion: '1.3.1', classification: 'prod' }] },
    requests: [],
    publishedTargetsByPackage: new Map(),
    verificationScripts: [],
    ignoreScripts: true,
  };
  await reloadDuringConfirm(fixture, () => fixture.coordinator.handleConfirmUpgrade({ analysisId: 'upgrade-review' }));
  assert.deepEqual(fixture.messages.at(-1), {
    status: 'upgrade-error',
    analysisId: 'upgrade-review',
    package: 'left-pad',
    error: { code: 'CHANGE_STOPPED', message: 'This change stopped before any files were changed. Review it again to continue.' },
  });
  assert.deepEqual(fixture.commands, []);
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('opening a durable Smart Cleanup restore point never restores or releases it', async t => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  assert.equal(fixture.messages.at(-1).status, 'recovery');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
  assert.deepEqual(fixture.commands, ['install']);
  assert.equal(fixture.coordinator.isBusy(), true);
});

test('reviews release their locks and durable cleanup keeps its lock until recovery dismissal', async (t) => {
  const project = await makeProject(t);
  const locks = new ProjectMutationLocks();
  const released = [];
  const fixture = makeCoordinator(project, {
    mutationLocks: locks,
    mutationRoot: () => project.root,
    onMutationLockReleased: () => released.push('released'),
  });
  const key = canonicalProjectRoot(project.root);
  const free = () => {
    assert.equal(fixture.coordinator.isBusy(), false);
    assert.equal(locks.holderOf(key), undefined, 'no handle is left in the project locks');
  };

  // Cancel while the review is still running: released synchronously.
  const hold = holdReviewRead(fixture);
  const cancelled = fixture.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'c', removalRequestId: 'c', packages: ['react'] });
  await hold.arrived;
  assert.ok(locks.holderOf(key), 'the running review holds the project lock');
  void fixture.coordinator.handleCancelRemove({ analysisId: null });
  free();
  fixture.state.holdRead = undefined;
  hold.release();
  await cancelled;

  // A finished review releases; an expired one is dropped on the next request.
  const expiredId = await review(fixture);
  free();
  fixture.coordinator.removal.expiresAt = 0;
  const analysisId = await review(fixture);
  assert.notEqual(analysisId, expiredId);
  free();

  await fixture.coordinator.handleConfirmRemove({ analysisId });
  assert.equal(fixture.messages.findLast(message => message.status === 'remove-result').result.outcome, 'verified');
  assert.equal(fixture.coordinator.isBusy(), true);
  assert.equal(locks.holderOf(key).state, 'retained');
  await fixture.coordinator.recovery.inspect();
  const view = fixture.messages.at(-1).recovery;
  await fixture.coordinator.recovery.start(true, view.claim);
  await fixture.coordinator.recovery.apply(choices(fixture.messages.at(-1).recovery));
  await fixture.coordinator.recovery.dismiss(true, false);
  free();
  assert.ok(released.length >= 4);

});

/** A coordinator holding the shared project lock, whose controller lookup can be made to reject. */
function rejectingLookup(project, controller) {
  const locks = new ProjectMutationLocks();
  const lookup = { reject: false };
  const fixture = makeCoordinator(project, {
    mutationLocks: locks,
    mutationRoot: () => project.root,
    ensureController: async () => {
      if (lookup.reject) throw new Error('controller lookup failed');
      return controller(fixture);
    },
  });
  return { fixture, locks, lookup, key: canonicalProjectRoot(project.root) };
}

test('a removal whose controller lookup rejects releases the reservation and the project lock', async (t) => {
  const project = await makeProject(t);
  const { fixture, locks, lookup, key } = rejectingLookup(project, async (f) => ({
    root: project.root,
    upgradeSource: await f.read(),
    validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
  }));
  const analysisId = await review(fixture);
  lookup.reject = true;
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  assert.equal(fixture.messages.at(-1).status, 'remove-error', 'the confirmation is answered');
  assert.equal(fixture.coordinator.isBusy(), false, 'the panel reservation was released');
  assert.equal(locks.holderOf(key), undefined, 'the project lock was released');
  assert.deepEqual(fixture.commands, []);
});

test('an upgrade whose controller lookup rejects releases the reservation and the project lock', async (t) => {
  const project = await makeProject(t);
  const { fixture, locks, lookup, key } = rejectingLookup(project, async (f) => ({
    root: project.root,
    upgradeSource: await f.read(),
    validateBulkUpgradeRequest: () => ({ ok: true }),
  }));
  fixture.coordinator.analysis = {
    id: 'upgrade-review',
    snapshot: await fixture.read(),
    eligibility: { packageName: 'left-pad', currentVersion: '1.3.0', target: '1.3.1', classification: 'prod' },
    projectCompatibilityEvidenceFingerprint: null,
    compatibilityStatus: 'compatible',
    expiresAt: Date.now() + 60_000,
    smartPlanProposal: null,
    proposal: { changes: [{ packageName: 'left-pad', targetVersion: '1.3.1', classification: 'prod' }] },
    requests: [],
    publishedTargetsByPackage: new Map(),
    verificationScripts: [],
    ignoreScripts: true,
  };
  lookup.reject = true;
  await fixture.coordinator.handleConfirmUpgrade({ analysisId: 'upgrade-review' });
  assert.equal(fixture.messages.at(-1).status, 'upgrade-error', 'the confirmation is answered');
  assert.equal(fixture.coordinator.isBusy(), false, 'the panel reservation was released');
  assert.equal(locks.holderOf(key), undefined, 'the project lock was released');
  assert.deepEqual(fixture.commands, []);
});
