import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodePackageManagerProcessRunner } from '../out/host/packageManagerProcessRunner.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = await build({ entryPoints: ['src/host/packageManagerProcessRunner.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', define: { 'process.platform': '"win32"' }, plugins: [{ name: 'windows-lifecycle', setup(plugin) {
    plugin.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'spawn', namespace: 'fake' }));
    plugin.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export const spawn = (...args) => globalThis.__windowsRunnerSpawn(...args);' }));
  } }] });
const { NodePackageManagerProcessRunner: WindowsRunner } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
    connected: true, alive: true, unref() {}, disconnect() { child.connected = false; },
    kill() { child.alive = false; return true; } });
  return child;
}

function windowsLifecycle(t, { exitedLeader = true, killerOutcome = 'failure' } = {}) {
  const leader = fakeChild(202); const killer = fakeChild(303); const descendant = { alive: true };
  let leaderExited = false;
  const calls = []; const events = [];
  leader.kill = () => { events.push('leader kill'); leader.alive = false; return true; };
  globalThis.__windowsRunnerSpawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable.endsWith('taskkill.exe')) {
      events.push('taskkill');
      if (!exitedLeader) assert.equal(leader.alive, true, 'tree termination starts while the leader is alive');
      if (killerOutcome !== 'hang') setImmediate(() => {
        if (killerOutcome === 'error') killer.emit('error', new Error('taskkill unavailable'));
        killer.exitCode = 1;
        killer.emit('close', 1);
      });
      return killer;
    }
    if (exitedLeader) setImmediate(() => {
      leader.alive = false; leader.exitCode = 0; leaderExited = true;
      leader.emit('exit', 0); // No close: the descendant still owns both pipes.
    });
    return leader;
  };
  t.after(() => {
    leader.stdout.destroy(); leader.stderr.destroy(); killer.stdout.destroy(); killer.stderr.destroy();
    delete globalThis.__windowsRunnerSpawn;
  });
  return { leader, killer, descendant, calls, events, get leaderExited() { return leaderExited; } };
}

async function boundedTimeout(pending) {
  let watchdog;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('runner waited forever after timeout')), 700);
    })]), { name: 'TimeoutError' });
  } finally { clearTimeout(watchdog); }
}

test('Windows timeout attempts taskkill and settles after an exited leader leaves a surviving descendant', async t => {
  const f = windowsLifecycle(t);
  const runner = new WindowsRunner({ description: 'resolver', timeoutMs: 30, terminationGraceMs: 30 });
  await boundedTimeout(runner.run({ executable: 'npm.exe', prefixArgs: ['cli.js'] }, ['install'], tmpdir()));
  assert.equal(f.leaderExited, true);
  assert.equal(f.descendant.alive, true, 'taskkill cannot guarantee stopping an already orphaned descendant');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].executable, 'npm.exe');
  assert.deepEqual(f.calls[0].args, ['cli.js', 'install']);
  assert.equal(f.calls[0].options.detached, false);
  assert.deepEqual(f.calls[1].args, ['/PID', '202', '/T', '/F']);
  assert.equal(f.calls[1].options.stdio, 'ignore');
  assert.equal(f.leader.stdout.destroyed, true);
  assert.equal(f.leader.stderr.destroyed, true);
  assert.equal(f.leader.connected, false);
});

for (const killerOutcome of ['failure', 'error', 'hang']) {
  test(`Windows timeout starts taskkill before killing a live leader and bounds settlement on taskkill ${killerOutcome}`, async t => {
    const f = windowsLifecycle(t, { exitedLeader: false, killerOutcome });
    await boundedTimeout(new WindowsRunner({ description: 'resolver', timeoutMs: 20, terminationGraceMs: 20 })
      .run({ executable: 'npm.exe', prefixArgs: [] }, [], tmpdir()));
    assert.equal(f.events[0], 'taskkill');
    assert.equal(f.leader.stdout.destroyed, true);
    assert.equal(f.leader.stderr.destroyed, true);
    if (killerOutcome === 'hang') assert.equal(f.killer.alive, false, 'taskkill itself must also be bounded');
  });
}

test('Windows timeout releases inherited pipes at exactly one grace deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = windowsLifecycle(t, { exitedLeader: false, killerOutcome: 'hang' });
  const pending = new WindowsRunner({ description: 'resolver', timeoutMs: 20, terminationGraceMs: 30 })
    .run({ executable: 'npm.exe', prefixArgs: [] }, [], tmpdir());
  const rejection = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(20);
  assert.deepEqual(f.calls[1].args, ['/PID', '202', '/T', '/F']);
  t.mock.timers.tick(29);
  assert.equal(f.leader.stdout.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(f.leader.stdout.destroyed, true);
  assert.equal(f.leader.stderr.destroyed, true);
  await rejection;
});

test('POSIX timeout kills the process group after an exited leader leaves a descendant holding output', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'packageawy-exited-leader-'));
  let leaderPid; let descendantPid;
  t.after(async () => {
    for (const pid of [leaderPid, descendantPid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  });
  const descendant = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("descendant",String(process.pid));setInterval(()=>{},1000)';
  const leader = `require('node:fs').writeFileSync('leader',String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]}).unref();`;
  const runner = new NodePackageManagerProcessRunner({ description: 'resolver', timeoutMs: 1500, terminationGraceMs: 50 });
  const pending = runner.run({ executable: process.execPath, prefixArgs: [] }, ['-e', leader], directory);
  const rejection = assert.rejects(pending, { name: 'TimeoutError' });
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    try {
      leaderPid = Number(await readFile(path.join(directory, 'leader'), 'utf8'));
      descendantPid = Number(await readFile(path.join(directory, 'descendant'), 'utf8'));
      try { process.kill(leaderPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(5);
  }
  assert.ok(descendantPid);
  assert.throws(() => process.kill(leaderPid, 0), { code: 'ESRCH' });
  process.kill(descendantPid, 0);
  await rejection;
  // Allow the OS to reap the orphan after the forced group stop.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(descendantPid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await pause(5);
  }
  assert.fail('descendant survived the process group stop');
});

