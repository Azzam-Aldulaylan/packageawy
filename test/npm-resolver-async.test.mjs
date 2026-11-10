/**
 * The async npm resolver used by the dashboard's audit: same candidate order
 * and validation as the sync resolver, never runs npm.cmd on Windows, and
 * stops when its signal aborts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveNpmInvocation } from '../out/host/npmResolver.js';
import { resolveNpmInvocationAsync, createNodeNpmResolverAsyncDeps } from '../out/host/npmResolverAsync.js';

function scenario(platform) {
  const win = platform === 'win32';
  const brokenNode = win ? 'C:\\broken\\node.exe' : '/broken/node';
  const goodNode = win ? 'C:\\good\\node.exe' : '/good/node';
  const goodCli = win ? 'C:\\good\\node_modules\\npm\\bin\\npm-cli.js' : '/good-root/npm/bin/npm-cli.js';
  const files = new Set([brokenNode, goodNode, goodCli]);
  const base = {
    platform,
    pathEnv: win ? 'C:\\broken;C:\\good' : '/broken:/good',
    homeDir: win ? 'C:\\Users\\dev' : '/Users/dev',
    fnmDirEnv: undefined,
    cwd: '/project',
    listDir: () => [],
    exists: (p) => files.has(p),
    isExecutable: (p) => files.has(p),
  };
  const calls = [];
  const real = (node) => (node === goodNode ? goodNode : undefined);
  const root = (node) => {
    if (win) throw new Error('npm root -g must never run on Windows');
    return node === goodNode ? '/good-root' : undefined;
  };
  const version = (node, cli) => (node === goodNode && cli === goodCli ? '10.9.0' : undefined);
  return {
    calls,
    sync: { ...base, resolveRealNodePath: real, resolveGlobalNpmRoot: root, probeVersion: version, probeLoginShellNode: () => undefined },
    async: {
      ...base,
      resolveRealNodePath: async (n) => (calls.push(['real', n]), real(n)),
      resolveGlobalNpmRoot: async (n) => (calls.push(['root', n]), root(n)),
      probeVersion: async (n, c) => (calls.push(['version', n]), version(n, c)),
      probeLoginShellNode: async () => undefined,
    },
  };
}

for (const platform of ['darwin', 'win32']) {
  test(`async resolution matches the sync resolver on ${platform}`, async () => {
    const { sync, async: deps, calls } = scenario(platform);
    const expected = resolveNpmInvocation(sync);
    assert.equal(expected.ok, true);
    assert.deepEqual(await resolveNpmInvocationAsync(deps), expected);
    assert.equal(calls[0][1], sync.platform === 'win32' ? 'C:\\broken\\node.exe' : '/broken/node');
  });
}

test('an aborted signal stops resolution before any probe', async () => {
  const { async: deps, calls } = scenario('darwin');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveNpmInvocationAsync({ ...deps, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, []);
});

test('aborting mid-resolution rejects instead of trying further candidates', async () => {
  const { async: deps, calls } = scenario('darwin');
  const controller = new AbortController();
  const pending = resolveNpmInvocationAsync({
    ...deps,
    signal: controller.signal,
    resolveRealNodePath: async (n) => {
      calls.push(['real', n]);
      controller.abort();
      return undefined;
    },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('the real async adapter resolves this machine without blocking the event loop', async () => {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 1);
  try {
    const result = await resolveNpmInvocationAsync(createNodeNpmResolverAsyncDeps(process.cwd()));
    assert.equal(typeof result.ok, 'boolean');
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'timers ran while the probes were in flight');
});
