import assert from 'node:assert/strict';
import path from 'node:path/posix';
import test from 'node:test';

import { pnpmInvocationCandidates } from '../out/host/pnpmResolver.js';

import { resolvePnpmInvocationAsync } from '../out/host/pnpmResolverAsync.js';

const npm = { node: '/trusted/node', npmCliJs: '/trusted/lib/node_modules/npm/bin/npm-cli.js' };
const globalRoot = path.dirname(path.dirname(path.dirname(npm.npmCliJs)));

test('async pnpm candidates are installation-owned JS entry points, never pnpm or pnpm.cmd shims', async () => {
  assert.deepEqual(pnpmInvocationCandidates(npm, 'darwin'), [
    { executable: '/trusted/node', prefixArgs: [path.join(globalRoot, 'pnpm', 'bin', 'pnpm.cjs')] },
    { executable: '/trusted/node', prefixArgs: [path.join(globalRoot, 'corepack', 'dist', 'corepack.js'), 'pnpm'] },
    { executable: '/trusted/node', prefixArgs: [path.join(globalRoot, 'corepack', 'dist', 'corepack.cjs'), 'pnpm'] },
  ]);
});

test('async resolver validates candidates and can fall through to Corepack', async () => {
  const probed = [];
  const result = await resolvePnpmInvocationAsync(npm, {
    platform: 'darwin', cwd: '/project',
    exists: (candidate) => candidate.includes('pnpm.cjs') || candidate.endsWith('corepack.js'),
    probe: (_node, prefix) => {
      probed.push(prefix);
      return prefix[0].endsWith('corepack.js') ? '10.15.1' : undefined;
    },
  });
  assert.equal(result.prefixArgs.at(-1), 'pnpm');
  assert.equal(result.version, '10.15.1');
  assert.equal(probed.length, 2);
});

test('async missing or broken pnpm never falls back to a shell command', async () => {
  assert.equal(await resolvePnpmInvocationAsync(npm, {
    platform: 'darwin', cwd: '/project', exists: () => true, probe: () => undefined,
  }), null);
});

function fixture(binaries, overrides = {}) {
  const probed = [];
  return {
    platform: 'darwin', cwd: '/project', projectRoot: '/project',
    pathEnv: '', homeDir: '/home/dev',
    exists: (file) => Object.hasOwn(binaries, file),
    realpath: (file) => file,
    probe: (executable, prefix) => {
      const file = prefix[0] ?? executable;
      probed.push(file);
      return binaries[file];
    },
    probeLoginShellPath: () => undefined,
    probed,
    ...overrides,
  };
}

for (const [name, binary, overrides] of [
  ['PATH', '/custom/bin/pnpm', { pathEnv: '/custom/bin' }],
  ['PNPM_HOME', '/custom/pnpm/pnpm', { pnpmHome: '/custom/pnpm' }],
  ['Homebrew', '/opt/homebrew/bin/pnpm', {}],
  ['Volta', '/home/dev/.volta/bin/pnpm', {}],
  ['mise', '/home/dev/.local/share/mise/shims/pnpm', { platform: 'linux' }],
  ['asdf', '/home/dev/.asdf/shims/pnpm', { platform: 'linux' }],
  ['login-shell PATH', '/shell/bin/pnpm', { probeLoginShellPath: () => '/shell/bin' }],
  ['Windows standalone', 'C:\\custom\\pnpm.exe', { platform: 'win32', pathEnv: 'C:\\custom' }],
  ['Windows PNPM_HOME', 'C:\\custom\\pnpm.exe', { platform: 'win32', pnpmHome: 'C:\\custom' }],
  ['Windows fixed home', 'C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.exe', { platform: 'win32', homeDir: 'C:\\Users\\dev' }],
  ['Windows npm global shim', 'C:\\custom\\node_modules\\pnpm\\bin\\pnpm.cjs', {
    platform: 'win32', pathEnv: 'C:\\custom',
  }],
  ['Scoop', 'C:\\Users\\dev\\scoop\\shims\\pnpm.exe', { platform: 'win32', homeDir: 'C:\\Users\\dev' }],
  ['winget', 'C:\\Local\\Microsoft\\WinGet\\Links\\pnpm.exe', { platform: 'win32', localAppData: 'C:\\Local' }],
]) {
  test(`async finds pnpm through ${name} without executing a Windows batch file`, async () => {
    const deps = fixture({ [binary]: '10.15.1' }, overrides);
    const installedNpm = overrides.platform === 'win32'
      ? { node: 'C:\\Node\\node.exe', npmCliJs: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js' }
      : npm;
    const result = await resolvePnpmInvocationAsync(installedNpm, deps);
    assert.equal(result?.version, '10.15.1');
    assert.ok(deps.probed.includes(binary));
    assert.equal(result.executable.endsWith('.cmd'), false);
  });
}

test('async prefers the packageManager version including an integrity suffix over the global installation', async () => {
  const global = pnpmInvocationCandidates(npm, 'darwin')[0].prefixArgs[0];
  const deps = fixture({ [global]: '10.0.0', '/custom/pnpm': '10.15.1' }, {
    pathEnv: '/custom', packageManager: 'pnpm@10.15.1+sha512.abc',
  });
  assert.equal((await resolvePnpmInvocationAsync(npm, deps))?.executable, '/custom/pnpm');
});

test('async keeps the existing global preference when no binary matches packageManager', async () => {
  const global = pnpmInvocationCandidates(npm, 'darwin')[0].prefixArgs[0];
  const deps = fixture({ [global]: '10.0.0', '/custom/pnpm': '10.15.1' }, {
    pathEnv: '/custom', packageManager: 'pnpm@9.0.0',
  });
  assert.equal((await resolvePnpmInvocationAsync(npm, deps))?.prefixArgs[0], global);
});

test('async rejects project directories, relative PATH entries, and symlinks into the project before probing', async () => {
  const deps = fixture({
    '/project/pnpm': '10.0.0', '/project/node_modules/.bin/pnpm': '10.0.0',
    '/project/packages/app/bin/pnpm': '10.0.0', '/external/pnpm': '10.0.0',
  }, {
    cwd: '/project/packages/app',
    pathEnv: '/project:/project/node_modules/.bin:/project/packages/app/bin:.:node_modules/.bin:/external',
    pnpmHome: '/project',
    probeLoginShellPath: () => '/project/node_modules/.bin',
    realpath: (file) => file === '/external/pnpm' ? '/project/pnpm' : file,
  });
  assert.equal(await resolvePnpmInvocationAsync(npm, deps), null);
  assert.deepEqual(deps.probed, []);
});

test('async skips broken PATH installations and resolves standalone pnpm without npm', async () => {
  const deps = fixture({ '/broken/pnpm': undefined, '/working/pnpm': '10.15.1' }, {
    pathEnv: '/broken:/working',
  });
  assert.equal((await resolvePnpmInvocationAsync(null, deps))?.executable, '/working/pnpm');
});

test('async Windows skips a bare pnpm.cmd and never probes it through a shell', async () => {
  const deps = fixture({ 'C:\\custom\\pnpm.cmd': '10.15.1' }, {
    platform: 'win32', pathEnv: 'C:\\custom',
    probeLoginShellPath: () => { throw new Error('Windows does not use a login shell'); },
  });
  assert.equal(await resolvePnpmInvocationAsync(null, deps), null);
  assert.deepEqual(deps.probed, []);
});

test('async failure guidance lists searched sources and the installation action', async () => {
  const { PNPM_NOT_FOUND_MESSAGE } = await import('../out/host/pnpmResolver.js');
  assert.match(PNPM_NOT_FOUND_MESSAGE, /PATH/);
  assert.match(PNPM_NOT_FOUND_MESSAGE, /PNPM_HOME/);
  assert.match(PNPM_NOT_FOUND_MESSAGE, /Corepack/);
  assert.match(PNPM_NOT_FOUND_MESSAGE, /installation folders/);
  assert.match(PNPM_NOT_FOUND_MESSAGE, /login-shell/);
  assert.match(PNPM_NOT_FOUND_MESSAGE, /Install pnpm or set PNPM_HOME/);
});
