import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { makeCoordinator, lockfile } from './helpers/removal-project.mjs';
import { recoveryFixture, choices } from './helpers/recovery.mjs';
import { prepareJournal } from '../out/host/recovery/journal.js';
import { inspectRecovery } from '../out/host/recovery/inspection.js';
import { RecoverySession } from '../out/host/recovery/session.js';
import { RECOVERY_MESSAGES } from '../out/host/recovery/model.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { appHarness } from './helpers/app-harness.mjs';

const snapshot = { status: 'ready', data: { rows: [], generatedAt: 'now',
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  project: { id: 'project', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
  extensionVersion: 'test', builtAt: 'test', hygieneFindings: [] } };
const button = view => view.elements().find(e => e.type === 'button' && e.props['data-undo-location'] === 'dashboard');
const labels = { removal: 'Undo removal', upgrade: 'Undo upgrade', remediation: 'Undo transitive fix' };

for (const hostKind of ['vscode', 'jetbrains']) for (const operation of ['removal', 'upgrade', 'remediation']) {
  test(`${hostKind} successful ${operation} offers transaction-bound undo immediately and after reopening without pausing`, async t => {
    const f = await rollbackFixture(t, operation === 'remediation' ? 'transitive' : operation);
    f.state.installExitCode = 0;
    if (operation === 'remediation') {
      // Use a real graph and security comparison. The package-manager and
      // advisory HTTP boundary are the only fakes on this success path.
      const before = JSON.parse(lockfile(true));
      before.packages['node_modules/react'].dependencies = { minimist: '*' };
      before.packages['node_modules/minimist'] = { version: '1.0.0' };
      await writeFile(f.project.lockfilePath, JSON.stringify(before));
      const stored = f.coordinator.remediationPlans.get('plan');
      stored.snapshot = await f.read();
      const after = structuredClone(before);
      after.packages['node_modules/minimist'].version = '1.2.8';
      stored.proposedLockfileText = JSON.stringify(after);
      const issue = { id: 'GHSA-AAAA-BBBB-CCCC', title: 'Test issue', severity: 'high', url: 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC', vulnerableVersions: '<1.2.8' };
      stored.targetAdvisories = [{ advisory: issue, flaggedPackage: 'minimist', flaggedVersion: '1.0.0', path: ['react', 'minimist'] }];
      stored.before = { graph: buildDependencyGraph({ root: f.project.root, manifest: parseManifest(stored.snapshot.manifestText),
        lockfileText: stored.snapshot.lockfileText, packageManager: 'npm', importerId: '.' }),
        advisoriesByName: new Map([['minimist', [issue]]]), advisories: 'complete' };
      f.coordinator.options.platform.getSetting = (_key, fallback) => fallback;
      f.coordinator.options.httpClient = { post: async () => ({ status: 200, body: '{}' }) };
    }
    f.coordinator.options.platform.hostKind = hostKind;
    await f.confirm();
    const result = f.messages.findLast(m => ['remove-result', 'upgrade-result', 'remediation-apply-result'].includes(m.status))?.result;
    assert.ok(result?.undoId, JSON.stringify(f.messages));
    const entry = f.messages.findLast(m => m.status === 'smart-cleanup-backups').entries[0];
    assert.equal(entry.analysisId, result.undoId);
    assert.equal(entry.operation, operation);
    assert.equal(f.coordinator.isBusy(), false);
    const saved = f.coordinator.cleanupBackups.get(result.undoId);
    assert.equal(saved.transactionId, result.undoId);
    assert.match(saved.target.allowlistedPaths[0], /[\\/]package\.json$/);
    const journalPath = path.join(f.project.root, '.packageawy-recovery', 'journal.json');
    const journal = await readFile(journalPath, 'utf8');
    assert.equal(JSON.parse(journal).outcome, 'kept');
    f.coordinator.disposeWhenIdle();

    const view = appHarness(t);
    const reopened = makeCoordinator(f.project, { mutationRoot: () => f.project.root });
    reopened.coordinator.options.platform.hostKind = hostKind;
    reopened.coordinator.options.platform.workspaceFolders = () => [{ id: 'project', name: 'fixture', path: f.project.root }];
    const post = reopened.coordinator.options.sink.postMessage;
    reopened.coordinator.options.sink.postMessage = message => { post(message); view.event(message); };
    view.event(snapshot);
    await reopened.coordinator.recovery.inspect();
    assert.equal(view.find('RecoveryScreen'), undefined);
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
    assert.equal(button(view).props.children, labels[operation]);
    button(view).props.onClick(); view.render();
    const request = view.sent.findLast(m => m.type === 'restore-smart-cleanup');
    assert.equal(request.analysisId, saved.transactionId);
    await reopened.coordinator.handleRestoreSmartCleanup(request);
    assert.equal(view.find('RecoveryScreen').props.recovery.undoOperation, operation);
    assert.equal(view.find('RecoveryScreen').props.recovery.undoReview, true);
    view.find('RecoveryScreen').props.close(); view.render();
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
    assert.equal(reopened.coordinator.isBusy(), false);
    assert.equal(await readFile(journalPath, 'utf8'), journal, 'opening and closing reviews does not claim or write');

    await reopened.coordinator.handleRestoreSmartCleanup(request);
    await reopened.coordinator.recovery.start(true, null);
    reopened.state.reinstallChoice = 'Reinstall';
    await reopened.coordinator.recovery.apply(choices(view.find('RecoveryScreen').props.recovery, 'restore'));
    assert.deepEqual(reopened.commands, ['ci'], 'Undo uses the existing optional frozen reinstall');
    await reopened.coordinator.recovery.dismiss(true, false);
    assert.equal(button(view), undefined);
    assert.equal(view.find('Dashboard').props.actionsDisabled, false);
    assert.equal(reopened.coordinator.isBusy(), false);
  });
}

for (const operation of ['upgrade', 'removal', 'remediation']) for (const boundary of ['before review', 'before claim', 'claim publication on Windows']) {
  test(`${operation} rejects a replaced undo ${boundary} without claiming the newer project`, async t => {
    const f = await recoveryFixture(t, { operation });
    const old = await f.prepare(); await old.finish('kept');
    const project = { root: f.root, manifestPath: f.manifest, lockfilePath: f.lockfile };
    const c = makeCoordinator(project, { mutationRoot: () => f.root });
    c.coordinator.options.platform.workspaceFolders = () => [{ id: 'project', name: 'fixture', path: f.root }];
    const warnings = [];
    c.coordinator.options.platform.showWarningMessage = message => warnings.push(message);
    await c.coordinator.recovery.inspect();
    const id = old.owner.transactionId;
    const replace = async () => {
      const journal = await prepareJournal({ ...f.target, operation: 'cleanup' });
      await journal.finish('kept');
      return readFile(path.join(f.folder, 'journal.json'), 'utf8');
    };
    let newer;
    if (boundary !== 'before review') await c.coordinator.handleRestoreSmartCleanup({ analysisId: id });
    if (boundary === 'claim publication on Windows') {
      const open = RecoverySession.open;
      t.mock.method(RecoverySession, 'open', (target, stopped, claim, hooks, transactionId) => open(target, stopped, claim, {
        ...hooks, platform: 'win32', boundary: async name => {
          if (name === 'synced:claim.json') newer = await replace();
        },
      }, transactionId));
    } else newer = await replace();
    if (boundary === 'before review') await c.coordinator.handleRestoreSmartCleanup({ analysisId: id });
    else await c.coordinator.recovery.start(true, null);
    assert.deepEqual(warnings, [RECOVERY_MESSAGES.undoUnavailable]);
    assert.equal(c.coordinator.cleanupBackups.has(id), false);
    assert.equal((await inspectRecovery(f.target)).view.claim, null);
    assert.equal(await readFile(path.join(f.folder, 'journal.json'), 'utf8'), newer);
    assert.equal(c.coordinator.isBusy(), false);
  });
}

test('Undo protocol accepts operation labels and exact result identities and rejects malformed or rolled-back bindings', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const operation of ['cleanup', ...Object.keys(labels)]) {
    const entries = [{ analysisId: id, label: path.join('packages', 'app'), operation }];
    assert.equal(isHostToWebviewMessage({ status: 'smart-cleanup-backups', entries }), true);
    assert.equal(isHostToWebviewMessage({ status: 'smart-cleanup-backups', entries: [{ ...entries[0], operation: 'unknown' }] }), false);
  }
  const result = { analysisId: 'review', packages: ['react'], outcome: 'verified', verification: 'not-configured', rollback: 'not-needed', message: 'Removed.', undoId: id };
  assert.equal(isHostToWebviewMessage({ status: 'remove-result', result }), true);
  for (const change of [{ undoId: '' }, { undoId: 'not-a-transaction' }, { outcome: 'rolled-back' }]) {
    assert.equal(isHostToWebviewMessage({ status: 'remove-result', result: { ...result, ...change } }), false);
  }
});

test('App drops a matching removal result before restore writes but preserves it for unrelated backups', async t => {
  const f = await rollbackFixture(t, 'removal');
  const view = appHarness(t);
  const row = { name: 'react', current: '18.2.0', range: '^18.0.0', wanted: '18.2.0', latest: '18.2.0', dev: false, optional: false,
    advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null };
  view.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
  view.find('Dashboard').props.onOpenManage('react'); view.render();
  view.find('ManageDependencyModal').props.removal.onAnalyze(); view.render();
  const impact = view.sent.findLast(m => m.type === 'analyze-removal-impact');
  view.event({ status: 'removal-impact-result', requestId: impact.requestId, packages: ['react'], generatedAt: new Date().toISOString(),
    assessments: [{ packageName: 'react', usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } }] });
  view.event(f.messages.find(m => m.status === 'remove-analysis'));
  view.find('ManageDependencyModal').props.removal.onConfirm(); view.render();
  f.state.installExitCode = 0;
  await f.confirm();
  view.event(f.messages.find(m => m.status === 'remove-result'));
  const before = view.find('ManageDependencyModal').props.removalRun;
  assert.equal(before.phase, 'result');
  view.event({ status: 'smart-cleanup-backup', analysisId: 'other', outcome: 'changed' });
  assert.equal(view.find('ManageDependencyModal').props.removalRun.result, before.result);
  view.event({ status: 'smart-cleanup-backup', analysisId: before.result.undoId, outcome: 'changed' });
  assert.equal(view.find('ManageDependencyModal').props.removalRun, null);
});

test('App drops a matching transitive result before restore writes but preserves it for unrelated backups', t => {
  const view = appHarness(t);
  const row = { name: 'react', current: '18.2.0', range: '^18.0.0', wanted: '18.2.0', latest: '18.2.0', dev: false, optional: false,
    advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null };
  view.event({ ...snapshot, data: { ...snapshot.data, rows: [row] } });
  view.find('Dashboard').props.onOpenManage('react'); view.render();
  const id = '11111111-1111-4111-8111-111111111111';
  const advisory = { advisoryId: 'GHSA-AAAA-BBBB-CCCC', identifiers: [], title: 'Issue', severity: 'high', flaggedPackage: 'minimist', affectedPaths: [['react', 'minimist']] };
  const plan = { analysisId: 'plan', rootPackage: 'react', currentVersion: '18.2.0', outcome: 'full', explanation: 'A fix is available.',
    generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), packageManager: 'npm', packageManagerVersion: null,
    lifecycleScriptsEnabled: false, directRootUnchanged: true,
    files: { manifestPath: 'package.json', lockfilePath: 'package-lock.json', manifestChanged: false, lockfileChanged: true },
    changes: [{ packageName: 'minimist', fromVersions: ['1.0.0'], toVersions: ['1.2.8'], affectedPaths: [['react', 'minimist']], targeted: true }],
    resolvedAdvisories: [advisory], remainingAdvisories: [], introducedAdvisories: [], blockingReasons: [], verification: { configured: false, suggestedScriptNames: [] } };
  const message = { status: 'remediation-plan', package: 'react', plan };
  assert.equal(isHostToWebviewMessage(message), true);
  view.event(message);
  view.event({ status: 'remediation-apply-result', package: 'react', analysisId: 'plan', result: {
    undoId: id, outcome: 'verified', message: 'The fix was verified.', verification: 'passed', rollback: 'not-needed',
    resolvedAdvisories: [advisory], remainingAdvisories: [], introducedAdvisories: [] } });
  const before = view.find('ManageDependencyModal').props.remediation;
  assert.equal(before.phase, 'result');
  view.event({ status: 'smart-cleanup-backup', analysisId: 'other', outcome: 'changed' });
  assert.equal(view.find('ManageDependencyModal').props.remediation, before);
  view.event({ status: 'smart-cleanup-backup', analysisId: id, outcome: 'changed' });
  assert.equal(view.find('ManageDependencyModal').props.remediation, undefined);
});
