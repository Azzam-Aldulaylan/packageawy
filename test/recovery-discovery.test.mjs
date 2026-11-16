import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { recoveryFixture } from './helpers/recovery.mjs';
import { targetFromRecoveryFolder, findOrphanedRecoveryTarget, findRecoveryTargets } from '../out/host/recovery/targetDiscovery.js';
import { makeCoordinator } from './helpers/removal-project.mjs';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { choices } from './helpers/recovery.mjs';
import { prepareJournal } from '../out/host/recovery/journal.js';

test('recovery is discoverable with package.json displaced, including a nested project', async t => {
  const f = await recoveryFixture(t);
  await f.prepare();
  await rename(f.manifest, path.join(f.root, 'manifest-aside'));
  const folder = { id: 'f', name: 'f', path: f.root };
  const target = await targetFromRecoveryFolder(folder, f.root, { hostKind: 'vscode' });
  assert.deepEqual(target.allowlistedPaths, f.target.allowlistedPaths);
  assert.equal(target.identity, f.target.identity);
  const nested = path.join(f.root, 'nested'); await mkdir(nested);
  const manifest = path.join(nested, 'package.json'); const lock = path.join(nested, 'package-lock.json');
  await writeFile(manifest, '{}'); await writeFile(lock, '{}');
  await prepareJournal({ ...f.target, root: nested, identity: JSON.stringify(['target', 'npm', nested, lock, '.']), allowlistedPaths: [manifest, lock] });
  await rename(manifest, path.join(nested, 'manifest-aside'));
  const platform = { workspaceFolders: () => [folder] };
  // Remove the outer folder from this search without deleting any recovery data.
  const result = await findOrphanedRecoveryTarget({ ...platform, workspaceFolders: () => [{ ...folder, path: nested }] });
  assert.equal(result.root, nested);
});

test('recovery discovery reproduces pnpm identity even if the manifest is unreadable', async t => {
  const f = await recoveryFixture(t);
  const lock = path.join(f.root, 'pnpm-lock.yaml');
  await writeFile(lock, 'lockfileVersion: 9');
  const identity = JSON.stringify(['target', 'pnpm', f.root, lock, '.']);
  await prepareJournal({ ...f.target, identity, allowlistedPaths: [f.manifest, lock] });
  await writeFile(f.manifest, '{');
  const target = await targetFromRecoveryFolder({ id: 'f', name: 'f', path: f.root }, f.root, {});
  assert.equal(target.identity, identity);
  assert.deepEqual(target.allowlistedPaths, [f.manifest, lock]);
});

test('journal identity cannot grant authority to traversal, absolute or outside project paths', async t => {
  for (const importer of ['../outside', '/tmp', 'nested/../../outside', 'nested\\outside']) {
    const f = await recoveryFixture(t); const journal = await f.prepare();
    await writeFile(path.join(f.folder, 'owner.json'), JSON.stringify({ ...journal.owner, targetIdentity: JSON.stringify(['target', 'npm', f.root, f.lockfile, importer]) }));
    assert.equal(await targetFromRecoveryFolder({ id: 'f', name: 'f', path: f.root }, f.root, {}), undefined);
  }
});


test('every orphaned journal is reachable with a healthy root or sibling selected', async t => {
  const root = await recoveryFixture(t);
  const folder = { id: 'f', name: 'workspace', path: root.root };
  const targets = [];
  for (const name of ['lost-one', 'lost-two']) {
    const dir = path.join(root.root, name); await mkdir(dir);
    const manifest = path.join(dir, 'package.json'); const lock = path.join(dir, 'package-lock.json');
    await writeFile(manifest, '{}'); await writeFile(lock, 'original');
    const target = { ...root.target, root: dir, identity: JSON.stringify(['target', 'npm', dir, lock, '.']), allowlistedPaths: [manifest, lock] };
    await prepareJournal(target); await rename(manifest, path.join(dir, 'manifest-aside'));
    targets.push(target);
  }
  const healthy = { root: root.root, manifestPath: root.manifest, lockfilePath: root.lockfile };
  await mkdir(path.join(root.root, 'healthy-sibling'));
  await writeFile(path.join(root.root, 'healthy-sibling/package.json'), '{}');
  await writeFile(path.join(root.root, 'healthy-sibling/package-lock.json'), '{}');
  for (const dir of ['', 'healthy-sibling']) {
    const f = makeCoordinator(healthy, { mutationLocks: new ProjectMutationLocks(),
      getSelectedProject: () => ({ id: 'healthy', dir, folder }),
      platform: { workspaceFolders: () => [folder], showWarningMessage() {} },
    });
    await f.coordinator.recovery.inspect();
    const entries = f.messages.findLast(message => message.status === 'recovery-entries').entries;
    assert.deepEqual(entries.map(entry => entry.label), ['lost-one', 'lost-two']);
    for (const entry of entries) {
      await f.coordinator.recovery.inspect(entry.id);
      const view = f.messages.at(-1).recovery;
      assert.ok(['blocked', 'completed'].includes(view.state));
      assert.equal(view.files.find(file => file.path === 'package.json').current, 'absent');
      await f.coordinator.recovery.start(true, view.claim);
      assert.ok(f.messages.at(-1).recovery.canApply || f.messages.at(-1).recovery.canDismiss);
      // Keep the journals to verify selection again from the sibling.
      await f.coordinator.recovery.apply(choices(f.messages.at(-1).recovery));
    }
  }
});


test('the recovery directory scan finds empty nested folders and excludes dependencies and symlinks', async t => {
  const f = await recoveryFixture(t);
  for (const dir of ['nested', 'node_modules/ignored', 'dist/ignored']) {
    await mkdir(path.join(f.root, dir, '.packageawy-recovery'), { recursive: true });
    await writeFile(path.join(f.root, dir, 'package.json'), '{}');
  }
  if (process.platform !== 'win32') await symlink(path.join(f.root, 'node_modules/ignored'), path.join(f.root, 'linked'));
  const targets = await findRecoveryTargets({ workspaceFolders: () => [{ id: 'f', name: 'f', path: f.root }] });
  assert.deepEqual(targets.map(target => target.root), [path.join(f.root, 'nested')]);
});
