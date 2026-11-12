/** pnpm settings, pnpmfiles and configuration plugins that can move the lockfile pnpm writes, from every source read. */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { assertRefused, environment, files, manifest, resolve, tempDir } from './helpers/mutation-target-fixtures.mjs';

const {
  LOCKFILE_UNDETERMINED_REASON,
  PNPMFILE_REASON,
  PNPM_CONFIG_DEPENDENCIES_REASON,
} = await import('../out/host/pnpmLockfileSettings.js');

const LOCKFILE_SETTINGS = [
  ['shared-workspace-lockfile', 'sharedWorkspaceLockfile', 'false'],
  ['lockfile-dir', 'lockfileDir', '../elsewhere'],
  ['git-branch-lockfile', 'gitBranchLockfile', 'true'],
  ['lockfile', 'lockfile', 'false'],
  ['use-lockfile', 'useLockfile', 'false'],
  ['virtual-store-dir', 'virtualStoreDir', '../store'],
  ['modules-dir', 'modulesDir', 'deps'],
];

/** Writes a setting into one source and returns the environment to resolve with. */
const SOURCES = {
  'pnpm-workspace.yaml': async (t, root, [, camel, value]) => {
    await files(root, { 'pnpm-workspace.yaml': `packages:\n  - packages/*\n${camel}: ${value}\n` });
    return environment(t);
  },
  'project .npmrc': async (t, root, [kebab, , value]) => {
    await files(root, { 'packages/app/.npmrc': `${kebab}=${value}\n` });
    return environment(t);
  },
  'workspace .npmrc': async (t, root, [kebab, , value]) => {
    await files(root, { '.npmrc': `${kebab}=${value}\n` });
    return environment(t);
  },
  'user .npmrc': async (t, _root, [kebab, , value]) => {
    const env = await environment(t);
    await writeFile(path.join(env.homeDir, '.npmrc'), `${kebab}=${value}\n`);
    return env;
  },
  'global npmrc': async (t, _root, [kebab, , value]) => {
    const env = await environment(t);
    await writeFile(path.join(env.nodePrefixes[0], 'etc', 'npmrc'), `${kebab}=${value}\n`);
    return env;
  },
  "pnpm's global rc": async (t, _root, [kebab, , value]) => {
    const env = await environment(t);
    await files(env.homeDir, { '.config/pnpm/rc': `${kebab}=${value}\n` });
    return env;
  },
  "pnpm's global config.yaml (XDG_CONFIG_HOME)": async (t, _root, [, camel, value]) => {
    const env = await environment(t);
    await files(env.host, { 'xdg/pnpm/config.yaml': `${camel}: ${value}\n` });
    return { ...env, env: { XDG_CONFIG_HOME: path.join(env.host, 'xdg') } };
  },
  "pnpm's global config.yaml (macOS)": async (t, _root, [, camel, value]) => {
    const env = await environment(t, { platform: 'darwin' });
    await files(env.homeDir, { 'Library/Preferences/pnpm/config.yaml': `${camel}: ${value}\n` });
    return env;
  },
  'npm_config_ environment': async (t, _root, [kebab, , value]) => ({
    ...(await environment(t)),
    env: { [`npm_config_${kebab.replace(/-/g, '_')}`]: value },
  }),
  'PNPM_CONFIG_ environment': async (t, _root, [kebab, , value]) => ({
    ...(await environment(t)),
    env: { [`PNPM_CONFIG_${kebab.replace(/-/g, '_').toUpperCase()}`]: value },
  }),
};

async function pnpmWorkspace(t) {
  const root = await tempDir(t);
  await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'packages/app/package.json': manifest() });
  return root;
}

for (const setting of LOCKFILE_SETTINGS) {
  test(`pnpm setting ${setting[0]} refuses changes from every source`, async (t) => {
    for (const [source, write] of Object.entries(SOURCES)) {
      const root = await pnpmWorkspace(t);
      const env = await write(t, root, setting);
      const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm', env });
      assert.equal(result.ok, false, `${setting[0]} in ${source} must refuse`);
      assert.equal(result.refusal.code, 'LOCKFILE_UNDETERMINED', source);
      assert.ok(result.refusal.reason.startsWith(LOCKFILE_UNDETERMINED_REASON), source);
      assert.match(result.refusal.reason, new RegExp(`Setting found: ${setting[0]} in `), source);
    }
  });
}

test('pnpm settings at their default values do not refuse', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\nsharedWorkspaceLockfile: true\nuseLockfile: true\nvirtualStoreDir: node_modules/.pnpm\n',
    '.npmrc': 'git-branch-lockfile=false\nmodules-dir=node_modules\nlockfile=true\nregistry=https://registry.npmjs.org/\n',
    'packages/app/package.json': manifest(),
  });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
  assert.equal(result.ok, true);
});

test('a pnpm setting pnpm would expand from the environment counts as set', async (t) => {
  const root = await pnpmWorkspace(t);
  await files(root, { '.npmrc': 'lockfile-dir=${HOME}/locks\n' });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
  assertRefused(result, 'LOCKFILE_UNDETERMINED', /Setting found: lockfile-dir in the workspace \.npmrc\./);
});

test('settings that redirect pnpm configuration or discovery are refused, not followed', async (t) => {
  const cases = [
    ['userconfig in .npmrc', async (env, root) => { await files(root, { '.npmrc': 'userconfig=/elsewhere/.npmrc\n' }); return env; }],
    ['globalconfig in .npmrc', async (env, root) => { await files(root, { '.npmrc': 'globalconfig=/elsewhere/npmrc\n' }); return env; }],
    ['prefix in .npmrc', async (env) => { await writeFile(path.join(env.homeDir, '.npmrc'), 'prefix=/elsewhere\n'); return env; }],
    ['NPM_CONFIG_PREFIX', async (env) => ({ ...env, env: { NPM_CONFIG_PREFIX: '/elsewhere' } })],
    ['npm_config_prefix', async (env) => ({ ...env, env: { npm_config_prefix: '/elsewhere' } })],
    ['NPM_CONFIG_WORKSPACE_DIR', async (env) => ({ ...env, env: { NPM_CONFIG_WORKSPACE_DIR: '/elsewhere' } })],
    ['npm_config_workspace_dir', async (env) => ({ ...env, env: { npm_config_workspace_dir: '/elsewhere' } })],
    ['NPM_CONFIG_USERCONFIG', async (env) => ({ ...env, env: { NPM_CONFIG_USERCONFIG: '/elsewhere/.npmrc' } })],
    ['npm_config_globalconfig', async (env) => ({ ...env, env: { npm_config_globalconfig: '/elsewhere/npmrc' } })],
    ['include in pnpm-workspace.yaml', async (env, root) => {
      await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\ninclude:\n  - ./more.yaml\n' });
      return env;
    }],
  ];
  for (const [name, apply] of cases) {
    const root = await pnpmWorkspace(t);
    const env = await apply(await environment(t), root);
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm', env });
    assert.equal(result.ok, false, name);
    assert.equal(result.refusal.code, 'LOCKFILE_UNDETERMINED', name);
    assert.ok(result.refusal.reason.startsWith(LOCKFILE_UNDETERMINED_REASON), name);
  }
});

test('npm projects ignore pnpm settings', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': manifest(), '.npmrc': 'lockfile-dir=../x\n', '.pnpmfile.cjs': '' });
  assert.equal((await resolve(t, { folder: root, project: root })).ok, true);
});

test('any pnpmfile pnpm could load refuses changes', async (t) => {
  const cases = [
    ['.pnpmfile.cjs at the workspace root', async (env, root) => { await files(root, { '.pnpmfile.cjs': '' }); return env; }],
    ['.pnpmfile.mjs in the project', async (env, root) => { await files(root, { 'packages/app/.pnpmfile.mjs': '' }); return env; }],
    ['pnpmfile setting', async (env, root) => { await files(root, { '.npmrc': 'pnpmfile=hooks.cjs\n' }); return env; }],
    ['global-pnpmfile setting', async (env) => { await writeFile(path.join(env.homeDir, '.npmrc'), 'global-pnpmfile=/hooks.cjs\n'); return env; }],
    ['globalPnpmfile in pnpm-workspace.yaml', async (env, root) => {
      await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\nglobalPnpmfile: /hooks.cjs\n' });
      return env;
    }],
  ];
  for (const [name, apply] of cases) {
    const root = await pnpmWorkspace(t);
    const env = await apply(await environment(t), root);
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm', env });
    assert.equal(result.ok, false, name);
    assert.equal(result.refusal.code, 'PNPMFILE', name);
    assert.equal(result.refusal.reason, PNPMFILE_REASON, name);
  }
});

test('pnpm configuration dependencies refuse changes', async (t) => {
  const inWorkspace = await pnpmWorkspace(t);
  await files(inWorkspace, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\nconfigDependencies:\n  plugin: 1.0.0+sha512-x\n' });
  const inManifest = await pnpmWorkspace(t);
  await files(inManifest, { 'package.json': manifest({ pnpm: { configDependencies: { plugin: '1.0.0' } } }) });
  for (const root of [inWorkspace, inManifest]) {
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
    assertRefused(result, 'PNPM_CONFIG_DEPENDENCIES', PNPM_CONFIG_DEPENDENCIES_REASON);
  }
});

test('.npmrc is read as ini: a bare key is true and key[] is an entry of key', async (t) => {
  const cases = [
    ['git-branch-lockfile\n', 'LOCKFILE_UNDETERMINED', /Setting found: git-branch-lockfile in the workspace \.npmrc\./],
    ['shared-workspace-lockfile = false ; turned off\n', 'LOCKFILE_UNDETERMINED', /Setting found: shared-workspace-lockfile/],
    ['pnpmfile[]=./hooks.cjs\n', 'PNPMFILE', PNPMFILE_REASON],
    ['[section]\nlockfile-dir=../x\n', 'LOCKFILE_UNDETERMINED', /Setting found: lockfile-dir/],
  ];
  for (const [text, code, reason] of cases) {
    const root = await pnpmWorkspace(t);
    await files(root, { '.npmrc': text });
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
    assertRefused(result, code, reason);
  }
});

test('path settings keep their case and booleans do not', async (t) => {
  for (const setting of ['modulesDir: NODE_MODULES', 'virtualStoreDir: NODE_MODULES/.PNPM']) {
    const root = await pnpmWorkspace(t);
    await files(root, { 'pnpm-workspace.yaml': `packages:\n  - packages/*\n${setting}\n` });
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
    assert.equal(result.ok, false, setting);
  }
  const root = await pnpmWorkspace(t);
  await files(root, { '.npmrc': 'use-lockfile=TRUE\nshared-workspace-lockfile=True\nmodules-dir=node_modules\n' });
  assert.equal((await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' })).ok, true);
});

test('only include delegates pnpm-workspace.yaml settings', async (t) => {
  for (const [key, refuses] of [['include', true], ['includes', false], ['configIncludes', false]]) {
    const root = await pnpmWorkspace(t);
    await files(root, { 'pnpm-workspace.yaml': `packages:\n  - packages/*\n${key}:\n  - ./more.yaml\n` });
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
    assert.equal(result.ok, !refuses, key);
  }
});

test('npm config locations in the environment are allowed only when they name what is already read', async (t) => {
  const base = await environment(t);
  const prefix = base.nodePrefixes[0];
  const cases = [
    [{ npm_config_userconfig: path.join(base.homeDir, '.npmrc') }, true],
    [{ npm_config_globalconfig: path.join(prefix, 'etc', 'npmrc') }, true],
    [{ npm_config_prefix: prefix }, true],
    [{ NPM_CONFIG_USERCONFIG: path.join(base.homeDir, 'other.npmrc') }, false],
    [{ npm_config_globalconfig: path.join(base.host, 'elsewhere', 'npmrc') }, false],
    [{ npm_config_globalconfig: 'etc/npmrc' }, false],
    [{ npm_config_prefix: path.join(base.host, 'elsewhere') }, false],
  ];
  for (const [env, allowed] of cases) {
    const root = await pnpmWorkspace(t);
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm', env: { ...base, env } });
    assert.equal(result.ok, allowed, JSON.stringify(env));
  }
});

test('quoted and escaped .npmrc keys mean what npm and pnpm read', async (t) => {
  const cases = [
    ['"git-branch-lockfile"=true\n', 'LOCKFILE_UNDETERMINED'],
    ['"git-branch-lockfil\\u0065"=true\n', 'LOCKFILE_UNDETERMINED'],
    ['"pnpmfile"=./hooks.cjs\n', 'PNPMFILE'],
    ['"pnpmfil\\u0065"=./hooks.cjs\n', 'PNPMFILE'],
  ];
  for (const [text, code] of cases) {
    const root = await pnpmWorkspace(t);
    await files(root, { '.npmrc': text });
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
    assert.equal(result.ok, false, text);
    assert.equal(result.refusal.code, code, text);
  }
});

test('path settings are compared exactly as written', async (t) => {
  for (const setting of ['modulesDir: "node_modules "', 'modulesDir: " node_modules"', 'modulesDir: ./node_modules', 'modulesDir: node_modules/', 'virtualStoreDir: "node_modules/.pnpm "']) {
    const root = await pnpmWorkspace(t);
    await files(root, { 'pnpm-workspace.yaml': `packages:\n  - packages/*\n${setting}\n` });
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
    assert.equal(result.ok, false, setting);
  }
  const root = await pnpmWorkspace(t);
  await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\nmodulesDir: node_modules\nvirtualStoreDir: node_modules/.pnpm\nuseLockfile: " TRUE "\n' });
  assert.equal((await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' })).ok, true);
});

test('a backslash separates path settings only on Windows', async (t) => {
  for (const [setting, platform, allowed] of [
    ['modulesDir: node_modules\\', 'linux', false],
    ['virtualStoreDir: node_modules\\.pnpm', 'darwin', false],
    ['modulesDir: node_modules\\', 'win32', false],
    ['virtualStoreDir: node_modules\\.pnpm', 'win32', true],
  ]) {
    const root = await pnpmWorkspace(t);
    await files(root, { 'pnpm-workspace.yaml': `packages:\n  - packages/*\n${setting}\n` });
    const env = await environment(t, { platform });
    const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm', env });
    assert.equal(result.ok, allowed, `${setting} on ${platform}`);
  }
});
