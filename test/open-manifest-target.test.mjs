/** "Open in Packageawy" on a package.json: manifest contributions and how a clicked file maps to a discovered project. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  OPEN_MANIFEST_UNAVAILABLE_MESSAGE,
  findProjectForManifest,
  resolveManifestTarget,
} from '../out/host/openManifestTarget.js';

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const COMMAND = 'packageawy.openPackageJson';

test('the command is contributed with a title and category', () => {
  const command = pkg.contributes.commands.find((entry) => entry.command === COMMAND);
  assert.deepEqual(command, { command: COMMAND, title: 'Open in Packageawy', category: 'Packageawy' });
  // VS Code 1.74+ activates on contributed commands, so no onCommand event is needed.
  assert.match(pkg.engines.vscode, /^\^1\.(7[4-9]|[89]\d)\./);
});

test('the explorer and editor tab menus show it only for package.json', () => {
  for (const menu of ['explorer/context', 'editor/title/context']) {
    const entries = pkg.contributes.menus[menu].filter((entry) => entry.command === COMMAND);
    assert.equal(entries.length, 1, `${menu} should list the command once`);
    assert.equal(entries[0].when, 'resourceFilename == package.json');
    assert.ok(entries[0].group, `${menu} entry needs a group`);
  }
});

test('the Command Palette shows it only while a package.json is the active editor', () => {
  const entries = pkg.contributes.menus.commandPalette.filter((entry) => entry.command === COMMAND);
  assert.deepEqual(entries, [{ command: COMMAND, when: 'resourceFilename == package.json' }]);
});

const ROOT = path.resolve('/work/repo');
const OTHER = path.resolve('/work/other');
const folder = (p, name) => ({ id: `file://${p}`, name, path: p });
const FOLDERS = [folder(ROOT, 'repo'), folder(OTHER, 'other')];

/** findFiles answers from a fixed list of absolute paths per folder, like the editor's search. */
function fakePlatform(filesByFolder) {
  return {
    workspaceFolders: () => FOLDERS,
    async findFiles({ folder: searched, include }) {
      if (include !== '**/package.json') return [];
      return (filesByFolder[searched.path] ?? []).map((rel) => path.join(searched.path, rel));
    },
  };
}

const platform = fakePlatform({
  [ROOT]: ['package.json', 'packages/app/package.json', 'packages/app/tools/nested/package.json', 'node_modules/react/package.json'],
  [OTHER]: ['package.json'],
});

test('a root manifest resolves to the folder root project', async () => {
  const { project } = await resolveManifestTarget(platform, path.join(ROOT, 'package.json'));
  assert.equal(project?.folder.path, ROOT);
  assert.equal(project?.dir, '');
});

test('a workspace member and a nested project resolve to their own directories', async () => {
  const member = await resolveManifestTarget(platform, path.join(ROOT, 'packages', 'app', 'package.json'));
  assert.equal(member.project?.dir, 'packages/app');
  const nested = await resolveManifestTarget(platform, path.join(ROOT, 'packages/app/tools/nested/package.json'));
  assert.equal(nested.project?.dir, 'packages/app/tools/nested');
  assert.equal(nested.project?.manifestPath, 'packages/app/tools/nested/package.json');
});

test('the same relative path in a second workspace folder resolves to that folder', async () => {
  const { project } = await resolveManifestTarget(platform, path.join(OTHER, 'package.json'));
  assert.equal(project?.folder.path, OTHER);
});

test('node_modules, outside-workspace and non-manifest files are rejected', async () => {
  for (const file of [
    path.join(ROOT, 'node_modules', 'react', 'package.json'),
    path.resolve('/elsewhere/package.json'),
    path.join(ROOT, 'packages', 'missing', 'package.json'),
    path.join(ROOT, 'tsconfig.json'),
  ]) {
    const { project } = await resolveManifestTarget(platform, file);
    assert.equal(project, undefined, file);
  }
  assert.equal(OPEN_MANIFEST_UNAVAILABLE_MESSAGE, 'Choose a package.json in your workspace, outside node_modules.');
});

test('Windows paths compare without case, other platforms compare exactly', () => {
  const candidate = {
    id: 'x',
    folderId: 'f',
    folderName: 'repo',
    manifestPath: 'packages/app/package.json',
    dir: 'packages/app',
    folder: folder('C:\\Repo', 'repo'),
  };
  const clicked = path.join('c:\\repo', 'packages', 'app', 'package.json');
  assert.equal(findProjectForManifest([candidate], clicked, 'win32'), candidate);
  assert.equal(findProjectForManifest([candidate], clicked, 'linux'), undefined);
});
