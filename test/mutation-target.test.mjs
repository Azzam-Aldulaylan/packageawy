/**
 * The mutation target resolver: which directory and lockfile a dependency
 * change writes, and every case where that cannot be established safely.
 * pnpm settings that move the lockfile are in mutation-target-pnpm.test.mjs.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertRefused, files, manifest, resolve, tempDir } from './helpers/mutation-target-fixtures.mjs';

const { OUTSIDE_FOLDER_REASON, PATH_ESCAPES_REASON } = await import('../out/host/mutationTarget.js');
const { LOCKFILE_UNDETERMINED_REASON } = await import('../out/host/pnpmLockfileSettings.js');
const { matchWorkspacePatterns } = await import('../out/core/workspace/patterns.js');
const { authorizedRelation, canonicalPath, lockKey, relatePaths } = await import('../out/host/pathIdentity.js');
const { ProjectMutationLocks } = await import('../out/host/projectMutationLock.js');
// ------------------------------------------------------------ affirmative

test('a single npm package owns its own lockfile', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': manifest(), 'package-lock.json': '{}' });
  const result = await resolve(t, { folder: root, project: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.target, {
    root,
    lockfilePath: path.join(root, 'package-lock.json'),
    lockfileName: 'package-lock.json',
    lockfileExists: true,
    packageManager: 'npm',
    importerId: '.',
    workspaceMember: false,
  });
});

test('an npm workspace member opened from the workspace root writes the root lockfile', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['packages/*'] }),
    'package-lock.json': '{}',
    'packages/app/package.json': manifest(),
  });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app') });
  assert.equal(result.ok, true);
  assert.equal(result.target.root, root);
  assert.equal(result.target.lockfilePath, path.join(root, 'package-lock.json'));
  assert.equal(result.target.importerId, 'packages/app');
  assert.equal(result.target.workspaceMember, true);
});

test('a stray member lockfile is ignored in favour of the workspace root lockfile', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: { packages: ['packages/**'] } }),
    'package-lock.json': '{}',
    'packages/app/package.json': manifest(),
    'packages/app/package-lock.json': '{}',
  });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app') });
  assert.equal(result.target.lockfilePath, path.join(root, 'package-lock.json'));
});

test('an ancestor workspace that does not include the project leaves it standalone', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['packages/*'] }),
    'packages/app/sub/package.json': manifest(),
    'tools/cli/package.json': manifest(),
  });
  for (const dir of ['packages/app/sub', 'tools/cli']) {
    const result = await resolve(t, { folder: root, project: path.join(root, dir) });
    assert.equal(result.ok, true);
    assert.equal(result.target.root, path.join(root, dir));
    assert.equal(result.target.importerId, '.');
  }
});

test('malformed metadata in an ancestor that cannot claim the project is ignored', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': '{ not json', 'app/package.json': manifest() });
  const result = await resolve(t, { folder: root, project: path.join(root, 'app') });
  assert.equal(result.ok, true);
  assert.equal(result.target.root, path.join(root, 'app'));
});

test('a workspace with no lockfile yet names the exact root lockfile it will get', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['packages/*'] }),
    'packages/app/package.json': manifest(),
  });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app') });
  assert.equal(result.target.lockfilePath, path.join(root, 'package-lock.json'));
  assert.equal(result.target.lockfileExists, false);
});

test('npm-shrinkwrap.json wins over package-lock.json at the root', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': manifest(), 'package-lock.json': '{}', 'npm-shrinkwrap.json': '{}' });
  const result = await resolve(t, { folder: root, project: root });
  assert.equal(result.target.lockfileName, 'npm-shrinkwrap.json');
  assert.equal(result.target.lockfilePath, path.join(root, 'npm-shrinkwrap.json'));
});

test('npm and pnpm lockfiles side by side keep the selected manager, without a refusal', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': manifest(), 'package-lock.json': '{}', 'pnpm-lock.yaml': '' });
  assert.equal((await resolve(t, { folder: root, project: root })).target.lockfileName, 'package-lock.json');
  const pnpm = await resolve(t, { folder: root, project: root, packageManager: 'pnpm' });
  assert.equal(pnpm.target.lockfileName, 'pnpm-lock.yaml');
});

test('a pnpm monorepo member opened from its root writes the root pnpm-lock.yaml', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['ignored/*'] }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'pnpm-lock.yaml': '',
    'packages/app/package.json': manifest(),
  });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
  assert.equal(result.ok, true);
  assert.equal(result.target.root, root);
  assert.equal(result.target.lockfilePath, path.join(root, 'pnpm-lock.yaml'));
  assert.equal(result.target.importerId, 'packages/app');
});

test('a pnpm workspace with no root package.json and no lockfile still owns its members', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - apps/*\n', 'apps/web/package.json': manifest() });
  const result = await resolve(t, { folder: root, project: path.join(root, 'apps/web'), packageManager: 'pnpm' });
  assert.equal(result.target.root, root);
  assert.equal(result.target.lockfileExists, false);
});

test('nested pnpm workspaces resolve to the nearest workspace file', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'pnpm-workspace.yaml': 'packages:\n  - "**"\n',
    'inner/pnpm-workspace.yaml': 'packages:\n  - pkgs/*\n',
    'inner/pkgs/a/package.json': manifest(),
  });
  const result = await resolve(t, { folder: root, project: path.join(root, 'inner/pkgs/a'), packageManager: 'pnpm' });
  assert.equal(result.target.root, path.join(root, 'inner'));
});

test('a package under a pnpm workspace that does not list it is refused', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'scripts/tool/package.json': manifest() });
  const result = await resolve(t, { folder: root, project: path.join(root, 'scripts/tool'), packageManager: 'pnpm' });
  assertRefused(result, 'LOCKFILE_UNDETERMINED', LOCKFILE_UNDETERMINED_REASON);
});

// ------------------------------------------------------------ boundaries

test('a member opened as the folder is refused because the root lockfile is outside it', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['packages/*'] }),
    'package-lock.json': '{}',
    'packages/app/package.json': manifest(),
  });
  const member = path.join(root, 'packages/app');
  assertRefused(await resolve(t, { folder: member, project: member }), 'OUTSIDE_FOLDER', OUTSIDE_FOLDER_REASON);
  // A folder between the member and the root is just as outside.
  const between = path.join(root, 'packages');
  assertRefused(await resolve(t, { folder: between, project: member }), 'OUTSIDE_FOLDER', OUTSIDE_FOLDER_REASON);
});

test('overlapping workspace folders use the owning folder as the boundary, never their union', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['packages/*'] }),
    'packages/app/package.json': manifest(),
  });
  const member = path.join(root, 'packages/app');
  // Discovered under the outer folder: fine. Under the nested folder: refused.
  assert.equal((await resolve(t, { folder: root, project: member })).ok, true);
  assertRefused(await resolve(t, { folder: member, project: member }), 'OUTSIDE_FOLDER', OUTSIDE_FOLDER_REASON);
});

test('a pnpm member opened as the folder is refused', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'packages/a/package.json': manifest() });
  const member = path.join(root, 'packages/a');
  const result = await resolve(t, { folder: member, project: member, packageManager: 'pnpm' });
  assertRefused(result, 'OUTSIDE_FOLDER', OUTSIDE_FOLDER_REASON);
});

// ------------------------------------------------------------ symlinks

test('a symlinked project directory inside the folder is refused', async (t) => {
  const root = await tempDir(t);
  const elsewhere = await tempDir(t, 'packageawy-elsewhere-');
  await files(elsewhere, { 'package.json': manifest() });
  await files(root, { 'package.json': manifest() });
  await symlink(elsewhere, path.join(root, 'linked'));
  const result = await resolve(t, { folder: root, project: path.join(root, 'linked') });
  assertRefused(result, 'PATH_ESCAPES', PATH_ESCAPES_REASON);
});

test('a symlinked lockfile is refused', async (t) => {
  const root = await tempDir(t);
  const elsewhere = await tempDir(t, 'packageawy-elsewhere-');
  await files(elsewhere, { 'package-lock.json': '{}' });
  await files(root, { 'package.json': manifest() });
  await symlink(path.join(elsewhere, 'package-lock.json'), path.join(root, 'package-lock.json'));
  assertRefused(await resolve(t, { folder: root, project: root }), 'PATH_ESCAPES', PATH_ESCAPES_REASON);
});

test('an opened folder that is itself a link is refused, a link above it is fine', async (t) => {
  const real = await tempDir(t);
  await files(real, { 'project/package.json': manifest() });
  const parentLink = `${real}-alias`;
  await symlink(real, parentLink);
  t.after(() => rm(parentLink, { force: true }));
  // The link is above the opened folder: allowed, and paths keep the folder's spelling.
  const above = await resolve(t, { folder: path.join(parentLink, 'project'), project: path.join(parentLink, 'project') });
  assert.equal(above.ok, true);
  assert.equal(above.target.root, path.join(parentLink, 'project'));
  // The opened folder itself is the link.
  const folderLink = `${real}-folder`;
  await symlink(path.join(real, 'project'), folderLink);
  t.after(() => rm(folderLink, { force: true }));
  assertRefused(await resolve(t, { folder: folderLink, project: folderLink }), 'PATH_ESCAPES', PATH_ESCAPES_REASON);
});

// ------------------------------------------------------- unreadable metadata

test('malformed or unreadable workspace metadata that could claim the project is refused', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': '{ "workspaces": [', 'app/package.json': manifest() });
  assertRefused(await resolve(t, { folder: root, project: path.join(root, 'app') }), 'LOCKFILE_UNDETERMINED', LOCKFILE_UNDETERMINED_REASON);

  const pnpmRoot = await tempDir(t);
  await files(pnpmRoot, { 'pnpm-workspace.yaml': 'packages: [unclosed', 'app/package.json': manifest() });
  assertRefused(
    await resolve(t, { folder: pnpmRoot, project: path.join(pnpmRoot, 'app'), packageManager: 'pnpm' }),
    'LOCKFILE_UNDETERMINED',
    LOCKFILE_UNDETERMINED_REASON
  );

  const invalidPatterns = await tempDir(t);
  await files(invalidPatterns, { 'package.json': manifest({ workspaces: 'packages/*' }), 'packages/a/package.json': manifest() });
  assertRefused(
    await resolve(t, { folder: invalidPatterns, project: path.join(invalidPatterns, 'packages/a') }),
    'LOCKFILE_UNDETERMINED',
    LOCKFILE_UNDETERMINED_REASON
  );
});

test('an unreadable ancestor package.json is refused', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': manifest({ workspaces: ['app'] }), 'app/package.json': manifest() });
  await chmod(path.join(root, 'package.json'), 0o000);
  assertRefused(await resolve(t, { folder: root, project: path.join(root, 'app') }), 'LOCKFILE_UNDETERMINED', LOCKFILE_UNDETERMINED_REASON);
});

test('a filesystem failure part way through is an expected refusal, never a thrown error', async (t) => {
  const root = await tempDir(t);
  const result = await resolve(t, { folder: path.join(root, 'missing'), project: path.join(root, 'missing') });
  assertRefused(result, 'LOCKFILE_UNDETERMINED', LOCKFILE_UNDETERMINED_REASON);
});

// ------------------------------------------------------- identity and paths

test('the identity changes with the topology and not with file contents', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'package.json': manifest(), 'packages/app/package.json': manifest() });
  const project = path.join(root, 'packages/app');
  const standalone = await resolve(t, { folder: root, project });
  await files(project, { 'package-lock.json': '{}', 'package.json': manifest({ description: 'edited' }) });
  assert.equal((await resolve(t, { folder: root, project })).identity, standalone.identity, 'a new lockfile or edit keeps the identity');
  await files(root, { 'package.json': manifest({ workspaces: ['packages/*'] }) });
  const member = await resolve(t, { folder: root, project });
  assert.notEqual(member.identity, standalone.identity, 'joining a workspace moves the target');
});

test('sibling members of one workspace share one project lock', async (t) => {
  const root = await tempDir(t);
  await files(root, {
    'package.json': manifest({ workspaces: ['packages/*'] }),
    'packages/a/package.json': manifest(),
    'packages/b/package.json': manifest(),
  });
  const a = await resolve(t, { folder: root, project: path.join(root, 'packages/a') });
  const b = await resolve(t, { folder: root, project: path.join(root, 'packages/b') });
  assert.equal(lockKey(a.target.root), lockKey(b.target.root));
  const locks = new ProjectMutationLocks();
  assert.ok(locks.tryAcquire(a.target.root, {}));
  assert.equal(locks.tryAcquire(b.target.root, {}), null);
});

const included = (patterns, dir) => assert.deepEqual(matchWorkspacePatterns(patterns, dir), { result: 'included' }, `${JSON.stringify(patterns)} ${dir}`);
const excluded = (patterns, dir) => assert.deepEqual(matchWorkspacePatterns(patterns, dir), { result: 'excluded' }, `${JSON.stringify(patterns)} ${dir}`);

test('workspace patterns support plain paths, a trailing /* and /** segments', () => {
  included(['packages/*'], 'packages/app');
  excluded(['packages/*'], 'packages/app/sub');
  excluded(['packages/*'], 'packages');
  included(['packages/*', 'apps/*'], 'apps/web');
  included(['packages/**'], 'packages/app/sub');
  included(['packages/**'], 'packages');
  included(['**/pkg'], 'a/b/pkg');
  included(['tools/cli'], 'tools/cli');
  // A wildcard does not match a name that starts with a dot.
  excluded(['packages/*'], 'packages/.hidden');
  included(['packages/.hidden'], 'packages/.hidden');
});

test('every other pattern form is reported as unsupported, by the pattern itself', () => {
  for (const pattern of [
    '!packages/a', '!!packages/*', 'apps/{web,api}', 'pkg-?', 'libs/[ab]*', 'packages/@(a|b)', 'packages/+(a)',
    'packages/a*', 'packages/*/sub', './packages/*', '../outside/*', '/abs/*', 'a\\b', 'packages//a', '',
    ' packages/* ', 'packages/*\t', '././packages/a', './tools/cli', 'packages/./a', 'packages/a/', 'packages/', '.',
  ]) {
    assert.deepEqual(matchWorkspacePatterns(['packages/*', pattern], 'packages/app'), { result: 'unsupported', pattern }, pattern);
  }
});

test('an unsupported workspace pattern refuses, naming it, for npm and pnpm', async (t) => {
  const npmRoot = await tempDir(t);
  await files(npmRoot, {
    'package.json': manifest({ workspaces: ['packages/*', '!packages/legacy'] }),
    'packages/app/package.json': manifest(),
  });
  assertRefused(
    await resolve(t, { folder: npmRoot, project: path.join(npmRoot, 'packages/app') }),
    'LOCKFILE_UNDETERMINED',
    `${LOCKFILE_UNDETERMINED_REASON} Workspace pattern not supported: !packages/legacy`
  );
  const pnpmRoot = await tempDir(t);
  await files(pnpmRoot, { 'pnpm-workspace.yaml': "packages:\n  - 'apps/{web,api}'\n", 'apps/web/package.json': manifest() });
  assertRefused(
    await resolve(t, { folder: pnpmRoot, project: path.join(pnpmRoot, 'apps/web'), packageManager: 'pnpm' }),
    'LOCKFILE_UNDETERMINED',
    `${LOCKFILE_UNDETERMINED_REASON} Workspace pattern not supported: apps/{web,api}`
  );
});

test('spellings npm reads differently are refused, not normalized', async (t) => {
  for (const pattern of [' packages/* ', '././packages/a']) {
    const root = await tempDir(t);
    await files(root, { 'package.json': manifest({ workspaces: [pattern] }), 'packages/a/package.json': manifest() });
    assertRefused(
      await resolve(t, { folder: root, project: path.join(root, 'packages/a') }),
      'LOCKFILE_UNDETERMINED',
      `${LOCKFILE_UNDETERMINED_REASON} Workspace pattern not supported: ${pattern}`
    );
  }
});

test('common workspace setups still resolve to the workspace root', async (t) => {
  for (const [workspaces, member] of [[['packages/*'], 'packages/app'], [['packages/*', 'apps/*'], 'apps/web'], [['packages/**'], 'packages/group/app']]) {
    const root = await tempDir(t);
    await files(root, { 'package.json': manifest({ workspaces }), [`${member}/package.json`]: manifest() });
    const result = await resolve(t, { folder: root, project: path.join(root, member) });
    assert.equal(result.ok, true, JSON.stringify(workspaces));
    assert.equal(result.target.root, root);
  }
  const root = await tempDir(t);
  await files(root, { 'pnpm-workspace.yaml': "packages: ['packages/*']\n", 'packages/app/package.json': manifest() });
  const result = await resolve(t, { folder: root, project: path.join(root, 'packages/app'), packageManager: 'pnpm' });
  assert.equal(result.ok, true);
  assert.equal(result.target.root, root);
});

// ------------------------------------------------------- path identity

const exists = (target) => stat(target).then(() => true, () => false);

test('another spelling of an existing path canonicalizes to the spelling on disk', async (t) => {
  const root = await tempDir(t);
  await files(root, { 'CaseDir/package.json': '' });
  const variant = path.join(root, 'casedir', 'PACKAGE.json');
  if (!(await exists(variant))) {
    t.skip('this volume is case-sensitive, so the other spelling is another file');
    return;
  }
  assert.equal(await canonicalPath(variant), path.join(root, 'CaseDir', 'package.json'));
  assert.equal(await authorizedRelation(path.join(root, 'casedir'), path.join(root, 'CaseDir', 'package.json')), 'inside');
});

test('workspace and WORKSPACE on a case-sensitive volume stay different directories', async (t) => {
  const root = await tempDir(t);
  await mkdir(path.join(root, 'workspace'));
  try {
    await mkdir(path.join(root, 'WORKSPACE'));
  } catch {
    t.skip('this volume ignores case, so both names are one directory');
    return;
  }
  assert.equal(await authorizedRelation(path.join(root, 'workspace'), path.join(root, 'WORKSPACE', 'package-lock.json')), 'outside');
  assert.equal(await authorizedRelation(path.join(root, 'WORKSPACE'), path.join(root, 'workspace')), 'outside');
});

test('a missing file canonicalizes through its nearest existing parent, as written', async (t) => {
  const root = await tempDir(t);
  await mkdir(path.join(root, 'Existing'));
  // The temporary directory may be reached through a link (/tmp on macOS); its realpath is what counts.
  const viaLink = path.join(tmpdir(), path.relative(await realpath(tmpdir()), root));
  assert.equal(await canonicalPath(path.join(viaLink, 'Existing', 'Not', 'Yet.json')), path.join(root, 'Existing', 'Not', 'Yet.json'));
  assert.equal(await authorizedRelation(root, path.join(viaLink, 'Existing', 'new-lockfile.json')), 'inside');
});

test('with Windows path rules, different realpaths never compare equal and failures are unresolved', async () => {
  const missing = (target) => Object.assign(new Error(`ENOENT ${target}`), { code: 'ENOENT' });
  const system = (directories) => ({
    path: path.win32,
    realpath: async (target) => {
      if (target in directories) return directories[target];
      throw missing(target);
    },
  });
  // Case-sensitive directory: both siblings exist and stay themselves.
  const sensitive = system({ 'C:\\workspace': 'C:\\workspace', 'C:\\WORKSPACE': 'C:\\WORKSPACE', 'c:\\workspace': 'C:\\workspace' });
  assert.equal(await authorizedRelation('C:\\workspace', 'C:\\WORKSPACE\\package-lock.json', sensitive), 'outside');
  assert.equal(await authorizedRelation('C:\\workspace', 'c:\\workspace\\package-lock.json', sensitive), 'inside', 'the drive letter has no case');
  // Case-insensitive directory: the realpath gives one spelling for both.
  const insensitive = system({ 'C:\\workspace': 'C:\\workspace', 'C:\\WORKSPACE': 'C:\\workspace' });
  assert.equal(await authorizedRelation('C:\\workspace', 'C:\\WORKSPACE\\package-lock.json', insensitive), 'inside');
  // A realpath that fails for another reason gives no answer.
  const broken = { path: path.win32, realpath: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  assert.equal(await authorizedRelation('C:\\workspace', 'C:\\workspace\\x', broken), 'unresolved');
  // Exact segment comparison, with no folding of its own.
  assert.equal(relatePaths('C:\\workspace', 'C:\\WORKSPACE\\x', path.win32), 'outside');
  assert.equal(relatePaths('/a', '/a/b'), 'inside');
  assert.equal(relatePaths('/a', '/ab'), 'outside');
});

test('the lock key is always lowercased, so it can only make windows wait for each other', async (t) => {
  const root = await tempDir(t);
  await mkdir(path.join(root, 'Repo'));
  assert.equal(lockKey(path.join(root, 'Repo')), path.join(root, 'Repo').toLowerCase());
  const missing = path.join(path.parse(root).root, 'Packageawy-No-Such-Dir', 'Sub');
  assert.equal(lockKey(missing), missing.toLowerCase());
});
