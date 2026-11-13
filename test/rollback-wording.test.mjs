import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : path.join(dir, entry.name)))).flat();
}

test('rollback copy and README describe observed conflicts without promises', async () => {
  const sources = ['README.md', 'CHANGELOG.md', ...(await files('docs')), ...(await files('webview/src')).filter(file => /\.tsx?$/.test(file)),
    ...(await files('src/host')).filter(file => /Copy\.ts$|upgradeAssistant(?:Coordinator|Outcome)\.ts$/.test(file))];
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    for (const sentence of text.split(/\n|(?<=[.!?])\s+/)) {
      if (!/roll.?back|restor/i.test(sentence)) continue;
      assert.doesNotMatch(sentence, /never overwrit|never los(?:e|t)|guarantee(?:d|s)? (?:roll.?back|restor)|(?:roll.?back|restor)[^.\n]*guarantee|(?:atomic|all.or.nothing) (?:roll.?back|restor)|(?:roll.?back|restor)[^.\n]*(?:is atomic|atomically)/i, `${file}: ${sentence}`);
    }
  }
  const honest = 'Packageawy restores your dependency files and stops if it sees they changed.';
  for (const file of ['README.md', 'src/host/upgradeAssistantCoordinator.ts', 'src/host/recoveryCopy.ts', 'webview/src/components/FilesSection.tsx']) {
    assert.ok((await readFile(file, 'utf8')).includes(honest), `${file} must explain observed conflicts`);
  }
});
