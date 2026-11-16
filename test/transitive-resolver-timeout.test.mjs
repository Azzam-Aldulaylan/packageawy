import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { NodeResolverProcessRunner } from '../out/host/resolverVerifier.js';
import { makeProject, makeCoordinator } from './helpers/removal-project.mjs';
import { ProjectMutationLocks } from '../out/host/projectMutationLock.js';

const descendant = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("descendant",String(process.pid));setInterval(()=>{},1000)';
const leader = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore",1,2]});` +
  'require("node:fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)';

// The production coordinator must choose 120 seconds. The test accelerates
// only that configured runner, and still starts and stops a real process tree.
test('transitive resolver timeout stops its tree, reports the limit and never starts a project change', async t => {
  const project = await makeProject(t);
  const locks = new ProjectMutationLocks();
  const original = { manifest: await readFile(project.manifestPath), lockfile: await readFile(project.lockfilePath) };
  let isolatedRoot; let leaderPid; let descendantPid; let timeoutMs;
  const run = NodeResolverProcessRunner.prototype.run;
  t.mock.method(NodeResolverProcessRunner.prototype, 'run', async function (_invocation, _args, cwd, signal) {
    isolatedRoot = cwd; timeoutMs = this.runner.options.timeoutMs;
    const runner = new NodeResolverProcessRunner({ timeoutMs: 2_000, terminationGraceMs: 30 });
    const pending = run.call(runner, { executable: process.execPath, prefixArgs: [] }, ['-e', leader], cwd, signal);
    pending.catch(() => {});
    // Read the identities before the resolver removes its isolated directory.
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      try {
        leaderPid = Number(await readFile(path.join(cwd, 'pid'), 'utf8'));
        descendantPid = Number(await readFile(path.join(cwd, 'descendant'), 'utf8'));
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(descendantPid, 'the descendant must start before the timeout');
    return pending;
  });
  const advisory = { advisory: { id: 1, severity: 'high', title: 'fixture', url: 'https://example.invalid', vulnerableVersions: '<2' },
    flaggedPackage: 'left-pad', path: ['react', 'left-pad'], patchedVersion: { status: 'known', version: '2.0.0' } };
  const row = { name: 'react', current: '18.2.0', range: '^18.0.0', dev: false, advisories: [advisory], worstSeverity: 'high', upgradeTo: null };
  let source;
  const f = makeCoordinator(project, { mutationLocks: locks,
    platform: { getSetting: (_key, fallback) => fallback, isWorkspaceTrusted: () => true,
      withProgress: async (_title, work) => work({}, { onCancellationRequested: () => ({ dispose() {} }) }),
    },
    loadProject: async () => source,
    ensureController: async () => ({ root: project.root, upgradeSource: source, lastResultRows: () => [row] }),
  });
  source = { ...await f.read(), peerPolicy: { strictPeerDeps: false, legacyPeerDeps: false } };
  await f.coordinator.handleAnalyzeRemediation({ package: 'react' });
  assert.equal(timeoutMs, 120_000, 'the transitive resolver, not only upgrade review, must have the production limit');
  const error = f.messages.find(m => m.status === 'remediation-error');
  assert.equal(error.error.code, 'RESOLVER_TIMEOUT');
  assert.match(error.error.message, /120 second limit.*Project files were not changed/);
  assert.equal(f.messages.some(m => m.status === 'remediation-apply-result' || m.status === 'remove-result' || m.status === 'upgrade-result'), false);
  assert.deepEqual(f.commands, []);
  assert.equal(locks.restartState(), 'idle');
  assert.throws(() => process.kill(leaderPid, 0), { code: 'ESRCH' });
  // The descendant ignores SIGTERM and holds inherited output pipes open.
  // The runner bounds settlement even if inherited output handles stay open.
  assert.ok(descendantPid);
  await assert.rejects(access(isolatedRoot), { code: 'ENOENT' });
  assert.deepEqual(await readFile(project.manifestPath), original.manifest);
  assert.deepEqual(await readFile(project.lockfilePath), original.lockfile);
  assert.deepEqual((await readdir(project.root)).sort(), ['package-lock.json', 'package.json']);
});
