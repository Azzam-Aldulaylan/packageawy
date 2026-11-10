/**
 * The dashboard's audit runner launches npm as `<node> <npm-cli.js>` with no
 * shell, using the same resolver as upgrades, and never falls back to
 * `npm.cmd` with a shell on Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ResolvedNpmAuditRunner, auditSpawnConfigFor } from '../out/host/npmAuditRunner.js';
import { AuditUnavailableError, NodeAuditRunner } from '../out/core/audit/npmAudit.js';

const FAKE_NPM = fileURLToPath(new URL('./fixtures/fake-npm/npm.cjs', import.meta.url));
const RESOLVED = {
  ok: true,
  invocation: { node: 'C:\\Program Files\\nodejs\\node.exe', npmCliJs: 'C:\\npm\\bin\\npm-cli.js', version: '10.9.0' },
};

function harness({ platform = 'win32', resolutions = [RESOLVED], runResults = [] } = {}) {
  const calls = { resolve: [], create: [], run: [] };
  let resolveIndex = 0;
  let runIndex = 0;
  const runner = new ResolvedNpmAuditRunner({
    platform,
    resolve: (cwd) => {
      calls.resolve.push(cwd);
      return resolutions[Math.min(resolveIndex++, resolutions.length - 1)];
    },
    createRunner: (spawnConfig) => {
      calls.create.push(spawnConfig);
      return {
        run: async (cwd) => {
          calls.run.push(cwd);
          const result = runResults[runIndex++];
          if (result instanceof Error) throw result;
          return result ?? { stdout: '{}', exitCode: 0 };
        },
      };
    },
  });
  return { runner, calls };
}

test('a resolved pair becomes a shell-free node + npm-cli.js spawn config', () => {
  assert.deepEqual(auditSpawnConfigFor(RESOLVED), {
    command: RESOLVED.invocation.node,
    prefixArgs: [RESOLVED.invocation.npmCliJs],
    shell: false,
  });
  assert.equal(auditSpawnConfigFor({ ok: false }), undefined);
});

test('the host runs audit through the resolved node and npm-cli.js, without a shell', async () => {
  const { runner, calls } = harness();
  await runner.run('/project');
  assert.deepEqual(calls.create, [
    { command: RESOLVED.invocation.node, prefixArgs: [RESOLVED.invocation.npmCliJs], shell: false },
  ]);
  assert.deepEqual(calls.run, ['/project']);
});

test('resolution is cached per project root across scans', async () => {
  const { runner, calls } = harness();
  await runner.run('/a');
  await runner.run('/a');
  await runner.run('/b');
  assert.deepEqual(calls.resolve, ['/a', '/b']);
  assert.equal(calls.create.length, 2);
});

test('on Windows, an unresolved npm makes audit unavailable instead of spawning npm.cmd with a shell', async () => {
  const { runner, calls } = harness({ platform: 'win32', resolutions: [{ ok: false }, RESOLVED] });
  await assert.rejects(runner.run('/project'), AuditUnavailableError);
  assert.deepEqual(calls.create, []);
  // Not cached: a later scan picks up a newly installed Node.
  await runner.run('/project');
  assert.equal(calls.resolve.length, 2);
  assert.equal(calls.create[0].shell, false);
});

test('on POSIX, an unresolved npm falls back to npm from PATH (no shell)', async () => {
  const { runner, calls } = harness({ platform: 'darwin', resolutions: [{ ok: false }] });
  await runner.run('/project');
  assert.deepEqual(calls.create, [undefined]);
});

test('a failed run drops the cached pair; a timeout or cancel keeps it', async () => {
  const timeout = Object.assign(new Error('npm audit timed out.'), { name: 'TimeoutError' });
  const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const { runner, calls } = harness({ runResults: [timeout, missing, undefined] });
  await assert.rejects(runner.run('/p'), /timed out/);
  await assert.rejects(runner.run('/p'), /ENOENT/);
  await runner.run('/p');
  assert.deepEqual(calls.resolve, ['/p', '/p']);
});

test('a real NodeAuditRunner with the host-style config runs node + script without a shell', async () => {
  const runner = new ResolvedNpmAuditRunner({
    platform: process.platform,
    resolve: () => ({ ok: true, invocation: { node: process.execPath, npmCliJs: FAKE_NPM, version: '10.0.0' } }),
    createRunner: (spawnConfig) => new NodeAuditRunner({ spawnConfig, terminationGraceMs: 200 }),
  });
  // The fake npm sees `audit` as its first argument and exits 3: the audit
  // arguments reached npm-cli.js directly as argv.
  const { stdout, exitCode } = await runner.run(process.cwd());
  assert.equal(stdout, '');
  assert.equal(exitCode, 3);
});
