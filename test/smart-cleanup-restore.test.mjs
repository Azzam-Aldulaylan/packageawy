import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { MANIFEST, lockfile, makeCoordinator, makeProject, review } from './helpers/removal-project.mjs';
import { choices } from './helpers/recovery.mjs';

async function keptCleanup(t) {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project, { mutationRoot: () => project.root });
  const analysisId = await review(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  const result = fixture.messages.findLast(message => message.status === 'remove-result').result;
  assert.equal(result.restoreAvailable, true);
  assert.equal(result.verification, 'not-configured');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
  return { project, fixture, analysisId };
}

test('Smart Cleanup keeps its restore point in the journal and opens recovery without restoring', async t => {
  const { project, fixture, analysisId } = await keptCleanup(t);
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  const view = fixture.messages.at(-1).recovery;
  assert.equal(view.state, 'undo-available');
  assert.equal(view.files.length, 2);
  assert.equal(fixture.coordinator.isMutationBusy(), false);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
  assert.deepEqual(fixture.commands, ['install']);
  await fixture.coordinator.recovery.start(true, view.claim);
  await fixture.coordinator.recovery.apply(choices(fixture.messages.at(-1).recovery, 'restore', true));
  assert.equal(await readFile(project.manifestPath, 'utf8'), MANIFEST);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  assert.equal(fixture.coordinator.isBusy(), true, 'saved displacements keep the lock');
  await fixture.coordinator.recovery.dismiss(true, false);
  assert.equal(fixture.coordinator.isBusy(), false);
  assert.deepEqual(fixture.commands, ['install'], 'recovery does not automatically reinstall');
});

test('source changes and new analyses preserve a retained backup until another mutation starts', async t => {
  const { project, fixture } = await keptCleanup(t);
  const edited = `${await readFile(project.manifestPath, 'utf8')}\n`;
  await writeFile(project.manifestPath, edited);
  fixture.coordinator.handleProjectSourceChanged();
  await fixture.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'next', removalRequestId: 'next', packages: ['react'] });
  assert.equal(fixture.messages.at(-1).status, 'remove-analysis');
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: fixture.coordinator.cleanupBackups.keys().next().value });
  assert.equal(fixture.messages.at(-1).recovery.files.length, 2);
  assert.equal(fixture.messages.at(-1).recovery.state, 'undo-available');
  assert.equal(await readFile(project.manifestPath, 'utf8'), edited);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
});

test('Keep current after cleanup needs confirmation and leaves every dependency file unchanged', async t => {
  const { project, fixture, analysisId } = await keptCleanup(t);
  const before = await readFile(project.manifestPath, 'utf8');
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  const view = fixture.messages.at(-1).recovery;
  await fixture.coordinator.recovery.start(false, view.claim);
  assert.equal(fixture.coordinator.isBusy(), false);
  await fixture.coordinator.recovery.start(true, view.claim);
  await fixture.coordinator.recovery.apply(choices(fixture.messages.at(-1).recovery));
  assert.equal(await readFile(project.manifestPath, 'utf8'), before);
  await fixture.coordinator.recovery.dismiss(true, false);
  assert.equal(fixture.messages.at(-1).recovery.message.includes('cannot be undone'), true);
  assert.equal(fixture.coordinator.isBusy(), true);
  await fixture.coordinator.recovery.dismiss(true, true);
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('undo uses the completed project even when discovery would choose another project', async t => {
  const { project, fixture, analysisId } = await keptCleanup(t);
  const other = await makeProject(t);
  const otherFixture = makeCoordinator(other, { mutationRoot: () => other.root });
  await otherFixture.coordinator.handleConfirmRemove({ analysisId: await review(otherFixture) });
  const wrongBackup = otherFixture.coordinator.cleanupBackups.values().next().value;
  fixture.coordinator.recovery.options.target = async () => wrongBackup.target;
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  const view = fixture.messages.at(-1).recovery;
  assert.equal(view.undoReview, true);
  assert.equal(fixture.coordinator.recovery.undo.target.root, project.root);
  assert.equal(fixture.coordinator.recovery.targets.size, 0);
  await fixture.coordinator.recovery.start(true, view.claim);
  await fixture.coordinator.recovery.apply(choices(fixture.messages.at(-1).recovery, 'restore', true));
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  assert.equal(await readFile(other.lockfilePath, 'utf8'), lockfile(false));
});

test('an old cleanup action cannot open or claim a newer backup', async t => {
  const { fixture, analysisId, project } = await keptCleanup(t);
  const backup = fixture.coordinator.cleanupBackups.get(analysisId);
  const { prepareJournal } = await import('../out/host/recovery/journal.js');
  const next = await prepareJournal(backup.target);
  await next.finish('kept');
  const count = fixture.messages.length;
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: 'unknown-cleanup' });
  const posted = fixture.messages.slice(count);
  assert.deepEqual(posted.filter(message => message.status !== 'smart-cleanup-backups'), [
    { status: 'smart-cleanup-backup', analysisId, outcome: 'unavailable' },
    { status: 'smart-cleanup-backup', analysisId: 'unknown-cleanup', outcome: 'unavailable' },
  ], 'stale actions clear undo without opening another review');
  assert.deepEqual(posted.filter(message => message.status === 'smart-cleanup-backups').map(message => message.entries), [
    [], [{ analysisId: next.owner.transactionId, label: path.basename(project.root) }],
  ], 'discovery offers the replacement as its own undo action');
  const { inspectRecovery } = await import('../out/host/recovery/inspection.js');
  const latest = await inspectRecovery(backup.target);
  assert.equal(latest.view.state, 'undo-available');
  assert.equal(latest.view.claim, null);
  assert.equal(latest.owner.transactionId, next.owner.transactionId);
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('an undo review rechecks transaction identity after another window replaces the backup', async t => {
  const { fixture, analysisId } = await keptCleanup(t);
  const backup = fixture.coordinator.cleanupBackups.get(analysisId);
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  const { prepareJournal } = await import('../out/host/recovery/journal.js');
  const next = await prepareJournal(backup.target);
  await next.finish('kept');
  await fixture.coordinator.recovery.start(true, null);
  assert.equal(fixture.coordinator.recovery.session, undefined);
  assert.equal(fixture.coordinator.isBusy(), false);
  const { inspectRecovery } = await import('../out/host/recovery/inspection.js');
  const inspected = await inspectRecovery(backup.target);
  assert.equal(inspected.owner.transactionId, next.owner.transactionId);
  assert.equal(inspected.view.state, 'undo-available');
});

test('opening undo never releases a read-only reservation owned by another panel', async t => {
  const { fixture, analysisId, project } = await keptCleanup(t);
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId });
  const { OperationReservation } = await import('../out/host/operationReservation.js');
  const other = new OperationReservation({ locks: fixture.coordinator.mutationLocks, reserve: () => true, release() {},
    flushDeferredChanges: async () => {}, resumePendingBackground() {}, isDisposed: () => false, dispose() {} });
  const owner = other.reserve('another review', project.root, true);
  await fixture.coordinator.recovery.start(true, null);
  assert.equal(owner.state, 'reserved');
  assert.equal(other.held, owner);
  assert.equal(fixture.coordinator.recovery.session, undefined);
  await owner.releaseReadOnly();
});
