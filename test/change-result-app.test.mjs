import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appHarness } from './helpers/app-harness.mjs';

const snapshot = { status: 'ready', data: { rows: [], generatedAt: 'now',
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  project: { id: 'project', label: 'fixture', manifestPath: path.join('project', 'package.json') }, canChangeProject: false,
  extensionVersion: 'test', builtAt: 'test', hygieneFindings: [] } };
const checks = [{ id: 'install', kind: 'install', command: 'npm install', status: 'passed', exitCode: 0 }];
function begin(view) {
  view.event(snapshot);
  view.find('Dashboard').props.onOpenBulkActions(); view.render();
  const bulk = view.find('ManageDependenciesModal');
  bulk.props.onClose(); bulk.props.onBulkRemove(['chalk', 'lodash'], new Map()); view.render();
  view.event({ status: 'remove-analysis', analysis: { analysisId: 'remove-a', analyzedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), package: 'chalk', changes: ['chalk', 'lodash'].map(packageName => ({ packageName, classification: 'prod', stillRequiredBy: [] })), files: { manifestPath: path.join('project', 'package.json'), lockfilePath: path.join('project', 'package-lock.json'), rollbackAvailable: true }, verification: { configured: false, suggestedScriptNames: [] } } });
  const review = view.find('RemoveAnalysisModal'); assert.ok(review);
  review.props.onConfirm(); view.render();
  assert.equal(view.sent.at(-1).type, 'confirm-remove');
}
for (const partial of [false, true]) test(`App retains correlated standalone removal ${partial ? 'failure' : 'result'} and releases the completed review`, t => {
  const view = appHarness(t); begin(view);
  if (partial) view.event({ status: 'remove-error', package: 'chalk', error: { code: 'ROLLBACK_CONFLICT', message: 'Newer edits kept.' }, details: { analysisId: 'remove-a', packages: ['chalk', 'lodash'], install: 'succeeded', verification: 'failed', rollback: 'conflict', checks } });
  else view.event({ status: 'remove-result', result: { analysisId: 'remove-a', packages: ['chalk', 'lodash'], outcome: 'unverified', verification: 'not-configured', rollback: 'not-needed', message: 'Removed.', checks } });
  const result = view.find('RemovalChangeResultModal'); assert.ok(result);
  assert.equal(view.find('RemoveAnalysisModal'), undefined);
  const context = view.elements().find(element => element.props?.value?.terminals instanceof Map || element.props?.value?.terminals?.size === 0);
  assert.ok(context); assert.equal(context.props.value.analyzeDisabled, false);
  context.props.value.analyze(); assert.equal(view.sent.at(-1).type, 'refresh');
  result.props.onClose(); view.render(); assert.equal(view.find('RemovalChangeResultModal'), undefined);
});
test('late removal results do not open a result for another confirmation', t => {
  const view = appHarness(t); begin(view);
  view.event({ status: 'remove-result', result: { analysisId: 'old-removal', packages: ['chalk'], outcome: 'unverified', verification: 'not-configured', rollback: 'not-needed', message: 'Old result.', checks } });
  assert.equal(view.find('RemovalChangeResultModal'), undefined);
});

const row = { dev: false, optional: false, upgradeTo: '5.0.0', upgradeReason: 'update', name: 'chalk', current: '4.1.2', range: '^4.1.2', wanted: '5.0.0', latest: '5.0.0', advisories: [], worstSeverity: null };
const upgradeResult = { package: 'chalk', refreshId: 'refresh-upgrade', application: 'applied', install: 'succeeded', verification: 'passed', refreshingDerivedData: true, checks,
  changes: [{ packageName: 'chalk', previousVersion: '4.1.2', currentVersion: '5.0.0', requestedVersion: '5.0.0', declaredRange: '^5.0.0', classification: 'prod' }] };
function openManage(view) {
  view.find('Dashboard').props.onOpenManage('chalk'); view.render();
  return view.find('ManageDependencyModal');
}
function startUpgrade(view, source) {
  view.event(source);
  openManage(view).props.upgrade.onAnalyze('5.0.0'); view.render();
  view.event({ status: 'upgrade-result', result: upgradeResult });
}
for (const rollback of ['conflict', 'failed']) test(`standalone bulk result retains ${rollback} rollback details after upgrade-error`, t => {
  const view = appHarness(t);
  view.event(snapshot);
  const error = { code: rollback === 'conflict' ? 'ROLLBACK_CONFLICT' : 'ROLLBACK_FAILED', message: 'Rollback is incomplete. Saved files are kept.' };
  const result = { ...upgradeResult, application: 'unconfirmed', verification: 'failed', rollback, rollbackMessage: error.message,
    changes: [...upgradeResult.changes, { ...upgradeResult.changes[0], packageName: 'lodash' }] };
  view.event({ status: 'upgrade-result', result });
  assert.deepEqual(view.find('ChangeResultModal').props.result, result);
  view.event({ status: 'upgrade-error', package: 'chalk', analysisId: 'bulk-review', error });
  assert.deepEqual(view.find('ChangeResultModal').props.result, result);
  assert.equal(view.find('ChangeResultModal').props.result.rollbackMessage, error.message);
});
test('Manage upgrade result keeps its origin through snapshot and enrichment terminal until dismissal', t => {
  const view = appHarness(t);
  const source = { ...snapshot, data: { ...snapshot.data, rows: [row] } };
  startUpgrade(view, source);
  for (const message of [source, { status: 'upgrade-enrichment-result', package: 'chalk', refreshId: 'refresh-upgrade', outcome: 'succeeded', structurallyCurrent: true }, source]) {
    assert.ok(view.find('ManageDependencyModal').props.upgradeResult);
    assert.equal(view.find('ChangeResultModal'), undefined);
    view.event(message);
    assert.equal(view.find('ChangeResultModal'), undefined);
  }
  view.find('ManageDependencyModal').props.onClose(); view.render();
  assert.equal(view.find('ChangeResultModal'), undefined);
  assert.equal(openManage(view).props.upgradeResult, null);
});

for (const paths of [path.posix, path.win32]) for (const phase of ['refreshing', 'succeeded', 'failed']) test(`project switch clears upgrade results and enrichment with ${paths.sep} paths after ${phase}`, t => {
  const view = appHarness(t);
  const source = { ...snapshot, data: { ...snapshot.data, rows: [row], project: { ...snapshot.data.project, id: paths.join('workspace', 'one'), manifestPath: paths.join('workspace', 'one', 'package.json') } } };
  startUpgrade(view, source);
  const terminal = { status: 'upgrade-enrichment-result', package: 'chalk', refreshId: 'refresh-upgrade', outcome: phase === 'failed' ? 'failed' : 'succeeded', structurallyCurrent: true };
  if (phase !== 'refreshing') view.event(terminal);
  const other = { ...source, data: { ...source.data, project: { ...source.data.project, id: paths.join('workspace', 'two'), manifestPath: paths.join('workspace', 'two', 'package.json') } } };
  view.event(other);
  assert.equal(view.find('ChangeResultModal'), undefined);
  assert.equal(view.find('ManageDependencyModal'), undefined);
  view.event(terminal);
  view.event({ ...other, status: 'stale' });
  const manage = openManage(view);
  assert.equal(manage.props.upgradeResult, null);
  assert.equal(manage.props.upgradeEnrichment, null);
  view.event(source);
  assert.equal(openManage(view).props.upgradeResult, null, 'switching back does not revive discarded refs');
});

test('a standalone completed upgrade is dismissed when the selected project changes', t => {
  const view = appHarness(t);
  view.event(snapshot);
  view.event({ status: 'upgrade-result', result: upgradeResult });
  view.event({ status: 'upgrade-enrichment-result', package: 'chalk', refreshId: 'refresh-upgrade', outcome: 'succeeded', structurallyCurrent: true });
  assert.ok(view.find('ChangeResultModal'));
  view.event({ ...snapshot, data: { ...snapshot.data, project: { ...snapshot.data.project, id: 'other', manifestPath: path.join('other', 'package.json') } } });
  assert.equal(view.find('ChangeResultModal'), undefined);
});

for (const action of ['Analyze', 'close', 'dismiss']) test(`transitive completion releases normal Manage information after ${action}`, t => {
  const view = appHarness(t);
  view.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
  openManage(view);
  const advisory = { advisoryId: 'GHSA-example', identifiers: ['GHSA-example'], title: 'Example', severity: 'high', flaggedPackage: 'nested', affectedPaths: [['chalk', 'nested']] };
  const plan = { analysisId: 'fix-result', rootPackage: 'chalk', currentVersion: '4.1.2', outcome: 'full', explanation: 'A safe fix is available.',
    generatedAt: '2026-11-17T10:00:00.000Z', expiresAt: '2026-11-17T11:00:00.000Z', packageManager: 'npm', packageManagerVersion: null,
    lifecycleScriptsEnabled: false, directRootUnchanged: true,
    files: { manifestPath: path.join('project', 'package.json'), lockfilePath: path.join('project', 'package-lock.json'), manifestChanged: false, lockfileChanged: true },
    changes: [{ packageName: 'nested', fromVersions: ['1.0.0'], toVersions: ['1.0.1'], targeted: true, affectedPaths: [['chalk', 'nested']] }],
    resolvedAdvisories: [advisory], remainingAdvisories: [], introducedAdvisories: [], blockingReasons: [], verification: { configured: false, suggestedScriptNames: [] } };
  view.event({ status: 'remediation-plan', package: 'chalk', plan });
  view.event({ status: 'remediation-apply-result', package: 'chalk', analysisId: plan.analysisId, result: { outcome: 'verified', rollback: 'not-needed', verification: 'passed', message: 'Fixed.', resolvedAdvisories: [advisory], remainingAdvisories: [], introducedAdvisories: [] } });
  let manage = view.find('ManageDependencyModal');
  assert.equal(manage.props.remediation.phase, 'result');
  view.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
  assert.equal(view.find('ManageDependencyModal').props.remediation.phase, 'result', 'background snapshots preserve readable completion');
  manage = view.find('ManageDependencyModal');
  if (action === 'Analyze') {
    view.elements().find(element => element.props?.value?.terminals?.size === 0).props.value.analyze();
    assert.equal(view.sent.at(-1).type, 'refresh');
  } else if (action === 'close') manage.props.onClose();
  else manage.props.onDismissRemediation();
  view.render();
  assert.equal(openManage(view).props.remediation, undefined);
});
