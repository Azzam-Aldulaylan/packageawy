import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareJournal } from '../../out/host/recovery/journal.js';
import { inspectRecovery } from '../../out/host/recovery/inspection.js';
import { RecoverySession } from '../../out/host/recovery/session.js';

export async function recoveryFixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-journal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'package.json');
  const lockfile = path.join(root, 'package-lock.json');
  await writeFile(manifest, options.manifest ?? '{"dependencies":{"a":"1.0.0"}}');
  if (!options.absent) await writeFile(lockfile, 'original lockfile');
  const target = { workspaceRoot: root, root, identity: JSON.stringify(['target', 'npm', root, lockfile, '.']), allowlistedPaths: [manifest, lockfile], operation: options.operation ?? 'upgrade', hostKind: 'vscode' };
  return { root, manifest, lockfile, target, folder: path.join(root, '.packageawy-recovery'),
    prepare: hooks => prepareJournal(target, hooks), inspect: hooks => inspectRecovery(target, hooks),
    async open(hooks) { const { view } = await inspectRecovery(target); return RecoverySession.open(target, true, view.claim, hooks); },
    read: name => readFile(path.join(root, name), 'utf8'),
  };
}
export function choices(view, action = 'keep', approveDeletion = false) {
  return view.files.map(file => ({ id: file.id, current: file.current, action, approveDeletion }));
}
export const normalizeBoundary = name => name.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<id>');
