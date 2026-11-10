/** Where "Open setting" lands, through the settings editor adapter with fakes. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { openScopedSettings, settingPosition } from '../out/host/platform/vscode/settingsScope.js';

const KEY = 'packageawy.security.publicAdvisoryCheck';
const PROJECT = '/work/second/app';

function fakeEditor({ inspection, multiRoot, folder, files = {} }) {
  const calls = [];
  return {
    calls,
    editor: {
      inspect: (resource) => { calls.push(['inspect', resource]); return inspection; },
      multiRoot,
      workspaceFolderFor: (resource) => (resource === PROJECT ? folder : undefined),
      readFile: (filePath) => files[filePath],
      executeCommand: (command, argument) => calls.push(['command', command, argument]),
      openFile: (filePath, position) => calls.push(['open', filePath, position]),
    },
  };
}

test('a folder value in a multi-root window opens that folder settings file at the setting, not a folder picker', () => {
  const file = join('/work/second', '.vscode', 'settings.json');
  const { editor, calls } = fakeEditor({
    inspection: { globalValue: true, workspaceValue: true, workspaceFolderValue: false },
    multiRoot: true,
    folder: '/work/second',
    files: { [file]: `{\n  "editor.tabSize": 2,\n  "${KEY}": false\n}\n` },
  });
  openScopedSettings(editor, KEY, PROJECT);
  assert.deepEqual(calls.slice(1), [['open', file, { line: 3, column: 3 }]]);
  assert.ok(!calls.some(([kind, command]) => kind === 'command' && command === 'workbench.action.openFolderSettings'));
});

test('a workspace value opens workspace settings', () => {
  const { editor, calls } = fakeEditor({ inspection: { globalValue: true, workspaceValue: false }, multiRoot: true, folder: '/work/second' });
  openScopedSettings(editor, KEY, PROJECT);
  assert.deepEqual(calls.at(-1), ['command', 'workbench.action.openWorkspaceSettings', { query: KEY }]);
});

test('a single-folder window opens workspace settings for a folder value', () => {
  const { editor, calls } = fakeEditor({ inspection: { workspaceValue: false, workspaceFolderValue: false }, multiRoot: false, folder: '/work/second' });
  openScopedSettings(editor, KEY, PROJECT);
  assert.deepEqual(calls.at(-1), ['command', 'workbench.action.openWorkspaceSettings', { query: KEY }]);
});

test('only a user value, or none, opens user settings by id', () => {
  for (const inspection of [{ globalValue: false }, {}, undefined]) {
    const { editor, calls } = fakeEditor({ inspection, multiRoot: true, folder: '/work/second' });
    openScopedSettings(editor, KEY, PROJECT);
    assert.deepEqual(calls.at(-1), ['command', 'workbench.action.openSettings', `@id:${KEY}`]);
  }
});

test('settingPosition finds the quoted key', () => {
  assert.deepEqual(settingPosition(`{\n"${KEY}": false}`, KEY), { line: 2, column: 1 });
  assert.equal(settingPosition('{}', KEY), undefined);
});
