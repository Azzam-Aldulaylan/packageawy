import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { runFixedProbeAsync } from '../out/host/npmResolverAsync.js';
import { resolveInstalledPnpmInvocationAsync } from '../out/host/pnpmResolverAsync.js';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { manualReinstallNote } from '../out/host/manualReinstallCopy.js';
import { withoutFsync } from './helpers/without-fsync.mjs';

withoutFsync();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    assert.ok(performance.now() < deadline, 'condition did not settle');
    await pause(10);
  }
}
async function bounded(pending, ms) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('discovery did not settle within its grace period')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function probeFixture(t, { descendant = false, escaped = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packageawy-probe-tree-'));
  const executable = path.join(dir, 'node');
  const marker = path.join(dir, 'leader');
  const childMarker = path.join(dir, 'descendant');
  const child = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(childMarker)},String(process.pid));setInterval(()=>{},1000);`;
  await fs.writeFile(executable, `#!${process.execPath}
process.on('SIGTERM',()=>{});
require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));
${descendant ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:${escaped},stdio:['ignore',1,2]});` : ''}
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const pids = [];
  t.after(async () => {
    for (const file of [marker, childMarker]) {
      const pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, executable, pids, async ready() {
    for (const file of descendant ? [marker, childMarker] : [marker]) {
      await until(() => fs.readFile(file, 'utf8').then(value => { if (Number(value)) pids.push(Number(value)); return !!Number(value); }, () => false));
    }
  }, async dead() {
    await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (error) { assert.equal(error.code, 'ESRCH'); return true; } }));
  } };
}

for (const mode of ['cancel', 'timeout']) {
  for (const descendant of [false, true]) test(`fixed probe ${mode} kills SIGTERM-ignoring ${descendant ? 'process tree' : 'leader'} and settles`, { skip: process.platform === 'win32' }, async t => {
    const probe = await probeFixture(t, { descendant });
    const abort = new AbortController();
    const start = performance.now();
    const pending = runFixedProbeAsync(probe.executable, [], { cwd: probe.dir, signal: abort.signal }, true);
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await probe.ready();
    if (mode === 'cancel') abort.abort();
    const result = await bounded(observed, mode === 'cancel' ? 1800 : 6500);
    if (mode === 'cancel') assert.equal(result.error?.name, 'AbortError');
    else { assert.equal(result.error, undefined); assert.equal(result.value, undefined); }
    assert.ok(performance.now() - start < (mode === 'cancel' ? 2500 : 6800));
    await probe.dead();
  });
}

test('cancelled probe settles even when an escaped descendant keeps its pipes open', { skip: process.platform === 'win32' }, async t => {
  const probe = await probeFixture(t, { descendant: true, escaped: true });
  const abort = new AbortController();
  const pending = runFixedProbeAsync(probe.executable, [], { cwd: probe.dir, signal: abort.signal }, true);
  const observed = pending.then(() => undefined, error => error);
  await probe.ready();
  abort.abort();
  assert.equal((await bounded(observed, 1800))?.name, 'AbortError');
  await until(() => { try { process.kill(probe.pids[0], 0); return false; } catch { return true; } });
});

test('pnpm login-shell discovery cancels a SIGTERM-ignoring process tree', { skip: process.platform === 'win32' }, async t => {
  const probe = await probeFixture(t, { descendant: true });
  const shell = process.env.SHELL;
  const stat = fs.stat;
  process.env.SHELL = probe.executable;
  // Isolate installation discovery so its only running probe is the login shell.
  fs.stat = async file => {
    if (file === path.join(probe.dir, 'pnpm-workspace.yaml')) return {};
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  };
  syncBuiltinESMExports();
  t.after(() => {
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
    fs.stat = stat;
    syncBuiltinESMExports();
  });
  const abort = new AbortController();
  const pending = resolveInstalledPnpmInvocationAsync(null, probe.dir, true, abort.signal);
  const observed = pending.then(() => undefined, error => error);
  await probe.ready();
  abort.abort();
  assert.equal((await bounded(observed, 1800))?.name, 'AbortError');
  await probe.dead();
});

for (const kind of ['upgrade', 'removal', 'transitive']) {
  for (const cancel of ['panel', 'user']) test(`${cancel} cancellation settles ${kind} rollback reinstall discovery`, { skip: process.platform === 'win32' }, async t => {
    const f = await rollbackFixture(t, kind);
    const probe = await probeFixture(t);
    const originalPath = process.env.PATH;
    process.env.PATH = `${probe.dir}${path.delimiter}${originalPath ?? ''}`;
    t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
    const warnings = [];
    f.coordinator.options.platform.showWarningMessage = message => warnings.push(message);
    f.coordinator.options.platform.showModalWarning = async () => {
      f.coordinator.session.invocationResolver = undefined;
      return 'Reinstall';
    };
    let signal;
    const create = f.coordinator.session.createToolchainOperation.bind(f.coordinator.session);
    f.coordinator.session.createToolchainOperation = (...args) => {
      const operation = create(...args);
      signal = operation.signal;
      return operation;
    };
    const analysisId = kind === 'upgrade' ? 'upgrade' : kind === 'removal' ? f.coordinator.removal.id : 'plan';
    const pending = f.confirm();
    await probe.ready();
    assert.equal(f.coordinator.reservation.isMutationBusy, true);
    if (cancel === 'panel') {
      f.coordinator.options.isDisposed = () => true;
      f.coordinator.disposeWhenIdle();
    } else if (kind === 'upgrade') await f.coordinator.handleCancelUpgrade({ analysisId: 'upgrade' });
    else if (kind === 'removal') await f.coordinator.handleCancelRemove({ analysisId });
    else f.coordinator.handleCancelRemediation();
    assert.equal(signal.aborted, true, 'reinstall discovery aborts before deferred session disposal');
    await bounded(pending, 1800);
    await probe.dead();
    assert.equal(f.commands.filter(command => command === 'ci').length, kind === 'transitive' ? 1 : 0);
    assert.equal(f.coordinator.reservation.held?.settled, true);
    assert.equal(f.coordinator.reservation.held?.result, 'rolled-back');
    assert.ok(warnings.some(message => message.includes(manualReinstallNote('npm'))));
    assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
  });
}
