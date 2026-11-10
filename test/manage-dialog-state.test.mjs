import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(join(process.cwd(), 'webview/src/manageDialogState.ts'), 'utf8');
const javaScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const {
  beginManageRemoval,
  dashboardProjectKey,
  dialogsAfterOpenRequest,
  manageDialogRow,
  manageRemovalAfterProgress,
  manageRemovalAfterResult,
  manageRemovalAfterSnapshot,
  manageRemovalHeldPackage,
  manageRowAfterSnapshot,
} = await import(
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

test('two roots with the same label and relative manifest path are different projects', () => {
  const client = dashboardProjectKey({ id: 'hash-client', label: 'app', manifestPath: 'package.json' });
  const server = dashboardProjectKey({ id: 'hash-server', label: 'app', manifestPath: 'package.json' });
  assert.notEqual(client, server);
  assert.equal(manageRowAfterSnapshot('lodash', client, server, ['lodash']), null);
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

const leftPad = { name: 'left-pad', range: '^1.3.0', current: '1.3.0' };
const removedResult = {
  analysisId: 'removal-1',
  packages: ['left-pad'],
  outcome: 'verified',
  verification: 'passed',
  rollback: 'not-needed',
  message: 'Removed left-pad.',
};

/** One Manage session: open, confirm a removal, rescans, result, close. */
function snapshotStep(state, nextProjectKey, names) {
  const hold = manageRemovalAfterSnapshot(state.hold, nextProjectKey);
  const manageRow = manageRowAfterSnapshot(state.manageRow, project, nextProjectKey, names, manageRemovalHeldPackage(hold));
  return { manageRow, hold: manageRow === null ? null : hold };
}

test('a removal from Manage keeps the dialog for the removed package', () => {
  let state = { manageRow: 'left-pad', hold: beginManageRemoval(leftPad, project, 'removal-1') };
  state = { ...state, hold: manageRemovalAfterProgress(state.hold, 'removal-1', 'installing') };
  assert.equal(state.hold.progress, 'installing');
  state = snapshotStep(state, project, ['lodash']);
  assert.equal(state.manageRow, 'left-pad');
  state = { ...state, hold: manageRemovalAfterResult(state.hold, removedResult) };
  assert.equal(state.hold.phase, 'result');
  assert.equal(state.hold.result, removedResult);
  state = snapshotStep(state, project, ['lodash']);
  assert.equal(state.manageRow, 'left-pad');
  assert.equal(manageDialogRow(state.manageRow, [{ name: 'lodash' }], state.hold), leftPad);
});

test('progress and results for another removal leave the hold alone', () => {
  const hold = beginManageRemoval(leftPad, project, 'removal-1');
  assert.equal(manageRemovalAfterProgress(hold, 'removal-2', 'verifying'), hold);
  assert.equal(manageRemovalAfterResult(hold, { ...removedResult, analysisId: 'removal-2' }), hold);
  assert.equal(manageRemovalAfterProgress(null, 'removal-1', 'verifying'), null);
});

test('closing after a removal result clears it, and a later rescan does not reopen Manage', () => {
  let state = { manageRow: 'left-pad', hold: manageRemovalAfterResult(beginManageRemoval(leftPad, project, 'removal-1'), removedResult) };
  assert.equal(state.hold.phase, 'result');
  // Close clears both the open row and the held removal.
  state = { manageRow: null, hold: null };
  state = snapshotStep(state, project, ['left-pad', 'lodash']);
  assert.equal(state.manageRow, null);
  assert.equal(manageDialogRow(state.manageRow, [leftPad], state.hold), undefined);
});

test('switching projects drops a removal hold and its dialog', () => {
  const state = snapshotStep(
    { manageRow: 'left-pad', hold: beginManageRemoval(leftPad, project, 'removal-1') },
    'other\u0000/other/package.json',
    ['left-pad']
  );
  assert.deepEqual(state, { manageRow: null, hold: null });
});

test('a held copy never stands in for a different package', () => {
  const hold = beginManageRemoval(leftPad, project, 'removal-1');
  assert.equal(manageRowAfterSnapshot('lodash', project, project, ['react'], manageRemovalHeldPackage(hold)), null);
  assert.equal(manageDialogRow('lodash', [], hold), undefined);
  const listed = { ...leftPad, current: '1.3.1' };
  assert.equal(manageDialogRow('left-pad', [listed], hold), listed);
});

test('the app holds Manage removals and clears them on close and new reviews', () => {
  assert.match(app, /manageRemovalHeldPackage\(removalHold\)/);
  assert.match(app, /setManageRow\(null\);\s+setManageRemoval\(null\);/);
  assert.match(app, /resultInDialog: true as const/);
  assert.match(app, /manageDialogRow\(manageRow, data\.rows, manageRemoval\)/);
  assert.match(app, /removalRunning \|\|\s+removalImpact\.phase === 'analyzing'/);
});
