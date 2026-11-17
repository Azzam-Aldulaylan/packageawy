import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { prepareJournal } from '../out/host/recovery/journal.js';
import { inspectRecovery } from '../out/host/recovery/inspection.js';
import { RecoveryCoordinator } from '../out/host/recovery/coordinator.js';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { RECOVERY_MESSAGES } from '../out/host/recovery/model.js';

function coordinator(f, discovery = true) {
  const messages = [], warnings = [];
  const recovery = new RecoveryCoordinator({
    platform: { ...(discovery ? { workspaceFolders: () => [{ id: 'workspace', name: 'workspace', path: f.root }] } : {}), showWarningMessage: message => warnings.push(message) },
    locks: new ProjectMutationLocks(), target: async () => f.target,
    post: message => messages.push(message), removed: async () => {},
  });
  return { recovery, messages, warnings };
}

for (const selection of ['automatic', 'same entry']) test(`ordinary recovery ${selection} clears the stale undo binding for a replaced transaction`, async t => {
  const f = await recoveryFixture(t);
  const a = await f.prepare(); await a.finish('kept');
  const { recovery, messages, warnings } = coordinator(f);
  await recovery.inspectBackup(f.target, a.owner.transactionId);
  const b = await f.prepare(); // Another window starts B and is interrupted.
  await recovery.inspect('f'.repeat(64)); // An obsolete entry cannot unbind the undo screen.
  await recovery.start(true, null);
  assert.equal(warnings.at(-1), RECOVERY_MESSAGES.undoUnavailable, 'explicit stale undo stays fenced');
  assert.equal((await f.inspect()).view.claim, null, 'stale undo cannot claim B');
  await recovery.inspect();
  const entries = messages.findLast(m => m.status === 'recovery-entries').entries;
  assert.equal(entries.length, 1);
  if (selection === 'same entry') await recovery.inspect(entries[0].id);
  const view = messages.findLast(m => m.status === 'recovery').recovery;
  const warningCount = warnings.length;
  await recovery.start(true, view.claim);
  assert.equal(warnings.length, warningCount, 'ordinary selection can claim B');
  assert.equal(recovery.session.inspection.owner.transactionId, b.owner.transactionId);
  await recovery.apply(choices(messages.findLast(m => m.status === 'recovery').recovery));
  await recovery.dismiss(true, false);
  assert.equal((await f.inspect()).view.state, 'none');
});

test('explicit undo targets never enter automatic recovery entries or replace the selected interrupted project', async t => {
  const f = await recoveryFixture(t);
  const a = await f.prepare(); await a.finish('kept');
  const { recovery, messages } = coordinator(f);
  for (const name of ['interrupted-b', 'interrupted-c']) {
    const root = path.join(f.root, name); await mkdir(root);
    const manifest = path.join(root, 'package.json'), lock = path.join(root, 'package-lock.json');
    await writeFile(manifest, '{}'); await writeFile(lock, '{}');
    await prepareJournal({ ...f.target, root, identity: JSON.stringify(['target', 'npm', root, lock, '.']), allowlistedPaths: [manifest, lock] });
  }
  await recovery.inspect();
  const entries = messages.findLast(m => m.status === 'recovery-entries').entries;
  assert.deepEqual(entries.map(entry => entry.label), ['interrupted-b', 'interrupted-c']);
  await recovery.inspectBackup(f.target, a.owner.transactionId);
  assert.equal(messages.at(-1).recovery.undoReview, true);
  assert.equal(recovery.targets.size, 2, 'the undo review has its own target');
  assert.deepEqual(messages.findLast(m => m.status === 'recovery-entries').entries, entries);
  // Closing the review is local UI state. A subsequent ordinary inspection
  // still offers only projects whose outcomes actually require recovery.
  await recovery.inspect(entries[0].id);
  assert.deepEqual(messages.findLast(m => m.status === 'recovery-entries').entries, entries);
  assert.notEqual(messages.at(-1).recovery.undoReview, true);
  assert.equal((await inspectRecovery(f.target)).view.state, 'undo-available');
});

for (const discovery of [true, false]) test(`ordinary inspection with discovery ${discovery} never exposes a successful backup as recovery`, async t => {
  const f = await recoveryFixture(t);
  const a = await f.prepare(); await a.finish('kept');
  const { recovery, messages } = coordinator(f, discovery);
  await recovery.inspectBackup(f.target, a.owner.transactionId);
  await recovery.inspect();
  assert.equal(messages.at(-1).recovery.state, 'none');
  assert.equal(recovery.targets.size, 0);
  assert.equal((await f.inspect()).view.state, 'undo-available');
});

for (const operation of ['cleanup', 'removal', 'upgrade', 'remediation']) for (const discovery of [true, false]) {
  test(`${operation} claimed Undo preserves its transaction, operation and lock across inspection with discovery ${discovery}`, async t => {
    const f = await recoveryFixture(t, { operation });
    const journal = await f.prepare();
    await writeFile(f.manifest, '{"dependencies":{}}');
    await journal.finish('kept');
    const { recovery, messages } = coordinator(f, discovery);
    await recovery.inspectBackup(f.target, journal.owner.transactionId);
    await recovery.start(true, null);
    const session = recovery.session, lock = recovery.lock, undo = recovery.undo;
    // Keep for later closes only the webview. Reopening triggers discovery.
    await recovery.inspect();
    const entry = messages.findLast(message => message.status === 'recovery-entries').entries[0];
    await recovery.inspect(entry.id);
    assert.equal(recovery.undo, undo);
    assert.equal(recovery.session, session);
    assert.equal(recovery.lock, lock);
    const view = messages.findLast(message => message.status === 'recovery').recovery;
    assert.equal(view.undoOperation, operation);
    assert.equal(view.canApply, true);
    assert.equal(recovery.session.inspection.owner.transactionId, journal.owner.transactionId);
    await recovery.apply(choices(view, 'restore'));
    assert.equal(await f.read('package.json'), '{"dependencies":{"a":"1.0.0"}}');
    await recovery.dismiss(true, false);
    assert.equal((await f.inspect()).view.state, 'none');
  });
}

test('inspection clears Undo intent when the same recovery entry belongs to a different transaction', async t => {
  const f = await recoveryFixture(t);
  const first = await f.prepare(); await first.finish('kept');
  const { recovery, messages } = coordinator(f);
  await recovery.inspectBackup(f.target, first.owner.transactionId);
  const replacement = await f.prepare();
  await recovery.inspect();
  assert.equal(recovery.undo, undefined);
  const view = messages.findLast(message => message.status === 'recovery').recovery;
  assert.equal(view.undoOperation, undefined);
  await recovery.start(true, view.claim);
  assert.equal(recovery.session.inspection.owner.transactionId, replacement.owner.transactionId);
});
