/** Which Settings tab "Open setting" uses, from a fake inspect result. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsCommandFor } from '../out/host/platform/vscode/settingsScope.js';

const KEY = 'packageawy.security.publicAdvisoryCheck';

test('a folder value in a multi-root window opens folder settings', () => {
  assert.deepEqual(settingsCommandFor(KEY, { globalValue: true, workspaceValue: true, workspaceFolderValue: false }, true), {
    command: 'workbench.action.openFolderSettings', query: KEY,
  });
});

test('a workspace value opens workspace settings', () => {
  assert.deepEqual(settingsCommandFor(KEY, { globalValue: true, workspaceValue: false }, true), {
    command: 'workbench.action.openWorkspaceSettings', query: KEY,
  });
});

test('a single-folder window opens workspace settings for a folder value', () => {
  assert.equal(settingsCommandFor(KEY, { workspaceValue: false, workspaceFolderValue: false }, false).command,
    'workbench.action.openWorkspaceSettings');
});

test('only a user value, or none, opens user settings by id', () => {
  for (const inspection of [{ globalValue: false }, {}, undefined]) {
    assert.deepEqual(settingsCommandFor(KEY, inspection, true), { command: 'workbench.action.openSettings', query: `@id:${KEY}` });
  }
});
