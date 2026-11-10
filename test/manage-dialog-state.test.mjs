import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(join(process.cwd(), 'webview/src/manageDialogState.ts'), 'utf8');
const javaScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { manageRowAfterSnapshot, dialogsAfterOpenRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
);
const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

const project = 'app\u0000/repo/package.json';

test('an open Manage dialog survives a rescan that still lists its package', () => {
  assert.equal(manageRowAfterSnapshot('left-pad', project, project, ['left-pad', 'lodash']), 'left-pad');
});

test('removing the package forgets the Manage dialog', () => {
  assert.equal(manageRowAfterSnapshot('left-pad', project, project, ['lodash']), null);
});

test('a package that disappears and comes back does not reopen Manage', () => {
  const afterRemoval = manageRowAfterSnapshot('left-pad', project, project, ['lodash']);
  assert.equal(afterRemoval, null);
  const afterReset = manageRowAfterSnapshot(afterRemoval, project, project, ['left-pad', 'lodash']);
  assert.equal(afterReset, null);
});

test('switching projects forgets Manage even when the new project has the same package', () => {
  assert.equal(manageRowAfterSnapshot('left-pad', project, 'other\u0000/other/package.json', ['left-pad']), null);
});

test('the first snapshot keeps a remembered row that it lists', () => {
  assert.equal(manageRowAfterSnapshot('left-pad', null, project, ['left-pad']), 'left-pad');
});

test('opening Smart Cleanup with Manage open leaves only Smart Cleanup', () => {
  assert.deepEqual(
    dialogsAfterOpenRequest({ manageOpen: true, smartCleanupOpen: false }, 'smart-cleanup', false),
    { manageOpen: false, smartCleanupOpen: true }
  );
});

test('Smart Cleanup does not open over a Manage dialog with running work', () => {
  const current = { manageOpen: true, smartCleanupOpen: false };
  assert.equal(dialogsAfterOpenRequest(current, 'smart-cleanup', true), current);
});

test('a dashboard Manage request is refused while Smart Cleanup is open', () => {
  const current = { manageOpen: false, smartCleanupOpen: true };
  assert.equal(dialogsAfterOpenRequest(current, 'manage', false), current);
  assert.deepEqual(
    dialogsAfterOpenRequest({ manageOpen: false, smartCleanupOpen: false }, 'manage', false),
    { manageOpen: true, smartCleanupOpen: false }
  );
});

test('the app wires the rules into snapshots and both open paths', () => {
  assert.match(app, /manageRowAfterSnapshot\(/);
  assert.match(app, /manageRowRef\.current = null;\s+setManageRow\(null\);/);
  assert.match(app, /'smart-cleanup',\s+manageCloseBlocked/);
  assert.match(app, /onOpenManage=\{openManageFromDashboard\}/);
});
