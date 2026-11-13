/**
 * The coordinator side of the internal error gate: every path rechecks the
 * pause right before the mutation boundary, and a change that already
 * started finishes and releases normally.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MANIFEST, blocker, lockfile, makeCoordinator, makeProject, review } from './helpers/removal-project.mjs';

test('a review kept from before the failure cannot be confirmed after it', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  fixture.state.paused = true;
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  const refused = fixture.messages.at(-1);
  assert.equal(refused.status, 'remove-error');
  assert.equal(refused.error.code, 'CHANGES_PAUSED');
  assert.deepEqual(fixture.commands, [], 'no package manager ran');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(true));
  assert.equal(fixture.coordinator.isBusy(), false, 'the reservation was released');
});

test('a failure that lands while a confirmation is in preflight stops it before writing', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  const hold = blocker();
  fixture.state.holdRead = hold.wait;
  const confirming = fixture.coordinator.handleConfirmRemove({ analysisId });
  await hold.arrived;
  fixture.state.paused = true;
  fixture.state.holdRead = undefined;
  hold.release();
  await confirming;
  assert.equal(fixture.messages.at(-1).error?.code, 'CHANGES_PAUSED');
  assert.deepEqual(fixture.commands, []);
  assert.equal(await readFile(project.manifestPath, 'utf8'), MANIFEST);
  assert.equal(fixture.coordinator.isBusy(), false);
});

test('a change already running finishes and releases normally after a failure elsewhere', async (t) => {
  const project = await makeProject(t);
  const releases = [];
  const fixture = makeCoordinator(project, { onMutationLockReleased: () => releases.push('released') });
  const analysisId = await review(fixture);
  const hold = blocker();
  fixture.state.holdInstall = hold.wait;
  const confirming = fixture.coordinator.handleConfirmRemove({ analysisId });
  await hold.arrived;
  assert.equal(fixture.coordinator.isMutationBusy(), true, 'the install is inside the mutation boundary');
  fixture.state.paused = true;
  hold.release();
  await confirming;
  const result = fixture.messages.findLast((message) => message.status === 'remove-result');
  assert.ok(result, `the removal finished: ${JSON.stringify(fixture.messages.at(-1))}`);
  assert.equal(result.result.outcome, 'verified');
  assert.equal(fixture.coordinator.isBusy(), false, 'the lock was released');
  assert.ok(releases.length > 0, 'the normal post-release callback ran');
});

test('a kept Smart Cleanup restore is refused after the failure without touching files', async (t) => {
  const project = await makeProject(t);
  const fixture = makeCoordinator(project);
  const analysisId = await review(fixture);
  await fixture.coordinator.handleConfirmRemove({ analysisId });
  const result = fixture.messages.findLast((message) => message.status === 'remove-result').result;
  assert.equal(result.restoreAvailable, true);
  fixture.state.paused = true;
  await fixture.coordinator.handleRestoreSmartCleanup({ analysisId: result.analysisId });
  assert.equal(fixture.messages.at(-1).error.code, 'CHANGES_PAUSED');
  assert.equal(await readFile(project.lockfilePath, 'utf8'), lockfile(false), 'nothing was restored');
  assert.deepEqual(fixture.commands, ['install'], 'no reinstall ran');
});
