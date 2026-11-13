import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import io from 'node:fs/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ToolchainOperation } from '../out/host/toolchainOperation.js';
import { UpgradeExecutionSession } from '../out/host/upgradeRunner.js';
import { createNodeNpmResolverAsyncDeps, resolveNpmInvocationAsync, runFixedProbeAsync } from '../out/host/npmResolverAsync.js';
import { resolveInstalledPnpmInvocationAsync, resolvePnpmInvocationAsync } from '../out/host/pnpmResolverAsync.js';
import { defaultMutationTargetEnvironment } from '../out/host/mutationTarget.js';
import { rollbackFixture } from './helpers/optional-reinstall.mjs';
// Warm the lazy recovery import before guarding application I/O, so Node's module
// loader does not perform its own synchronous path lookup inside a guarded flow.
import '../out/host/recovery/targetDiscovery.js';
import '../out/host/recovery/inspection.js';
import '../out/host/recovery/session.js';
import '../out/host/recovery/journal.js';
import '../out/host/frozenReconciliation.js';
import { NodeResolverProcessRunner } from '../out/host/resolverVerifier.js';
import { withoutFsync } from './helpers/without-fsync.mjs';

withoutFsync();
const invocation = { executable: '/node', prefixArgs: ['/npm-cli.js'], version: '10.0.0' };
function patch(t, target, key, replacement) {
  const original = target[key];
  target[key] = replacement;
  syncBuiltinESMExports();
  t.after(() => { target[key] = original; syncBuiltinESMExports(); });
}
function probeChild(stdout = '', exitCode = 0, error) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
  });
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    child.stdout.end(stdout);
    child.stderr.end();
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  });
  return child;
}
const platform = { isWorkspaceTrusted: () => true, showErrorMessage() {},
  runProcess: async () => ({ onDidExit: callback => { queueMicrotask(() => callback(0)); return { dispose() {} }; } }) };

for (const manager of ['npm', 'pnpm']) test(`concurrent ${manager} preparation, restyle and verification share one lookup only within an operation`, async () => {
  let lookups = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const session = new UpgradeExecutionSession(platform, async () => { lookups++; await gate; return invocation; });
  const toolchain = session.createToolchainOperation('/project');
  const params = { cwd: '/project', packageManager: manager, ignoreScripts: true, toolchain };
  const first = session.prepareManifestReconciliation(params);
  const restyle = session.prepareManifestReconciliation({ ...params, lockfileOnly: true });
  const verification = session.verify({ ...params, scripts: [{ id: 'test', scriptName: 'test' }], packageName: 'a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 1, 'all concurrent consumers must share the pending probe');
  release();
  const [prepared, styled, verified] = await Promise.all([first, restyle, verification]);
  assert.equal(prepared.ok && styled.ok, true);
  assert.equal(verified.status, 'passed');
  assert.deepEqual(await prepared.execute(), { ok: true });
  assert.deepEqual(await styled.execute(), { ok: true });
  assert.equal(lookups, 1);
  assert.equal((await session.prepareLockfileReconciliation({ cwd: '/project', packageManager: manager, ignoreScripts: true })).ok, true);
  assert.equal(lookups, 2, 'a reinstall or subsequent apply resolves fresh');
  session.dispose();
});

test('concurrent npm and package-manager consumers share all underlying npm probes', async t => {
  const p = process.platform === 'win32' ? path.win32 : path.posix;
  const bin = process.platform === 'win32' ? 'C:\\trusted' : '/trusted';
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  patch(t, io, 'stat', async () => ({}));
  patch(t, io, 'access', async () => {});
  patch(t, io, 'readdir', async () => []);
  let probes = 0;
  patch(t, cp, 'spawn', (file, args) => {
    probes++;
    const output = args[0] === '-p' ? file : args[0] === 'root' ? p.join(bin, 'node_modules') : '10.0.0';
    return probeChild(output);
  });
  const operation = new ToolchainOperation(process.cwd(), false);
  const first = operation.npm();
  assert.equal(operation.npm(), first);
  const [npm, manager] = await Promise.all([first, operation.resolve('npm')]);
  assert.equal(npm.ok, true);
  assert.equal(manager.version, '10.0.0');
  const perLookup = process.platform === 'win32' ? 2 : 3;
  assert.equal(probes, perLookup);
  await new ToolchainOperation(process.cwd(), true).resolve('npm');
  assert.equal(probes, perLookup * 2, 'apply resolves afresh after the graceful review');
});

for (const kind of ['upgrade', 'removal']) test(`confirmed ${kind} shares discovery across its actual transaction steps`, async t => {
  const f = await rollbackFixture(t, kind);
  f.state.installExitCode = 0;
  f.state.reinstallChoice = 'Skip';
  let lookups = 0;
  f.coordinator.session.invocationResolver = () => { lookups++; return invocation; };
  const stored = kind === 'upgrade' ? f.coordinator.analysis : f.coordinator.removal;
  stored.verificationScripts = [{ id: 'test', scriptName: 'test' }];
  let verifications = 0;
  const verify = f.coordinator.session.verify.bind(f.coordinator.session);
  f.coordinator.session.verify = async params => { verifications++; assert.ok(params.toolchain); return verify(params); };
  await f.confirm();
  assert.equal(verifications, 1, JSON.stringify(f.messages.filter(message => message.error)));
  assert.equal(lookups, 1, 'install, restyle and verification use the same lookup');
  if (kind === 'upgrade') assert.equal(f.commands.filter(command => command === 'install').length, 2);
});

test('review, apply and later analysis use fresh versions; strict and graceful operations do not share', async () => {
  let lookups = 0;
  const resolver = async () => ({ ...invocation, version: `${++lookups}.0.0` });
  const review = new ToolchainOperation('/project', false, undefined, resolver);
  assert.equal((await review.resolve('npm')).version, '1.0.0');
  assert.equal((await review.resolve('npm')).version, '1.0.0');
  const apply = new ToolchainOperation('/project', true, undefined, resolver);
  assert.equal((await apply.resolve('npm')).version, '2.0.0');
  assert.equal((await new ToolchainOperation('/project', false, undefined, resolver).resolve('npm')).version, '3.0.0');
  const session = new UpgradeExecutionSession(platform);
  await assert.rejects(session.prepareManifestReconciliation({ cwd: '/project', packageManager: 'npm', ignoreScripts: true, toolchain: review }), TypeError);
  session.dispose();
});

test('confirmed remediation compares a fresh version before preparing or staging', async t => {
  const f = await rollbackFixture(t, 'transitive');
  f.coordinator.remediationPlans.get('plan').packageManagerVersion = '10.0.0';
  let lookups = 0;
  f.coordinator.session.invocationResolver = () => { lookups++; return { ...invocation, version: '11.0.0' }; };
  f.coordinator.session.prepareLockfileReconciliation = () => assert.fail('changed version cannot prepare a writer');
  const before = await io.readFile(f.project.lockfilePath, 'utf8');
  await f.confirm();
  assert.equal(lookups, 1);
  assert.equal(f.messages.some(message => message.status === 'remediation-stale' && message.message.includes('version changed')), true);
  assert.equal(await io.readFile(f.project.lockfilePath, 'utf8'), before);
  assert.deepEqual(f.requests, []);
});

test('confirmed remediation shares discovery with task preparation', async t => {
  const f = await rollbackFixture(t, 'transitive');
  f.state.installExitCode = 0;
  f.state.reinstallChoice = 'Skip';
  let lookups = 0;
  f.coordinator.session.invocationResolver = () => { lookups++; return invocation; };
  const prepare = f.coordinator.session.prepareLockfileReconciliation.bind(f.coordinator.session);
  let same;
  f.coordinator.session.prepareLockfileReconciliation = async params => {
    same = params.toolchain;
    assert.ok(same);
    return prepare(params);
  };
  await f.confirm();
  assert.equal(lookups, 1);
  assert.ok(same, JSON.stringify(f.messages));
});

for (const code of ['EIO', 'UNKNOWN', 'EMFILE', 'ENETUNREACH', 'TypeError']) {
  for (const step of ['exists', 'isExecutable', 'listDir', 'resolveRealNodePath', 'resolveGlobalNpmRoot', 'probeVersion', 'probeLoginShellNode']) {
    test(`async npm ${step} retains strict and graceful ${code} handling`, async t => {
      const error = code === 'TypeError' ? new TypeError('probe bug') : Object.assign(new Error(code), { code });
      const method = step === 'exists' ? 'stat' : step === 'isExecutable' ? 'access' : step === 'listDir' ? 'readdir' : 'spawn';
      if (step === 'resolveGlobalNpmRoot') patch(t, io, 'stat', async () => ({}));
      patch(t, method === 'spawn' ? cp : io, method, () => { throw error; });
      const invoke = strict => createNodeNpmResolverAsyncDeps(process.cwd(), undefined, strict)[step]('/installation/node', '/installation/npm-cli.js');
      await assert.rejects(invoke(true), cause => cause === error);
      if (code === 'TypeError') await assert.rejects(invoke(false), cause => cause === error);
      else assert.deepEqual(await invoke(false), step === 'exists' || step === 'isExecutable' ? false : step === 'listDir' ? [] : undefined);
    });
  }
  test(`async pnpm canonicalization and manifest retain strict and graceful ${code} handling`, async t => {
    const error = code === 'TypeError' ? new TypeError('pnpm bug') : Object.assign(new Error(code), { code });
    const resolve = strict => resolvePnpmInvocationAsync(null, { cwd: '/project', platform: 'linux', pathEnv: '/installation',
      exists: async () => true, probe: async () => '10.0.0', realpath: async () => { throw error; }, throwOnUnexpectedError: strict });
    await assert.rejects(resolve(true), cause => cause === error);
    if (code === 'TypeError') await assert.rejects(resolve(false), cause => cause === error);
    else assert.equal(await resolve(false), null);
    patch(t, io, 'stat', async () => ({}));
    patch(t, io, 'readFile', async () => { throw error; });
    await assert.rejects(resolveInstalledPnpmInvocationAsync(null, process.cwd(), true), cause => cause === error);
  });
}

for (const [label, exitCode, error, expected] of [
  ['nonzero exit', 1, undefined, undefined],
  ['timeout', null, Object.assign(new Error('timeout'), { name: 'TimeoutError' }), undefined],
  ['I/O', null, Object.assign(new Error('I/O'), { code: 'EIO' }), 'reject'],
]) test(`async probes classify process ${label}`, async t => {
  patch(t, cp, 'spawn', () => probeChild('', exitCode, error));
  const result = runFixedProbeAsync('/node', [], { cwd: '/project' }, true);
  if (expected === 'reject') await assert.rejects(result, cause => cause === error);
  else assert.equal(await result, expected);
});

async function hangingProbe(t) {
  const dir = await io.mkdtemp(path.join(os.tmpdir(), 'packageawy-probe-'));
  const executable = path.join(dir, 'node');
  const marker = path.join(dir, 'pid');
  await io.writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  t.after(async () => { await io.rm(dir, { recursive: true, force: true }); });
  return { dir, executable, marker };
}
async function waitFor(check, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    assert.ok(performance.now() < deadline, 'condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const cancellation of ['user', 'panel']) test(`${cancellation} cancellation kills a hanging PATH node while timers keep firing`, { skip: process.platform === 'win32' }, async t => {
  const probe = await hangingProbe(t);
  const originalPath = process.env.PATH;
  process.env.PATH = `${probe.dir}${path.delimiter}${originalPath ?? ''}`;
  t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
  const abort = new AbortController();
  const session = new UpgradeExecutionSession(platform);
  const toolchain = session.createToolchainOperation(process.cwd(), abort.signal);
  let ticks = 0, maxGap = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 5);
  t.after(() => { clearInterval(timer); session.dispose(); });
  const pending = session.prepareManifestReconciliation({ cwd: process.cwd(), packageManager: 'npm', ignoreScripts: true, toolchain });
  // Observe both outcomes immediately so a blocking regression still reaches the timer assertions.
  const stopped = pending.then(() => undefined, cause => cause);
  await waitFor(() => io.access(probe.marker).then(() => true, () => false));
  await new Promise(resolve => setTimeout(resolve, 120));
  const pid = Number(await io.readFile(probe.marker, 'utf8'));
  const cancelledAt = performance.now();
  if (cancellation === 'user') abort.abort(); else session.dispose();
  const error = await stopped;
  assert.ok(maxGap < 500, `event loop blocked for ${maxGap} ms`);
  assert.equal(error?.name, 'AbortError');
  assert.ok(performance.now() - cancelledAt < 1000, 'cancel must stop the probe before its timeout');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { assert.equal(error.code, 'ESRCH'); return true; } });
  assert.ok(ticks >= 10, `only ${ticks} timer ticks`);
});

for (const kind of ['upgrade', 'removal']) {
  for (const cancel of ['user', 'panel']) test(`${cancel} cancels confirmed ${kind} discovery before any mutation`, { skip: process.platform === 'win32' }, async t => {
    const f = await rollbackFixture(t, kind);
    const probe = await hangingProbe(t);
    const oldPath = process.env.PATH;
    process.env.PATH = `${probe.dir}${path.delimiter}${oldPath ?? ''}`;
    t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
    f.coordinator.session.invocationResolver = undefined;
    const id = kind === 'upgrade' ? f.coordinator.analysis.id : f.coordinator.removal.id;
    const before = await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file, 'utf8')));
    const pending = f.confirm();
    await waitFor(() => io.access(probe.marker).then(() => true, () => false));
    const pid = Number(await io.readFile(probe.marker, 'utf8'));
    const cancelledAt = performance.now();
    if (cancel === 'panel') { f.coordinator.options.isDisposed = () => true; f.coordinator.disposeWhenIdle(); }
    else if (kind === 'upgrade') await f.coordinator.handleCancelUpgrade({ analysisId: id });
    else await f.coordinator.handleCancelRemove({ analysisId: id });
    await pending;
    assert.ok(performance.now() - cancelledAt < 1000, 'cancellation reaches the discovery process');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.deepEqual(await Promise.all([f.project.manifestPath, f.project.lockfilePath].map(file => io.readFile(file, 'utf8'))), before);
    assert.deepEqual(f.requests, []);
    assert.equal(f.coordinator.reservation.held, undefined);
    assert.equal(f.messages.some(message => message.error), false);
    assert.equal(await io.access(path.join(f.project.root, '.packageawy-recovery')).then(() => true, () => false), false);
  });
}

test('pnpm installed discovery cancels its real login-shell probe', { skip: process.platform === 'win32' }, async t => {
  const probe = await hangingProbe(t);
  const originalShell = process.env.SHELL;
  process.env.SHELL = probe.executable;
  t.after(() => { if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell; });
  patch(t, io, 'stat', async file => {
    if (file === path.join(probe.dir, 'pnpm-workspace.yaml')) return {};
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  });
  const abort = new AbortController();
  const pending = resolveInstalledPnpmInvocationAsync(null, probe.dir, true, abort.signal);
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => io.access(probe.marker).then(() => true, () => false));
  const pid = Number(await io.readFile(probe.marker, 'utf8'));
  const cancelledAt = performance.now();
  abort.abort();
  await stopped;
  assert.ok(performance.now() - cancelledAt < 1000, 'login-shell cancellation must stop its probe before the timeout');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('runtime npm and pnpm discovery never use synchronous process or filesystem probes', async t => {
  for (const name of ['execFileSync', 'spawnSync']) patch(t, cp, name, () => { throw new TypeError(`sync process probe ${name}`); });
  for (const name of ['existsSync', 'statSync', 'accessSync', 'readdirSync', 'realpathSync', 'readFileSync']) patch(t, fs, name, () => { throw new TypeError(`sync filesystem probe ${name}`); });
  await defaultMutationTargetEnvironment();
  const npm = await resolveNpmInvocationAsync(createNodeNpmResolverAsyncDeps(process.cwd()));
  assert.equal(typeof npm.ok, 'boolean');
  const pnpm = await resolveInstalledPnpmInvocationAsync(npm.ok ? npm.invocation : null, process.cwd());
  assert.ok(pnpm === null || typeof pnpm.executable === 'string');
});

test('former synchronous runtime callers import only async discovery', async () => {
  for (const file of ['upgradeRunner.ts', 'upgradeAssistantCoordinator.ts', 'npmAuditRunner.ts']) {
    const source = await io.readFile(new URL(`../src/host/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:resolveNpmInvocation|createNodeNpmResolverDeps|resolveInstalledPnpmInvocation|resolvePnpmInvocation)\s*\(/, file);
  }
});

// These exact files contain existing synchronous paths owned outside item 2.1:
// pathIdentity.ts preserves realpathSync.native lock identity; fileKeyValueStore.ts
// owns cache reads/construction; vsCodePlatform.ts owns settings-action reads.
const syncGuardExclusions = new Set([
  'src/host/pathIdentity.ts',
  'src/host/platform/fileKeyValueStore.ts',
  'src/host/platform/vscode/vsCodePlatform.ts',
]);
test('all host and sidecar runtime flow sources reject synchronous filesystem and process calls', async () => {
  const ts = (await import('typescript')).default;
  const forbidden = /^(?:existsSync|statSync|accessSync|readdirSync|readFileSync|realpathSync|execFileSync|spawnSync)$/;
  const violations = [];
  async function inspect(directory) {
    for (const entry of await io.readdir(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await inspect(file);
      else if (file.endsWith('.ts') && !syncGuardExclusions.has(file)) {
        const source = ts.createSourceFile(file, await io.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node) {
          if (ts.isIdentifier(node) && forbidden.test(node.text)) violations.push(`${file}: ${node.text}`);
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  await inspect('src/host');
  await inspect('src/sidecar');
  assert.deepEqual(violations, [], 'review, apply, reinstall and remediation share the guarded runtime tree');
});

function installRuntimeSyncGuard(t) {
  const exempt = /[\\/]out[\\/]host[\\/](?:pathIdentity|platform[\\/]fileKeyValueStore|platform[\\/]vscode[\\/]vsCodePlatform)\.js:/;
  for (const [target, names] of [[cp, ['execFileSync', 'spawnSync']],
    [fs, ['existsSync', 'statSync', 'accessSync', 'readdirSync', 'readFileSync', 'realpathSync']]]) {
    for (const name of names) {
      const original = target[name];
      const guard = (...args) => {
        const caller = new Error().stack.split('\n')[2] ?? '';
        if (exempt.test(caller)) return original(...args);
        throw new TypeError(`sync runtime call ${name}: ${caller}`);
      };
      if (name === 'realpathSync') guard.native = (...args) => {
        const caller = new Error().stack.split('\n')[2] ?? '';
        if (exempt.test(caller)) return original.native(...args);
        throw new TypeError(`sync runtime call realpathSync.native: ${caller}`);
      };
      patch(t, target, name, guard);
    }
  }
}

for (const kind of ['upgrade', 'cleanup', 'transitive']) test(`complete ${kind} apply and rollback reinstall flow avoids sync probes`, async t => {
  installRuntimeSyncGuard(t);
  const f = await rollbackFixture(t, kind);
  f.coordinator.session.invocationResolver = undefined;
  // Exercise a full read-only removal review while guards are installed too.
  if (kind === 'cleanup') {
    await f.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'guard', removalRequestId: 'guard-impact', packages: ['react'] });
    const id = f.messages.findLast(message => message.status === 'remove-analysis')?.analysis.analysisId;
    assert.ok(id);
    await f.coordinator.handleConfirmRemove({ analysisId: id });
  } else await f.confirm();
  assert.ok(f.commands.includes(kind === 'transitive' ? 'ci' : 'install'), JSON.stringify(f.messages));
  assert.ok(f.commands.includes('ci'), JSON.stringify(f.messages));
  assert.equal(f.messages.some(message => message.error), false);
});

test('upgrade and remediation reviews finish with synchronous runtime probes forbidden', async t => {
  installRuntimeSyncGuard(t);
  const f = await rollbackFixture(t, 'upgrade');
  const source = await f.read();
  const controller = await f.coordinator.options.ensureController();
  source.peerPolicy = { strictPeerDeps: true, legacyPeerDeps: false };
  source.resolvedRegistry = { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} };
  controller.upgradeSource = source;
  f.coordinator.projectLoader = async () => source;
  controller.lastResultRows = () => [];
  controller.validateBulkUpgradeRequest = () => ({ ok: true, upgrades: [{
    packageName: 'react', currentVersion: '18.2.0', target: '18.3.0', classification: 'prod',
  }] });
  f.coordinator.options.ensureController = async () => controller;
  f.coordinator.options.withCompatibilityProgress = async (_, run) => run(new AbortController().signal);
  f.coordinator.options.platform.findFiles = async () => [];
  f.coordinator.options.platform.withProgress = async (_, run) => run({}, {
    onCancellationRequested: () => ({ dispose() {} }),
  });
  f.coordinator.options.httpClient = {
    get: async url => {
      const segments = new URL(url).pathname.split('/');
      const exact = /^\d+\.\d+\.\d+$/.test(segments.at(-1));
      const name = segments.at(exact ? -2 : -1);
      const versions = name === 'react' ? ['18.2.0', '18.3.0'] : ['1.3.0'];
      const metadata = version => ({ name, version, dependencies: {} });
      return { status: 200, headers: {}, body: JSON.stringify(exact ? metadata(segments.at(-1)) : {
        name, 'dist-tags': { latest: versions.at(-1) },
        versions: Object.fromEntries(versions.map(version => [version, metadata(version)])),
      }) };
    },
    post: async () => ({ status: 200, body: '{}' }),
  };
  f.coordinator.options.etagStore = { get: () => undefined, set() {} };
  let resolutions = 0;
  patch(t, NodeResolverProcessRunner.prototype, 'run', async (_invocation, args, cwd) => {
    resolutions++;
    const staged = JSON.parse(await io.readFile(path.join(cwd, 'package.json'), 'utf8'));
    const lock = JSON.parse(source.lockfileText);
    lock.packages[''].dependencies = staged.dependencies;
    for (const [name, range] of Object.entries(staged.dependencies)) lock.packages[`node_modules/${name}`].version = range.replace(/^[^\d]*/, '');
    if (args.includes('--package-lock-only')) await io.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await f.coordinator.handleAnalyzeUpgrade({ requestId: 'guard-review', package: 'react', target: '18.3.0' });
  assert.ok(f.messages.some(message => message.status === 'upgrade-analysis'), JSON.stringify(f.messages));
  assert.ok(resolutions > 0, 'review must reach isolated package-manager resolution');
  controller.lastResultRows = () => [{ name: 'react', current: '18.2.0', upgradeTo: null, advisories: [{
    advisory: { id: 1, severity: 'high', title: 'fixture', url: 'https://example.invalid', vulnerableVersions: '<2.0.0' },
    flaggedPackage: 'left-pad', path: ['react', 'left-pad'], patchedVersion: { status: 'known', version: '2.0.0' },
  }] }];
  const before = resolutions;
  await f.coordinator.handleAnalyzeRemediation({ package: 'react' });
  assert.ok(resolutions > before, 'remediation review must reach isolated materialization');
  assert.ok(f.messages.some(message => message.status === 'remediation-plan'), JSON.stringify(f.messages));
  assert.equal(f.messages.some(message => message.error), false);
});
