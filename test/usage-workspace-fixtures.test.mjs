import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { USAGE_SOURCE_FILE_GLOB, USAGE_CONFIG_FILE_GLOB } from '../out/host/usage/workspaceFiles.js';
import { folder, usageWorkspace } from './helpers/usage-coverage.mjs';

for (const [name, pathModule, root] of [
  ['POSIX', path.posix, '/workspace'],
  ['Windows', path.win32, 'C:\\workspace'],
]) {
  test(`usage fixture round-trips native ${name} paths to portable file keys`, async () => {
    const entries = [
      ['src/external.ts', `import 'only-here';`],
      ['.storybook/main.json', '{ "plugins": ["only-here"] }'],
      ['.storybook/theme.scss', '@use "only-here";'],
    ];
    const workspaceFolder = { ...folder, path: root };
    const workspace = usageWorkspace(entries, { pathModule, workspaceFolder });
    for (const [glob, file, text] of [
      [USAGE_SOURCE_FILE_GLOB, ...entries[0]],
      [USAGE_CONFIG_FILE_GLOB, ...entries[1]],
      [USAGE_CONFIG_FILE_GLOB, ...entries[2]],
    ]) {
      const discovered = await workspace.platform.findFiles({ include: glob });
      const absolutePath = pathModule.resolve(root, file);
      assert.ok(discovered.includes(absolutePath));
      assert.ok(discovered.every(candidate => candidate === pathModule.resolve(candidate)), 'discovery must return fully resolved paths');
      // Canonical reads and script-src resolution must address the same fixture entry.
      assert.equal(new TextDecoder().decode(await workspace.platform.readFile(absolutePath)), text);
      const chunks = [];
      for await (const chunk of workspace.platform.readFileChunks(absolutePath)) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString('utf8'), text);
    }
    assert.deepEqual(workspace.reads, entries.map(([file]) => file));
    assert.deepEqual(workspace.chunkReads.map(({ file }) => file), workspace.reads);
  });
}
