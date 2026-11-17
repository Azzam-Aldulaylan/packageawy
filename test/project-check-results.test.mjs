import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';
import { projectChecks, snapshotProjectScripts } from '../out/host/projectChecks.js';
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../out/host/webviewProtocol.js';
import { createRangePreservingInstall } from '../out/host/rangePreservingInstall.js';

const selected = ['test', 'build', 'lint'].map(scriptName => ({ id: `package-script:${scriptName}`, scriptName }));
const manifest = JSON.stringify({ scripts: { test: 'vitest', build: 'tsc', lint: 'eslint' } });
const transaction = (install, verification) => ({ install, verification });
for (const paths of [path.posix, path.win32]) for (const code of [0, 9, undefined]) test(`${paths.sep === '/' ? 'POSIX' : 'Windows'} commands keep script identities, exit ${code}, and reasons`, async t => {
  const cwd = paths.join(paths.sep === '/' ? path.posix.resolve('fixture') : 'C:\\work tree', 'app');
  const requests = []; let closed = 0; let released = 0; let revealed = 0;
  const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true, runProcess: async request => {
    requests.push(request);
    return { onDidExit: listener => { queueMicrotask(() => listener(requests.length === 1 ? code : 0)); return { dispose() {} }; }, closeAfterSuccess() { closed++; }, release() { released++; }, reveal: async () => { revealed++; return revealed === 1; } };
  } }, () => ({ executable: paths.join(cwd, 'node'), prefixArgs: [paths.join(cwd, 'npm-cli.js')] }));
  t.after(() => session.dispose());
  const result = await session.verify({ cwd, packageManager: 'npm', packageName: 'pkg', scripts: selected });
  assert.equal(result.status, code === 0 ? 'passed' : code === undefined ? 'unknown' : 'failed');
  assert.equal(result.checks.length, 3); assert.deepEqual(result.checks.map(check => check.scriptName), ['test', 'build', 'lint']);
  assert.equal(result.checks[0].exitCode, code);
  assert.equal(closed, code === 0 ? 3 : 0);
  assert.equal(requests.length, code === 0 ? 3 : 1);
  assert.equal(requests[0].cwd, cwd); assert.deepEqual(requests[0].args, [paths.join(cwd, 'npm-cli.js'), 'run-script', 'test']);
  if (code !== 0) { assert.equal(result.checks[1].status, 'not-run'); assert.match(result.checks[1].reason, /Stopped after/); }
  const checks = projectChecks(transaction({ status: 'succeeded', exitCode: 0 }, result), snapshotProjectScripts(manifest, ['test', 'build', 'lint'], selected), 'npm');
  assert.equal(checks[1].scriptName, 'test'); assert.equal(checks[1].exitCode, code);
  assert.equal(checks[2].status, code === 0 ? 'passed' : 'not-run');
  if (code === 9) {
    assert.equal(checks[1].terminalAvailable, true);
    assert.equal(await session.revealCheckTerminal(checks[1].id), true);
    assert.equal(await session.revealCheckTerminal(checks[1].id), false);
    assert.equal(released, 1);
  }
  assert.equal(await session.revealCheckTerminal('unrelated'), false);
});
test('install exit code and both range preservation commands survive the transaction adapter', async () => {
  const first = { id: 'first', kind: 'install', command: 'npm install', status: 'passed', exitCode: 0 };
  const second = { id: 'second', kind: 'install', command: 'npm install --package-lock-only', status: 'failed', exitCode: 2, terminalAvailable: true };
  const install = createRangePreservingInstall({ manifestPath: path.join('project', 'package.json'), stagedManifest: '{}', styledManifest: '{ }', resolve: async () => ({ ok: true, command: first }), restyle: async () => ({ ok: false, code: 'TASK_FAILED', message: 'Failed.', command: second }) });
  const outcome = await install.execute({ compareAndSwap: async () => 'restored' });
  assert.equal(outcome.status, 'failed'); assert.deepEqual(outcome.commands, [first, second]);
  const rows = projectChecks(transaction(outcome, { status: 'not-run', reason: 'install-failed' }), snapshotProjectScripts(manifest, ['test'], [selected[0]]), 'npm');
  assert.deepEqual(rows.slice(0, 2), [first, second]); assert.equal(rows[2].status, 'not-run'); assert.match(rows[2].reason, /install failed/);
});
test('manifest snapshot distinguishes absence, unselected scripts, and unreadable manifests', () => {
  const snapshot = snapshotProjectScripts('{"scripts":{"build":"tsc","lint":"eslint"}}', ['missing'], []);
  const rows = projectChecks(transaction({ status: 'succeeded' }, { status: 'not-run', reason: 'not-configured' }), snapshot, 'pnpm');
  assert.equal(rows.find(row => row.scriptName === 'test').status, 'no-script');
  assert.equal(rows.find(row => row.scriptName === 'build').status, 'not-run');
  assert.equal(rows.find(row => row.scriptName === 'missing').status, 'no-script');
  assert.match(rows.find(row => row.scriptName === 'lint').reason, /Not selected/);
  assert.deepEqual(snapshotProjectScripts('broken JSON', [], []), []);
  assert.deepEqual(snapshotProjectScripts('{"scripts":null}', [], []), []);
});
test('cancellation before launch records not-run reasons and never starts a process', async t => {
  const abort = new AbortController(); abort.abort();
  const session = new UpgradeExecutionSession({ isWorkspaceTrusted: () => true, runProcess() { assert.fail('cancelled'); } }, () => ({ executable: process.execPath, prefixArgs: [] }));
  t.after(() => session.dispose());
  const result = await session.verify({ cwd: process.cwd(), packageManager: 'npm', packageName: 'pkg', scripts: selected, signal: abort.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.checks.length, 3);
  assert.ok(result.checks.every(check => check.status === 'not-run' && /Cancelled/.test(check.reason)));
});
for (const paths of [path.posix, path.win32]) test(`cancellation between install and verification keeps unstarted script reasons with ${paths.sep} paths`, async () => {
  const { runUpgradeTransaction } = await import('../out/host/upgradeTransaction.js');
  const manifestPath = paths.join('workspace', 'app', 'package.json');
  const abort = new AbortController();
  let restores = 0;
  const result = await runUpgradeTransaction({
    allowlistedPaths: [manifestPath], signal: abort.signal,
    files: { read: async () => ({ exists: true, contents: new TextEncoder().encode(manifest) }), compareAndSwap: async file => { assert.equal(file, manifestPath); restores++; return 'restored'; } },
    install: { execute: async () => { abort.abort(); return { status: 'succeeded', exitCode: 0 }; } },
    verifier: { verify: async () => assert.fail('Verification must not start after cancellation') },
  });
  assert.equal(result.install.status, 'succeeded');
  assert.deepEqual(result.verification, { status: 'not-run', reason: 'cancelled' });
  assert.equal(result.completion, 'rolled-back'); assert.equal(restores, 1);
  const rows = projectChecks(result, snapshotProjectScripts(manifest, ['test', 'build'], selected.slice(0, 2)), 'npm');
  for (const name of ['test', 'build']) {
    const row = rows.find(row => row.scriptName === name);
    assert.equal(row.status, 'not-run'); assert.equal(row.reason, 'Cancelled before this script started.');
  }
  assert.equal(rows.find(row => row.scriptName === 'lint').reason, 'Not selected.');
});
const check = { id: 'command-a', kind: 'script', scriptName: 'test', command: 'npm run test', status: 'failed', exitCode: 3, terminalAvailable: true };
const upgradeResult = { package: 'pkg', refreshId: 'refresh', install: 'succeeded', application: 'applied', verification: 'failed', changes: [{ packageName: 'pkg', previousVersion: '1.0.0', requestedVersion: '2.0.0', currentVersion: '2.0.0', declaredRange: '2.0.0', classification: 'prod' }], refreshingDerivedData: false };
test('upgrade rollback protocol accepts real statuses and requires incomplete rollback details', () => {
  const valid = [
    { ...upgradeResult, rollback: 'not-needed' },
    { ...upgradeResult, application: 'rolled-back', rollback: 'succeeded', rollbackMessage: 'Files restored.' },
    ...['conflict', 'failed'].map(rollback => ({ ...upgradeResult, application: 'unconfirmed', rollback, rollbackMessage: 'Rollback is incomplete.' })),
  ];
  for (const result of valid) assert.equal(isHostToWebviewMessage({ status: 'upgrade-result', result }), true);
  for (const result of [
    { ...upgradeResult, rollback: 'invalid' },
    { ...upgradeResult, rollback: 'succeeded' },
    { ...upgradeResult, rollback: 'conflict', rollbackMessage: 'Incomplete.' },
    { ...upgradeResult, application: 'unconfirmed', rollback: 'failed' },
    { ...upgradeResult, application: 'unconfirmed', rollback: 'failed', rollbackMessage: '' },
    { ...upgradeResult, rollbackMessage: 'Unexpected message.' },
  ]) assert.equal(isHostToWebviewMessage({ status: 'upgrade-result', result }), false, JSON.stringify(result));
});
for (const status of ['upgrade-result', 'remove-result', 'remediation-apply-result']) test(`${status} validates structured checks and rejects contradictory observations`, () => {
  const envelope = status === 'upgrade-result' ? { status, result: { ...upgradeResult, checks: [check] } } : status === 'remove-result' ? { status, result: { analysisId: 'remove', packages: ['pkg'], outcome: 'unverified', verification: 'failed', rollback: 'not-needed', message: 'Kept.', checks: [check] } } : { status, package: 'pkg', analysisId: 'fix', result: { outcome: 'unverified', message: 'Kept.', verification: 'failed', rollback: 'not-needed', resolvedAdvisories: [], remainingAdvisories: [], introducedAdvisories: [], checks: [check] } };
  assert.equal(isHostToWebviewMessage(envelope), true, JSON.stringify(envelope));
  for (const invalid of [{ ...check, status: 'passed' }, { ...check, exitCode: 0 }, { ...check, scriptName: undefined }, { ...check, status: 'not-run' }, { ...check, status: 'unknown' }, { ...check, capturedOutput: 'must not travel' }]) {
    assert.equal(isHostToWebviewMessage({ ...envelope, result: { ...envelope.result, checks: [invalid] } }), false, JSON.stringify(invalid));
  }
  assert.equal(isHostToWebviewMessage({ ...envelope, result: { ...envelope.result, checks: [check, check] } }), false);
  for (const valid of [{ ...check, status: 'passed', exitCode: 0, terminalAvailable: undefined }, { ...check, status: 'not-run', reason: 'Not selected.', exitCode: undefined, terminalAvailable: undefined }, { ...check, status: 'no-script', reason: 'No test script in package.json.', exitCode: undefined, terminalAvailable: undefined }, { ...check, status: 'unknown', exitCode: undefined, terminalAvailable: undefined }]) {
    assert.equal(isHostToWebviewMessage({ ...envelope, result: { ...envelope.result, checks: [valid] } }), true);
  }
});
test('terminal messages and partial removal details reject malformed protocol fields', () => {
  assert.equal(isWebviewToHostMessage({ type: 'reveal-check-terminal', commandId: 'command-a' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'reveal-check-terminal', commandId: '' }), false);
  assert.equal(isWebviewToHostMessage({ type: 'reveal-check-terminal', commandId: 'command-a', path: 'arbitrary' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'check-terminal', commandId: 'command-a', available: false }), true);
  assert.equal(isHostToWebviewMessage({ status: 'check-terminal', commandId: 'command-a', available: 'yes' }), false);
  const envelope = { status: 'remove-error', package: 'pkg', error: { code: 'ROLLBACK_CONFLICT', message: 'Newer edits kept.' }, details: { analysisId: 'remove', packages: ['pkg', 'other'], install: 'succeeded', verification: 'failed', rollback: 'conflict', checks: [check] } };
  assert.equal(isHostToWebviewMessage(envelope), true);
  assert.equal(isHostToWebviewMessage({ ...envelope, details: { ...envelope.details, checks: [{ ...check, exitCode: '3' }] } }), false);
});

test('transaction keeps each command observation and exit code unchanged', async () => {
  const { runUpgradeTransaction } = await import('../out/host/upgradeTransaction.js');
  const manifestPath = path.join(process.cwd(), 'fixture', 'package.json');
  const bytes = new TextEncoder().encode('{}');
  const installCommand = { id: 'actual-install', kind: 'install', command: 'pnpm install', status: 'passed', exitCode: 0 };
  const verification = { status: 'failed', checks: [{ id: 'package-script:test', scriptName: 'test', commandId: 'actual-test', status: 'failed', exitCode: 23, terminalAvailable: true }, { id: 'package-script:build', scriptName: 'build', status: 'not-run', reason: 'Stopped after an earlier failure.' }] };
  const result = await runUpgradeTransaction({ allowlistedPaths: [manifestPath], files: { read: async () => ({ exists: true, contents: bytes }), compareAndSwap: async () => 'restored' }, install: { execute: async () => ({ status: 'succeeded', exitCode: 0, commands: [installCommand] }) }, verifier: { verify: async () => verification }, verificationFailureDecider: { decide: async () => 'keep' } });
  assert.equal(result.completion, 'kept'); assert.deepEqual(result.install.commands, [installCommand]); assert.equal(result.install.exitCode, 0); assert.deepEqual(result.verification, verification);
});

test('unobserved selected commands and malformed script definitions never claim absence or nonexecution', () => {
  const snapshot = snapshotProjectScripts('{"scripts":{"test":42,"build":"tsc"}}', ['build'], [selected[1]]);
  const rows = projectChecks(transaction({ status: 'succeeded' }, { status: 'unknown', checks: [], message: 'Observation lost.' }), snapshot, 'npm');
  assert.equal(rows.find(row => row.scriptName === 'test').status, 'unknown');
  assert.match(rows.find(row => row.scriptName === 'test').reason, /not a string/);
  assert.equal(rows.find(row => row.scriptName === 'build').status, 'unknown');
  assert.match(rows.find(row => row.scriptName === 'build').reason, /not observed/);
});

for (const present of [false, true]) for (const status of ['upgrade-result', 'remove-result']) test(`${status} accepts script snapshots together with command evidence (${present})`, () => {
  const result = status === 'upgrade-result' ? { ...upgradeResult, projectScriptsPresent: present, checks: [check] }
    : { analysisId: 'remove', packages: ['pkg'], outcome: 'unverified', verification: 'failed', rollback: 'not-needed', message: 'Kept.', projectScriptsPresent: present, checks: [check] };
  assert.equal(isHostToWebviewMessage({ status, result }), true);
  assert.equal(isHostToWebviewMessage({ status, result: { ...result, projectScriptsPresent: 'false' } }), false);
});
test('correlated Undo errors and structured removal errors both survive protocol integration', () => {
  const error = { code: 'CHANGES_PAUSED', message: 'Dependency changes are paused.' };
  const details = { analysisId: 'remove', packages: ['pkg'], install: 'succeeded', verification: 'failed', rollback: 'conflict', checks: [check] };
  assert.equal(isHostToWebviewMessage({ status: 'remove-error', package: 'pkg', error, undoId: 'undo-review' }), true);
  assert.equal(isHostToWebviewMessage({ status: 'remove-error', package: 'pkg', error, details }), true);
  assert.equal(isHostToWebviewMessage({ status: 'remove-error', package: 'pkg', error, undoId: '' }), false);
  assert.equal(isHostToWebviewMessage({ status: 'remove-error', package: 'pkg', error, details: { ...details, checks: [{ ...check, exitCode: '3' }] } }), false);
});
