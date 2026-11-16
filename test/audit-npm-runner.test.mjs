/**
 * NodeAuditRunner process handling, against a fake npm (a small node script).
 *
 * Audit runs before rows are returned, so a stuck or noisy npm must end in
 * "audit unavailable" within a bounded time, and must not leave processes
 * behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NodeAuditRunner,
  runNpmAudit,
  AuditUnavailableError,
  DEFAULT_AUDIT_TIMEOUT_MS,
  auditUnavailableReasonFor,
} from '../out/core/audit/npmAudit.js';

const FAKE_NPM = fileURLToPath(new URL('./fixtures/fake-npm/npm.cjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRunner(prefixArgs, options = {}) {
  return new NodeAuditRunner({
    spawnConfig: { command: process.execPath, prefixArgs: [FAKE_NPM, ...prefixArgs] },
    terminationGraceMs: 200,
    ...options,
  });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'packageawy-audit-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function readPids(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf8');
      if (text.length > 0) return JSON.parse(text);
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    await pause(10);
  }
  assert.fail('fake npm never reported its pids');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
}

async function assertGone(pid, label) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await pause(25);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  assert.fail(`${label} (pid ${pid}) was left running`);
}

test('the default deadline is one minute', () => {
  assert.equal(DEFAULT_AUDIT_TIMEOUT_MS, 60_000);
});

test('a hanging npm times out, and its whole process tree is stopped', async () => {
  await withTempDir(async (dir) => {
    const pidFile = path.join(dir, 'pids.json');
    const runner = fakeRunner(['hang', pidFile], { timeoutMs: 500 });
    const started = Date.now();
    const pending = runner.run(dir);
    const pids = await readPids(pidFile);

    await assert.rejects(pending, { name: 'TimeoutError' });
    assert.ok(Date.now() - started < 5_000, 'gave up close to the deadline');
    await assertGone(pids.child, 'fake npm');
    await assertGone(pids.grandchild, 'process started by fake npm');
  });
});

test('cancelling a running audit stops the whole process tree', async () => {
  await withTempDir(async (dir) => {
    const pidFile = path.join(dir, 'pids.json');
    const controller = new AbortController();
    const pending = fakeRunner(['hang', pidFile]).run(dir, controller.signal);
    const pids = await readPids(pidFile);

    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assertGone(pids.child, 'fake npm');
    await assertGone(pids.grandchild, 'process started by fake npm');
  });
});

test('an already cancelled signal never starts npm', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fakeRunner(['hang', 'unused']).run(process.cwd(), controller.signal), { name: 'AbortError' });
});

test('a flood of stderr is drained, so npm finishes and its report is read', async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner(['stderr-flood'], { timeoutMs: 10_000 });
    const result = await runner.run(dir);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(await runNpmAudit(runner, dir), []);
  });
});

test('stdout past the size limit is rejected as audit unavailable', async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner(['stdout-flood'], { stdoutLimitBytes: 64 * 1024, timeoutMs: 10_000 });
    await assert.rejects(runner.run(dir), AuditUnavailableError);
  });
});

test('a non-zero exit with no report is audit unavailable, not a crash', async () => {
  await withTempDir(async (dir) => {
    const runner = fakeRunner(['fail'], { timeoutMs: 10_000 });
    const result = await runner.run(dir);
    assert.equal(result.exitCode, 2);
    await assert.rejects(runNpmAudit(runner, dir), AuditUnavailableError);
  });
});

test('a missing npm executable rejects instead of hanging', async () => {
  const runner = new NodeAuditRunner({
    spawnConfig: { command: path.join(tmpdir(), 'packageawy-no-such-npm') },
    timeoutMs: 10_000,
  });
  const error = await runner.run(process.cwd()).then(() => assert.fail('expected a rejection'), (e) => e);
  assert.ok(error instanceof AuditUnavailableError);
  assert.equal(auditUnavailableReasonFor(error), 'npm-not-found');
});

test('a missing project folder is a generic failure, not a missing npm', async () => {
  // Node reports this as `spawn <command> ENOENT` too; only the folder check tells them apart.
  const runner = fakeRunner(['fail'], { timeoutMs: 10_000 });
  const missingDir = path.join(tmpdir(), `packageawy-no-such-dir-${process.pid}-${Date.now()}`);
  const error = await runner.run(missingDir).then(() => assert.fail('expected a rejection'), (e) => e);
  assert.equal(auditUnavailableReasonFor(error), 'failed');
});

test('audit failures are classified by kind, never by message text', async () => {
  await withTempDir(async (dir) => {
    const pidFile = path.join(dir, 'pids.json');
    const timedOut = await fakeRunner(['hang', pidFile], { timeoutMs: 300 }).run(dir).catch((e) => e);
    assert.equal(auditUnavailableReasonFor(timedOut), 'timeout');

    const tooLarge = await fakeRunner(['stdout-flood'], { stdoutLimitBytes: 64 * 1024, timeoutMs: 10_000 })
      .run(dir)
      .catch((e) => e);
    assert.equal(auditUnavailableReasonFor(tooLarge), 'failed');

    const badJson = await runNpmAudit(fakeRunner(['fail'], { timeoutMs: 10_000 }), dir).catch((e) => e);
    assert.equal(auditUnavailableReasonFor(badJson), 'failed');
  });
  // A message that merely mentions a timeout is not one.
  assert.equal(auditUnavailableReasonFor(new Error('npm audit timed out.')), 'failed');
  assert.equal(auditUnavailableReasonFor(new AuditUnavailableError('npm was not found')), 'failed');
});
