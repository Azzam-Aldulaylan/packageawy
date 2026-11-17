import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';

for (const scenario of ['success', 'nonzero', 'unknown', 'cancelled', 'record failed', 'disposed', 'close refused', 'release refused', 'verification']) {
  test(`console cleanup after settlement: ${scenario}`, async t => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'packageawy-success-close-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const abort = new AbortController();
    let closed = 0;
    let released = 0;
    let recorded = false;
    let session;
    session = new UpgradeExecutionSession({
      isWorkspaceTrusted: () => true,
      async runProcess(request) {
        assert.equal(request.cwd, cwd);
        return {
          onDidExit(listener) {
            queueMicrotask(() => {
              if (scenario === 'cancelled') abort.abort();
              listener(scenario === 'unknown' ? undefined : scenario === 'nonzero' ? 1 : 0);
            });
            return { dispose() {} };
          },
          release() {
            released += 1;
            if (scenario === 'release refused') throw new Error('release unavailable');
          },
          closeAfterSuccess() {
            assert.equal(recorded, true, 'completion is recorded before cleanup');
            closed += 1;
            if (scenario === 'close refused') throw new Error('closed by the user');
          },
        };
      },
    }, () => ({ executable: process.execPath, prefixArgs: [], version: '22.0.0' }));
    t.after(() => session.dispose());
    session.journal = {
      async record(_step, phase) {
        if (phase !== 'finished') return;
        if (scenario === 'record failed') throw new Error('journal unavailable');
        if (scenario === 'disposed') session.dispose();
        recorded = true;
      },
    };
    const result = ['verification', 'release refused'].includes(scenario)
      ? await session.verify({ cwd, packageName: 'test', packageManager: 'npm', scripts: [{ id: 'test', scriptName: 'test' }], signal: abort.signal })
      : await session.run({ cwd, packageName: 'pkg', currentVersion: '1.0.0', target: '2.0.0', classification: 'prod', packageManager: 'npm', ignoreScripts: true, signal: abort.signal });
    assert.equal(closed, ['success', 'close refused', 'verification', 'release refused'].includes(scenario) ? 1 : 0);
    assert.equal(released, ['success', 'verification', 'release refused'].includes(scenario) ? 0 : 1, 'settlement releases ownership when it keeps output open');
    if (['success', 'cancelled', 'disposed', 'close refused'].includes(scenario)) assert.equal(result.ok, true, 'cleanup does not change existing settlement');
    if (scenario === 'record failed' || scenario === 'unknown') assert.equal(result.status, 'unknown');
    if (scenario === 'nonzero') assert.equal(result.code, 'TASK_FAILED');
    if (['verification', 'release refused'].includes(scenario)) assert.equal(result.status, 'passed');
  });
}

for (const kind of ['manifest', 'lockfile']) test(`${kind} reconciliation acknowledges successful console cleanup`, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'packageawy-reconcile-close-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let closed = 0;
  const session = new UpgradeExecutionSession({
    isWorkspaceTrusted: () => true,
    async runProcess() {
      return {
        onDidExit(listener) { queueMicrotask(() => listener(0)); return { dispose() {} }; },
        closeAfterSuccess() { closed += 1; },
      };
    },
  }, () => ({ executable: process.execPath, prefixArgs: [], version: '22.0.0' }));
  t.after(() => session.dispose());
  const params = { cwd, packageManager: 'npm', ignoreScripts: true };
  const prepared = await (kind === 'manifest' ? session.prepareManifestReconciliation(params) : session.prepareLockfileReconciliation(params));
  assert.equal(prepared.ok, true);
  assert.equal((await prepared.execute()).ok, true);
  assert.equal(closed, 1);
});

test('a process returned after session disposal releases ownership without closing or stopping it', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'packageawy-late-process-release-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let launched;
  const launch = new Promise(resolve => { launched = resolve; });
  let resolveProcess;
  const pending = new Promise(resolve => { resolveProcess = resolve; });
  let released = 0;
  const session = new UpgradeExecutionSession({
    isWorkspaceTrusted: () => true,
    runProcess() { launched(); return pending; },
  }, () => ({ executable: process.execPath, prefixArgs: [], version: '22.0.0' }));
  t.after(() => session.dispose());
  const result = session.run({ cwd, packageName: 'pkg', currentVersion: '1.0.0', target: '2.0.0', classification: 'prod', packageManager: 'npm', ignoreScripts: true });
  await launch;
  session.dispose();
  assert.equal((await result).status, 'unknown');
  resolveProcess({
    release() { released += 1; },
    closeAfterSuccess() { assert.fail('Disposal must keep the console open'); },
    onDidExit() { assert.fail('The disposed session must not subscribe'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});
