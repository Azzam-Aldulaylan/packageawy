import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
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
  assert.equal(view.state, 'completed');
  assert.equal(view.files.length, 2);
  assert.equal(fixture.coordinator.isMutationBusy(), true);
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

test('source changes, new analyses and panel close never discard durable cleanup backups', async t => {
  const { project, fixture } = await keptCleanup(t);
  const edited = `${await readFile(project.manifestPath, 'utf8')}\n`;
  await writeFile(project.manifestPath, edited);
  fixture.coordinator.handleProjectSourceChanged();
  fixture.coordinator.disposeWhenIdle();
  await fixture.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'next', removalRequestId: 'next', packages: ['react'] });
  assert.equal(fixture.messages.at(-1).error.code, 'UPGRADE_IN_PROGRESS');
  await fixture.coordinator.recovery.inspect();
  assert.equal(fixture.messages.at(-1).recovery.files.length, 2);
  assert.equal(await readFile(project.manifestPath, 'utf8'), edited);
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false));
});

test('Keep current after cleanup needs confirmation and leaves every dependency file unchanged', async t => {
  const { project, fixture } = await keptCleanup(t);
  const before = await readFile(project.manifestPath, 'utf8');
  await fixture.coordinator.recovery.inspect();
  const view = fixture.messages.at(-1).recovery;
  await fixture.coordinator.recovery.start(false, view.claim);
  assert.equal(fixture.coordinator.isBusy(), true);
  await fixture.coordinator.recovery.start(true, view.claim);
  await fixture.coordinator.recovery.apply(choices(fixture.messages.at(-1).recovery));
  assert.equal(await readFile(project.manifestPath, 'utf8'), before);
  await fixture.coordinator.recovery.dismiss(true, false);
  assert.equal(fixture.coordinator.isBusy(), false);
});
