/**
 * Safety and completion logic used by scripts/performance/startup-timing.mjs:
 * the cleaned VS Code environment, temp-folder checks, process-tree cleanup,
 * priming retries, and when the dashboard counts as finished.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  assertInsideTempRoot,
  isInside,
  killProcessTree,
  sanitizedEnvironment,
  withRetries,
} from '../scripts/performance/startup-timing-support.mjs';

const require = createRequire(import.meta.url);
const { completionState, reportMetadata } = require('../scripts/performance/startup-timing-completion.cjs');

test('sanitizedEnvironment removes every variable that can route VS Code to another profile or window', () => {
  const env = sanitizedEnvironment(
    {
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      NODE_OPTIONS: '--openssl-legacy-provider',
      VSCODE_PORTABLE: '/Users/someone/vscode-portable',
      VSCODE_APPDATA: '/Users/someone/Library/Application Support',
      VSCODE_EXTENSIONS: '/Users/someone/.vscode/extensions',
      VSCODE_CLI_DATA_DIR: '/Users/someone/.vscode-cli',
      VSCODE_CWD: '/Users/someone',
      VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock',
      VSCODE_NLS_CONFIG: '{}',
      vscode_portable: '/lowercase/still/blocked',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
    },
    { PACKAGEAWY_EXTENSION_TEST: '1' }
  );
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/Users/someone',
    NODE_OPTIONS: '',
    PACKAGEAWY_EXTENSION_TEST: '1',
  });
});

test('assertInsideTempRoot accepts folders inside the session root and refuses anything else', () => {
  const root = path.resolve('/private/tmp/me/pkt-abc123');
  assert.equal(isInside(path.join(root, 'u-1'), root), true);
  assert.doesNotThrow(() =>
    assertInsideTempRoot(root, { 'user data folder': path.join(root, 'u-1'), 'extensions folder': path.join(root, 'e-1') })
  );
  assert.throws(
    () => assertInsideTempRoot(root, { 'user data folder': path.resolve('/Users/me/Library/Application Support/Code') }),
    /user data folder .* is not inside/
  );
  assert.throws(() => assertInsideTempRoot(root, { 'extensions folder': root }), /extensions folder/);
  assert.throws(() => assertInsideTempRoot(root, { 'user data folder': path.join(root, '..', 'other') }), /not inside/);
});

test('killProcessTree ends a detached child and the processes it started', { skip: process.platform === 'win32' }, async () => {
  // The child starts a grandchild and prints its pid, then both wait forever.
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
        'console.log(c.pid); setInterval(() => {}, 1000);',
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const grandchildPid = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
  assert.deepEqual(await killProcessTree(child, { graceMs: 2000 }), { ok: true });
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'child has exited');
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/, 'grandchild has exited');
});

test('killProcessTree escalates to SIGKILL for a grandchild that ignores SIGTERM after its parent exits', { skip: process.platform === 'win32' }, async () => {
  // The grandchild ignores SIGTERM; the child exits on SIGTERM as usual, so
  // the child's exit alone must not end the cleanup.
  const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' });` +
        "setTimeout(() => console.log(c.pid), 300); setInterval(() => {}, 1000);",
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const grandchildPid = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
  const started = Date.now();
  assert.deepEqual(await killProcessTree(child, { graceMs: 500, killWaitMs: 3000 }), { ok: true });
  assert.ok(Date.now() - started >= 500, 'waited for the grace period before SIGKILL');
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/, 'SIGTERM-resistant grandchild was killed');
});

test('withRetries retries a failed attempt and reports every error when all attempts fail', async () => {
  let calls = 0;
  const recovered = await withRetries(async () => {
    calls += 1;
    return calls < 3 ? { ok: false, error: `failure ${calls}` } : { ok: true };
  }, 2);
  assert.deepEqual(recovered, { ok: true, attempts: 3, errors: ['failure 1', 'failure 2'], stopped: false });

  const failed = await withRetries(async (attempt) => ({ ok: false, error: `attempt ${attempt}` }), 2);
  assert.deepEqual(failed, { ok: false, attempts: 3, errors: ['attempt 1', 'attempt 2', 'attempt 3'], stopped: false });
});

test('withRetries starts no further attempt once stopping is requested', async () => {
  let stopping = false;
  let calls = 0;
  const outcome = await withRetries(
    async () => {
      calls += 1;
      stopping = true; // An interrupt arrives while this attempt runs.
      return { ok: false, error: 'interrupted' };
    },
    2,
    { shouldStop: () => stopping }
  );
  assert.equal(calls, 1);
  assert.deepEqual(outcome, { ok: false, attempts: 1, errors: ['interrupted'], stopped: true });
});

const OPENED = 1000;
const rows = (count) => ({ rows: Array.from({ length: count }, (_, index) => ({ name: `pkg-${index}` })) });
const message = (at, status, data) => ({ at, message: data === undefined ? { status } : { status, data } });
const cacheReport = (at, metadata) => ({ at, text: `Packageawy cache\ncache read      0.1 ms\n------\nTotal      0.2 ms\n${metadata}` });
const scanReport = (at) => ({ at, text: 'Packageawy scan\nnpm audit     900.0 ms\n------\nTotal    1200.0 ms\ncancelled=false' });
const usageReport = (at) => ({
  at,
  text: 'Packageawy cleanup usage analysis\nusage workspace scan   80.0 ms\n------\nTotal   90.0 ms\ndirect dependencies=6  background=true',
});

test('reportMetadata reads the name=value line of a performance report', () => {
  assert.deepEqual(reportMetadata(cacheReport(0, 'hit=true  freshness=fresh')), { hit: 'true', freshness: 'fresh' });
});

test('a cold open is not complete until the delayed likely-unused analysis has finished', () => {
  const messages = [message(1010, 'loading'), message(1600, 'scan-progress'), message(2500, 'ready', rows(6))];
  const reports = [cacheReport(1005, 'hit=false'), scanReport(2501)];

  // Scan done, background usage analysis still running and silent: a quiet
  // period would have called this complete.
  const scanned = completionState({ messages, reports, openedAt: OPENED });
  assert.equal(scanned.scanDone, true);
  assert.equal(scanned.complete, false);
  assert.equal(scanned.waitingFor, 'likely-unused analysis');
  assert.equal(scanned.firstRows.at, 2500);

  const finished = completionState({
    messages: [...messages, message(9500, 'cleanup-result')],
    reports: [...reports, usageReport(9501)],
    openedAt: OPENED,
  });
  assert.equal(finished.complete, true);
  assert.equal(finished.completeAt, 9500);
});

test('the scan is not done before its report, even when a result message has arrived', () => {
  const state = completionState({
    messages: [message(1010, 'loading'), message(2500, 'ready', rows(6)), message(2600, 'cleanup-result')],
    reports: [cacheReport(1005, 'hit=false')],
    openedAt: OPENED,
  });
  assert.equal(state.complete, false);
  assert.equal(state.waitingFor, 'scan report');
});

test('a fresh cache hit needs no scan, and the usage report alone also ends the analysis', () => {
  const state = completionState({
    messages: [message(1100, 'ready', rows(6))],
    reports: [cacheReport(1099, 'hit=true  freshness=fresh'), usageReport(1400)],
    openedAt: OPENED,
  });
  assert.equal(state.complete, true);
  assert.equal(state.completeAt, 1400);
});

test('an expired cache shows cached rows first, then waits for the revalidating scan', () => {
  const cached = [message(1100, 'ready', rows(6)), message(1150, 'cleanup-result')];
  const reports = [cacheReport(1099, 'hit=true  freshness=expired')];
  const waiting = completionState({ messages: cached, reports, openedAt: OPENED });
  assert.equal(waiting.complete, false);
  assert.equal(waiting.firstRows.at, 1100);
  assert.equal(waiting.waitingFor, 'scan report');

  const revalidated = completionState({
    messages: [...cached, message(3000, 'ready', rows(7))],
    reports: [...reports, scanReport(3001)],
    openedAt: OPENED,
  });
  assert.equal(revalidated.complete, true);
  assert.equal(revalidated.lastData.at, 3000);
  assert.equal(revalidated.completeAt, 3000);
});

test('a later scan or usage analysis that starts again keeps the dashboard incomplete', () => {
  const base = {
    messages: [message(1010, 'loading'), message(2500, 'ready', rows(6)), message(3000, 'cleanup-result')],
    reports: [cacheReport(1005, 'hit=false'), scanReport(2501), usageReport(3001)],
    openedAt: OPENED,
  };
  assert.equal(completionState(base).complete, true);
  const rescanning = completionState({ ...base, messages: [...base.messages, message(3500, 'stale', rows(6))] });
  assert.equal(rescanning.waitingFor, 'scan in progress');
  const reanalysing = completionState({ ...base, messages: [...base.messages, message(3500, 'cleanup-analyzing')] });
  assert.equal(reanalysing.waitingFor, 'likely-unused analysis');
});

test('a restarted likely-unused analysis completes at the end of its latest cycle, not the first', () => {
  const state = completionState({
    messages: [
      message(1010, 'loading'),
      message(2500, 'ready', rows(6)),
      message(3000, 'cleanup-result'),
      message(4000, 'cleanup-analyzing'),
      message(6000, 'cleanup-result'),
    ],
    reports: [cacheReport(1005, 'hit=false'), scanReport(2501), usageReport(3001), usageReport(6001)],
    openedAt: OPENED,
  });
  assert.equal(state.complete, true);
  assert.equal(state.completeAt, 6000);

  const twoBackgroundCycles = completionState({
    messages: [message(1100, 'ready', rows(6)), message(1500, 'cleanup-result'), message(2500, 'cleanup-result')],
    reports: [cacheReport(1099, 'hit=true  freshness=fresh'), usageReport(1501), usageReport(2501)],
    openedAt: OPENED,
  });
  assert.equal(twoBackgroundCycles.completeAt, 2500);
});

test('reports printed before the dashboard was opened are ignored, and a fatal error is surfaced', () => {
  const early = completionState({
    messages: [message(1100, 'ready', rows(1))],
    reports: [cacheReport(500, 'hit=true  freshness=fresh'), usageReport(600)],
    openedAt: OPENED,
  });
  assert.equal(early.waitingFor, 'cache report');

  const fatal = completionState({ messages: [message(1100, 'fatal-error')], reports: [], openedAt: OPENED });
  assert.equal(fatal.fatal.message.status, 'fatal-error');
  assert.equal(fatal.complete, false);
});
