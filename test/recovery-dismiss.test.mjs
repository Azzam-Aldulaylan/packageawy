import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { RECOVERY_MESSAGES } from '../out/host/recoveryCopy.js';

for (const platform of ['darwin', 'win32']) for (const selection of ['keep', 'mixed', 'restore']) {
  // The darwin case syncs directories, which a real Windows file system refuses with EPERM.
  const skip = platform === 'darwin' && process.platform === 'win32' && 'POSIX directory sync needs a POSIX file system';
  test(`${platform} normal finish requires all files to match the backup after ${selection}`, { skip }, async t => {
    const f = await recoveryFixture(t);
    await f.prepare();
    await writeFile(f.manifest, '{"dependencies":{}}'); await writeFile(f.lockfile, 'empty lockfile');
    const session = await f.open({ platform });
    const selected = choices(await session.presentation(), selection === 'keep' ? 'keep' : 'restore', true);
    if (selection === 'mixed') selected[0].action = 'keep';
    await session.apply(selected);
    if (selection !== 'restore') {
      await assert.rejects(session.dismiss(true, false), { message: RECOVERY_MESSAGES.confirmDiscard });
      assert.equal((await f.inspect()).view.state, 'completed');
      await session.dismiss(true, true);
    } else await session.dismiss(true, false);
    assert.equal((await f.inspect()).view.state, 'none');
    assert.equal(await f.read('package.json'), selection === 'restore' ? '{"dependencies":{"a":"1.0.0"}}' : '{"dependencies":{}}');
  });
}
