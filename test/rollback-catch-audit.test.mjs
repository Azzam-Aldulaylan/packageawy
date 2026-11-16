import assert from 'node:assert/strict';
import ts from 'typescript';
import { before, test } from 'node:test';
import { catchTable, catchHandlers, injectCatchTypeError } from './helpers/catch-audit.mjs';
import { recoveryFixture } from './helpers/recovery.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';
import { isExpectedFsError, isFsError } from '../out/host/expectedFsError.js';
import { isMissingPathError } from '../out/host/pathIdentity.js';
import { throwIfAborted } from '../out/host/npmResolverAsync.js';
import { rethrowUnexpectedResolverError } from '../out/host/npmResolver.js';
import { RecoveryJournal } from '../out/host/recovery/journal.js';
import { Storage } from '../out/host/recovery/storage.js';
import { RecoverySession } from '../out/host/recovery/session.js';
import { RecoveryCoordinator } from '../out/host/recovery/coordinator.js';
import { RecoveryError, RecoveryOutcomeUnknownError, RECOVERY_MESSAGES } from '../out/host/recovery/model.js';
import { UpgradeTransactionPathError } from '../out/host/nodeUpgradeTransactionFiles.js';
import { RestoreFileError } from '../out/host/upgradeTransaction.js';
import { OperationReservation } from '../out/host/operationReservation.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';
import { FetchError } from '../out/core/registry/http.js';
import { AuditUnavailableError } from '../out/core/audit/npmAudit.js';
import { UnsupportedLockfileError } from '../out/core/lockfile/parse.js';
import { UnsupportedPnpmLockfileError } from '../out/core/lockfile/pnpm.js';
import { isChangeStartingMessage } from '../out/host/webviewProtocol.js';
import { YAMLException } from 'js-yaml';

withoutFsync();
let fixture, prepared;
before(async t => {
  fixture = await recoveryFixture(t);
  prepared = await fixture.prepare();
});

const handlers = new Map([...new Set(catchTable.map(row => row.file))].flatMap(file => catchHandlers(file).map(handler => [handler.id, handler])));

test('the audited modules cannot acquire an unclassified catch', () => {
  for (const row of catchTable) {
    assert.equal(handlers.get(row.id)?.func, row.func, `${row.id} moved. Re-audit its operation and classification.`);
  }
  // The coordinator also has read-only analysis handlers outside rollback reachability.
  const excluded = new Set(['handleLoadUpgradeTargets', 'loadUpgradeTargetsFor', 'handleAnalyzeUpgradeRequests', 'checkOpenAnalysisFreshness', 'analyzeBulkRemove', 'analyzeRemediation', 'prepareRemediationWork', 'constructor', 'findFiles', 'watchFiles', 'watchGitHead', 'showQuickPick', 'openSettings', 'settleFailedLoad', 'changeProject', 'openManifest', 'startStartup', 'createController', 'reconcileAfterGitHeadChange', 'reloadAfterFileChange']);
  for (const [id, handler] of handlers) {
    if (catchTable.some(row => row.id === id)) continue;
    // Check exclusion by ancestry text because TypeScript SyntaxKind numbers can change.
    let excludedHandler = false;
    for (let ancestor = handler.node.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isConstructorDeclaration(ancestor) || ancestor.name && excluded.has(ancestor.name.getText())) excludedHandler = true;
    }
    assert.ok(excludedHandler, `Add ${id} to the catch audit`);
  }
});

for (const row of catchTable.filter(row => row.mode === 'refuse')) test(`TypeError at ${row.id} (${row.func}) refuses before ownership`, async () => {
  const error = new TypeError(`audit ${row.id}`);
  const messages = [];
  const receiver = { options: { isDisposed: () => false, sink: { postMessage: message => messages.push(message) } },
    logChangeFailure: cause => assert.equal(cause, error) };
  const result = await injectCatchTypeError(handlers.get(row.id), { receiver, packageName: 'audit', status: 'remove-error', analysisId: undefined,
    toProtocolError: cause => ({ code: cause.name, message: cause.message }) }, error);
  assert.equal(result, undefined);
  assert.deepEqual(messages, [{ status: 'remove-error', package: 'audit', error: { code: 'TypeError', message: error.message } }]);
});

for (const row of catchTable.filter(row => row.mode.startsWith('presentation'))) test(`TypeError at ${row.id} preserves known completion and invalidates the snapshot`, async () => {
  let invalidated = false;
  const error = new TypeError('post-completion evidence read');
  const receiver = { logChangeFailure: cause => assert.equal(cause, error), options: { invalidateSnapshot: () => { invalidated = true; } } };
  // Refresh settlement also runs after a returned failure. Exercise the
  // complete boundary, including the common invalidation continuation.
  const result = row.mode === 'presentation'
    ? await UpgradeAssistantCoordinator.prototype.refreshAfterCompletion.call(receiver, async () => { throw error; })
    : await injectCatchTypeError(handlers.get(row.id), { receiver }, error);
  assert.equal(result, undefined);
  assert.equal(invalidated, row.mode === 'presentation');
});

for (const status of ['succeeded', 'failed', 'cancelled', 'superseded', undefined]) {
  test(`post-completion refresh result ${status} invalidates unsuccessful outcomes`, async () => {
    let invalidated = false;
    const receiver = { logChangeFailure: () => assert.fail('returned outcomes are not thrown errors'),
      options: { invalidateSnapshot: () => { invalidated = true; } } };
    const outcome = status === undefined ? undefined : { status };
    const result = await UpgradeAssistantCoordinator.prototype.refreshAfterCompletion.call(receiver, async () => outcome);
    assert.equal(invalidated, status !== 'succeeded');
    assert.equal(result, status === 'succeeded' ? outcome : undefined);
  });
}

for (const row of catchTable.filter(row => row.mode !== 'refuse' && !row.mode.startsWith('presentation'))) test(`TypeError at ${row.id} (${row.func}) retains unknown settlement`, async () => {
  const locks = new ProjectMutationLocks();
  const reservation = new OperationReservation({ locks, reserve: () => true, release() {}, flushDeferredChanges: async () => {},
    resumePendingBackground() {}, isDisposed: () => false, dispose() {}, log() {}, onUnknown: async () => {} });
  const handle = reservation.reserve('audit', fixture.root);
  const storage = new Storage(fixture.target);
  const journal = new RecoveryJournal(storage, prepared.owner, structuredClone(prepared.data), prepared.files);
  // Persistence ordering is tested in recovery-journal. These are handler classification contracts.
  journal.save = async () => {};
  handle.journal = journal;
  handle.state = 'mutating';
  const view = { state: 'open', message: '', claim: null, files: [], canDismiss: false, canApply: true };
  const session = new RecoverySession({ storage, journal, owner: prepared.owner, view }, 'audit');
  const coordinator = new RecoveryCoordinator({ platform: { showWarningMessage() {} }, locks, target: async () => undefined,
    post() {}, removed: async () => {} });
  coordinator.session = session;
  let receiver = journal;
  if (row.file.endsWith('/session.ts')) receiver = session;
  if (row.file.endsWith('/storage.ts')) receiver = storage;
  if (row.file.endsWith('/coordinator.ts')) receiver = coordinator;
  if (row.file.includes('/platform/')) receiver = { disposed: false, processes: new Map() };
  if (row.file.endsWith('/npmAuditRunner.ts')) receiver = { invalidate() {} };
  if (row.file.endsWith('/dashboardPanel.ts')) receiver = { disposed: false, recoveryInspectionAttempts: 99,
    upgradeCoordinator: { settleChangeFailure: () => handle.fail('Message failed'), recovery: { reportDiscoveryFailure() {} } },
    reportRuntimeFailure() {}, settleFailedRequest() {}, platform: { log() {} } };
  if (row.file.endsWith('/operationReservation.ts')) receiver = ['notifyUnknown', 'end', 'log'].includes(row.func) ? reservation : handle;
  if (row.file.endsWith('/upgradeAssistantCoordinator.ts')) receiver = {
    options: { isDisposed: () => false, sink: { postMessage() {} }, platform: { log() {} } },
    logChangeFailure() {}, onBackgroundError: () => () => {},
  };
  const error = new TypeError(`audit ${row.id}`);
  if (row.mode === 'preserve') await handle.fail('Primary outcome unknown');
  class RestoreConflictError extends RecoveryError {}
  class StorageFenceError extends RecoveryError {}
  const scope = { AuditUnavailableError, UnsupportedLockfileError, UnsupportedPnpmLockfileError, isChangeStartingMessage,
    isCancellation: () => false, isAbortOrTimeout: () => false, signal: undefined, cwd: fixture.root, runner: {},
    controller: { signal: { aborted: false } }, message: { type: 'confirm-remove' }, changeTarget: 'audit',
    RECOVERY_INSPECTION_MAX_ATTEMPTS: 3, RECOVERY_INSPECTION_RETRY_MS: 250,
    processId: 'audit', run: { stopObserving() {} }, checks: [], dispatched: true, options: { journal }, RestoreConflictError, StorageFenceError, receiver, isExpectedFsError, isFsError, isMissingPathError, isMissing: cause => isExpectedFsError(cause, 'missingFile'),
    rethrowUnexpectedResolverError, throwIfAborted, reject: cause => { throw cause; }, RecoveryError, RecoveryOutcomeUnknownError, UpgradeTransactionPathError, RestoreFileError, YAMLException, FetchError,
    RECOVERY_MESSAGES, strict: false, input: { throwOnUnexpectedError: false }, deps: { throwOnUnexpectedError: false },
    uncertainErrors: false, step: 'recovery-completion', handle, journal, session,
    uncertain: cause => session.invalidate(cause), errorMessage: cause => cause.message,
    runtimeFailureLine: () => '', toProtocolError: cause => ({ code: cause.name, message: cause.message }),
    discovery: { abort: { signal: { aborted: false } } },
    abort: { signal: { aborted: false } }, stored: { packageName: 'audit', eligibility: { packageName: 'audit' }, reservationKey: 'audit' },
    finish: value => value,
  };
  let result, rejected;
  try { result = await injectCatchTypeError(handlers.get(row.id), scope, error); }
  catch (cause) { rejected = cause; }
  if (row.mode !== 'preserve' && handle.state !== 'unknown' && !session.outcomeUnknown) {
    if (rejected !== undefined) assert.equal(rejected, error, `${row.id} wrapped an unexpected exception as ${rejected?.constructor.name}: ${rejected?.message}`);
    else assert.ok(result === 'unknown' || result?.status === 'unknown' || result?.completion === 'unknown', `${row.id} swallowed TypeError as ${JSON.stringify(result)}`);
    await handle.fail('Propagated unexpected exception');
  }
  if (row.mode === 'preserve' && rejected !== undefined) assert.ok(rejected === error || rejected instanceof RecoveryOutcomeUnknownError, `${row.id}: ${rejected?.stack}`);
  assert.ok(handle.state === 'unknown' || session.outcomeUnknown, row.id);
  assert.throws(() => journal.assertWritable(), row.id);
  assert.equal(journal.data.outcome, 'unknown', row.id);
  assert.ok(locks.holderOf(handle.lockKey), row.id);
});

for (const operation of ['missingPath', 'missingFile', 'exclusiveCreate', 'read', 'canonicalize', 'restoreRename', 'cleanup', 'probe', 'exclusiveLink', 'scanDirectory', 'processGone', 'terminateGroup']) {
  test(`${operation} classifier rejects programming exceptions even with forged errno`, () => {
    for (const ErrorType of [TypeError, RangeError, ReferenceError, SyntaxError]) {
      for (const code of ['ENOENT', 'EEXIST', 'EPERM', 'ESRCH']) assert.equal(isExpectedFsError(Object.assign(new ErrorType('bug'), { code }), operation), false);
    }
    assert.equal(isExpectedFsError(Object.assign(new Error('unknown I/O'), { code: 'EIO' }), operation), false);
  });
}

for (const operation of ['removal', 'cleanup', 'upgrade', 'transitive', 'recovery', 'cleanup-recovery', 'reinstall']) {
  test(`catch audit production wiring settles ${operation} without manual failure calls`, async t => {
    const { productionEntryPointFault } = await import('./helpers/catch-audit.mjs');
    const result = await productionEntryPointFault(t, operation);
    assert.ok(result.hits > 0, 'the protected filesystem or resolver operation must execute');
    assert.equal(result.unknown, true);
    assert.equal(result.journal.data.outcome, 'unknown');
    assert.throws(() => result.journal.assertWritable());
    assert.ok(result.holder, 'the real boundary must retain the project lock');
    assert.equal(result.messages.some(message => message.status?.endsWith('-result')), false);
  });
}
