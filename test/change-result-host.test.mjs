import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { makeProject, makeCoordinator, lockfile } from './helpers/removal-project.mjs';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { RecoveryJournal } from '../out/host/recovery/journal.js';
import { RestoreFileError } from '../out/host/upgradeTransaction.js';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';

test('transitive cancellation after a successful install leaves selected scripts unstarted', async t => {
  const f = await rollbackFixture(t, 'transitive');
  t.after(() => f.coordinator.disposeWhenIdle());
  f.state.reinstallChoice = undefined;
  const stored = f.coordinator.remediationPlans.get('plan');
  const manifest = JSON.parse(stored.snapshot.manifestText);
  manifest.scripts = { test: 'vitest', build: 'tsc', lint: 'eslint' };
  await writeFile(f.project.manifestPath, JSON.stringify(manifest));
  stored.snapshot = await f.read();
  stored.verificationScripts = ['test', 'build'].map(scriptName => ({ id: `package-script:${scriptName}`, scriptName }));
  f.coordinator.options.platform.getSetting = (key, fallback) => key === 'upgrade.verificationScripts' ? ['test', 'build'] : key === 'security.publicAdvisoryCheck' ? false : fallback;
  let installs = 0;
  f.coordinator.options.platform.runProcess = async request => {
    assert.equal(request.args.includes('run-script'), false, 'no script starts after cancellation');
    assert.equal(installs, 0, 'no reinstall starts after cancellation');
    installs++;
    return { onDidExit(listener) { setImmediate(() => { f.coordinator.handleCancelRemediation(); listener(0); }); return { dispose() {} }; } };
  };
  await f.confirm();
  assert.equal(installs, 1, JSON.stringify(f.messages));
  const result = f.messages.findLast(message => message.status === 'remediation-apply-result')?.result;
  assert.ok(result, JSON.stringify(f.messages));
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.verification, 'not-run');
  assert.equal(result.rollback, 'succeeded'); assert.equal(result.checks[0].status, 'passed');
  for (const name of ['test', 'build']) {
    const check = result.checks.find(check => check.scriptName === name);
    assert.equal(check.status, 'not-run'); assert.equal(check.reason, 'Cancelled before this script started.');
  }
  assert.equal(result.checks.find(check => check.scriptName === 'lint').reason, 'Not selected.');
});

for (const rollback of ['conflict', 'failed']) test(`bulk upgrade result carries ${rollback} rollback details before its error`, async t => {
  const f = await rollbackFixture(t, 'upgrade');
  t.after(() => f.coordinator.disposeWhenIdle());
  const stored = f.coordinator.analysis;
  const manifest = JSON.parse(stored.snapshot.manifestText);
  manifest.scripts = { test: 'vitest', build: 'tsc' };
  await writeFile(f.project.manifestPath, JSON.stringify(manifest));
  Object.assign(stored.snapshot, await f.read());
  stored.verificationScripts = ['test', 'build'].map(scriptName => ({ id: `package-script:${scriptName}`, scriptName }));
  const second = { packageName: 'left-pad', currentVersion: '1.3.0', targetVersion: '1.3.1', classification: 'prod' };
  stored.proposal.changes.push(second);
  stored.requests.push({ package: 'left-pad', target: '1.3.1' });
  f.coordinator.options.platform.getSetting = (key, fallback) => key === 'upgrade.verificationScripts' ? ['test', 'build'] : fallback;
  f.coordinator.options.platform.showModalWarning = async () => 'Rollback';
  const originalAdapter = RecoveryJournal.prototype.adapter;
  let restoreAttempted = false;
  RecoveryJournal.prototype.adapter = function () {
    const adapter = originalAdapter.call(this);
    return { ...adapter, compareAndSwap: async (...args) => {
      if (this.data.step === 'rollback' && rollback === 'failed') {
        restoreAttempted = true;
        throw new RestoreFileError(Object.assign(new Error('Restore denied'), { code: 'EACCES' }));
      }
      return adapter.compareAndSwap(...args);
    } };
  };
  t.after(() => { RecoveryJournal.prototype.adapter = originalAdapter; });
  f.coordinator.options.platform.runProcess = async request => {
    const script = request.args.includes('run-script');
    if (!script) await writeFile(f.project.lockfilePath, lockfile(true).replaceAll('18.2.0', '18.3.0'));
    if (script && rollback === 'conflict') await writeFile(f.project.manifestPath, JSON.stringify({ ...manifest, description: 'newer edit' }));
    return { onDidExit(listener) { setImmediate(() => listener(script ? 7 : 0)); return { dispose() {} }; } };
  };
  await f.confirm();
  const resultIndex = f.messages.findIndex(message => message.status === 'upgrade-result');
  assert.ok(resultIndex >= 0, JSON.stringify(f.messages));
  const result = f.messages[resultIndex].result;
  const errorIndex = f.messages.findIndex(message => message.status === 'upgrade-error');
  assert.ok(errorIndex > resultIndex);
  assert.equal(result.application, 'unconfirmed'); assert.equal(result.rollback, rollback);
  assert.equal(result.install, 'succeeded'); assert.equal(result.verification, 'failed');
  assert.equal(result.changes.length, 2);
  assert.equal(result.rollbackMessage, f.messages[errorIndex].error.message);
  assert.match(result.rollbackMessage, /Rollback is incomplete/);
  assert.match(result.rollbackMessage, /package\.json/);
  assert.equal(restoreAttempted, rollback === 'failed');
  assert.equal(isHostToWebviewMessage(f.messages[resultIndex]), true);
  assert.equal(result.checks.find(check => check.scriptName === 'test').exitCode, 7);
});

for (const scenario of ['passed', 'failed kept', 'partial restore']) test(`removal carries configured check observations through the host: ${scenario}`, async t => {
  const project = await makeProject(t);
  const manifest = JSON.parse(await readFile(project.manifestPath, 'utf8'));
  manifest.scripts = { test: 'vitest run', build: 'tsc', lint: 'eslint' };
  await writeFile(project.manifestPath, JSON.stringify(manifest));
  const f = makeCoordinator(project, { mutationRoot: () => project.root }); t.after(() => f.coordinator.disposeWhenIdle());
  const platform = f.coordinator.options.platform;
  platform.getSetting = (key, fallback) => key === 'upgrade.verificationScripts' ? ['test', 'build'] : fallback;
  let closed = 0; let revealed = 0; let scripts = 0;
  platform.showModalWarning = async () => scenario === 'failed kept' ? 'Keep Changes' : 'Rollback';
  platform.runProcess = async request => {
    const name = request.args.at(-1);
    const script = request.args.includes('run-script');
    if (!script) await writeFile(project.lockfilePath, lockfile(false));
    else scripts++;
    if (scenario === 'partial restore' && script && name === 'test') await writeFile(project.manifestPath, JSON.stringify({ ...manifest, description: 'newer user edit' }));
    const exitCode = script && name === 'test' && scenario !== 'passed' ? 6 : 0;
    return { onDidExit(listener) { setImmediate(() => listener(exitCode)); return { dispose() {} }; }, closeAfterSuccess() { closed++; }, reveal: async () => { revealed++; return true; }, release() {} };
  };
  await f.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const analysis = f.messages.findLast(message => message.status === 'remove-analysis')?.analysis;
  assert.ok(analysis, JSON.stringify(f.messages));
  await f.coordinator.handleConfirmRemove({ analysisId: analysis.analysisId, resultInDialog: true });
  const outcome = f.messages.findLast(message => message.status === (scenario === 'partial restore' ? 'remove-error' : 'remove-result'));
  assert.ok(outcome, JSON.stringify(f.messages)); assert.equal(isHostToWebviewMessage(outcome), true);
  const checks = outcome.result?.checks ?? outcome.details?.checks;
  assert.equal(checks[0].status, 'passed'); assert.equal(checks[0].exitCode, 0);
  const testCheck = checks.find(check => check.scriptName === 'test');
  assert.equal(testCheck.status, scenario === 'passed' ? 'passed' : 'failed'); assert.equal(testCheck.exitCode, scenario === 'passed' ? 0 : 6);
  const build = checks.find(check => check.scriptName === 'build'); assert.equal(build.status, scenario === 'passed' ? 'passed' : 'not-run');
  const lint = checks.find(check => check.scriptName === 'lint'); assert.equal(lint.status, 'not-run'); assert.equal(lint.reason, 'Not selected.');
  assert.equal(closed, scenario === 'passed' ? 3 : 1); assert.equal(scripts, scenario === 'passed' ? 2 : 1);
  if (scenario !== 'passed') {
    await f.coordinator.revealCheckTerminal(testCheck.id);
    assert.equal(revealed, 1); assert.deepEqual(f.messages.at(-1), { status: 'check-terminal', commandId: testCheck.id, available: true });
  }
  if (scenario === 'partial restore') { assert.equal(outcome.error.code, 'ROLLBACK_CONFLICT'); assert.deepEqual(outcome.details.packages, ['react']); assert.equal(outcome.details.rollback, 'conflict'); assert.equal(outcome.details.completion, 'incomplete'); }
});

test('removal carries a manifest staging conflict as not-started without running install or requiring recovery', async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  t.after(() => f.coordinator.disposeWhenIdle());
  const originalAdapter = RecoveryJournal.prototype.adapter;
  let conflicted = false;
  const newerManifest = `${JSON.stringify({ name: 'fixture', description: 'newer edit', dependencies: { react: '^18.0.0' } })}\n`;
  // Race at the actual staging CAS, after backup and snapshot, while keeping
  // the production file adapter and recovery journal in the execution path.
  RecoveryJournal.prototype.adapter = function () {
    const adapter = originalAdapter.call(this);
    return { ...adapter, compareAndSwap: async (file, expected, replacement) => {
      if (file === project.manifestPath && !conflicted) { conflicted = true; await writeFile(file, newerManifest); }
      return adapter.compareAndSwap(file, expected, replacement);
    } };
  };
  t.after(() => { RecoveryJournal.prototype.adapter = originalAdapter; });
  await f.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const analysis = f.messages.findLast(message => message.status === 'remove-analysis')?.analysis;
  assert.ok(analysis);
  await f.coordinator.handleConfirmRemove({ analysisId: analysis.analysisId, resultInDialog: true });
  const outcome = f.messages.findLast(message => message.status === 'remove-error');
  assert.ok(outcome, JSON.stringify(f.messages));
  assert.equal(conflicted, true);
  assert.equal(outcome.details.completion, 'not-started');
  assert.equal(outcome.details.install, 'not-run');
  assert.equal(outcome.details.rollback, 'not-needed');
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(project.manifestPath, 'utf8'), newerManifest);
  assert.equal(isHostToWebviewMessage(outcome), true);
  for (const completion of ['kept', 'rolled-back', 'not-started', 'incomplete', 'unknown']) {
    assert.equal(isHostToWebviewMessage({ ...outcome, details: { ...outcome.details, completion } }), true);
  }
  assert.equal(isHostToWebviewMessage({ ...outcome, details: { ...outcome.details, completion: 'clean' } }), false);
});
