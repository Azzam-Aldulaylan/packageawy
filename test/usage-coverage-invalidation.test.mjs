import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { token, symlinkOrSkip } from './helpers/usage-coverage.mjs';
import { panel, until } from './helpers/dashboard-startup.mjs';

for (const [file, content] of [['doc.mdx', '# New document'], ['style.scss', '@use "only-here";'], ['style-fragment', '@import "only-here";'], ['vendor/theme.css', '@import "clean-pkg";']]) {
  for (const event of ['create', 'change', 'delete']) {
    test(`${event} ${file} revokes cached usage and a real open removal plan synchronously`, async t => {
      const s = await panel(t);
      await s.prepared();
      await mkdir(path.join(s.root, 'a/vendor'), { recursive: true });
      await writeFile(path.join(s.root, 'a/theme.css'), '@import "./vendor/theme.css";');
      await writeFile(path.join(s.root, 'a/vendor/theme.css'), '.x {}');
      const findFiles = s.platform.findFiles;
      s.platform.findFiles = async search => search.include.includes('mdx,css') ? [path.join(s.root, 'a/theme.css')] : findFiles(search);
      s.gate.resolve();
      await s.ready();
      const usage = s.current.usageCoordinator;
      await until(() => s.posted.some(message => message.status === 'cleanup-result' && message.findings.length > 0));
      await usage.handleWhereUsed({ package: 'clean-pkg' });
      assert.equal(s.posted.findLast(message => message.status === 'usage-result').analysis.fromCache, true);
      await usage.handleAnalyzeRemovalImpact({ requestId: 'impact', packages: ['clean-pkg'] });
      const guard = usage.smartCleanupRemovalEvidence('impact', ['clean-pkg']);
      assert.ok(guard);
      await s.current.upgradeCoordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'plan', removalRequestId: 'impact', packages: ['clean-pkg'] });
      const removal = s.posted.findLast(message => message.status === 'remove-analysis');
      assert.ok(removal, JSON.stringify(s.posted.filter(message => message.status === 'remove-error')));
      const absolutePath = path.join(s.root, 'a', file);
      if (event === 'delete') {
        await writeFile(absolutePath, content);
        await rm(absolutePath);
      } else {
        if (event === 'change') await writeFile(absolutePath, 'old');
        await writeFile(absolutePath, content);
      }
      const sourceWatcher = s.watchers.findLast(watcher => watcher.glob.includes('**/*.{js'));
      assert.ok(path.matchesGlob(file, sourceWatcher.glob), 'coverage inputs must use the real usage watcher');
      const before = s.posted.length;
      sourceWatcher.listener(absolutePath);
      assert.equal(guard.isCurrent(), false);
      const messages = s.posted.slice(before);
      assert.equal(messages.find(message => message.status === 'usage-error').error.code, 'STALE_SOURCE');
      assert.equal(messages.find(message => message.status === 'removal-impact-error').requestId, 'impact');
      assert.equal(messages.find(message => message.status === 'remove-error').error.code, 'STALE_SOURCE');
      assert.equal(s.current.upgradeCoordinator.removal, undefined);
      assert.equal(usage.smartCleanupRemovalEvidence('impact', ['clean-pkg']), null);
    });
  }
}

for (const file of ['.next/cache/generated.js', 'node_modules/unfollowed/index.js', 'vendor/unfollowed.css']) {
  test(`unfollowed ${file} preserves removal evidence and schedules no refresh`, async t => {
    const s = await panel(t);
    await s.prepared();
    s.gate.resolve();
    await s.ready();
    const usage = s.current.usageCoordinator;
    await until(() => s.posted.some(message => message.status === 'cleanup-result'));
    await usage.handleAnalyzeRemovalImpact({ requestId: 'impact', packages: ['clean-pkg'] });
    const guard = usage.smartCleanupRemovalEvidence('impact', ['clean-pkg']);
    assert.ok(guard);
    let refreshes = 0;
    s.current.requestAutomaticUsageRefresh = () => { refreshes += 1; };
    const before = s.current.projectCompatibilitySourceGeneration;
    const watcher = s.watchers.findLast(value => value.glob.includes('**/*.{js'));
    const created = path.join(s.root, 'a', file);
    await mkdir(path.dirname(created), { recursive: true });
    await writeFile(created, 'import "clean-pkg";');
    watcher.listener(created);
    assert.equal(guard.isCurrent(), true);
    assert.equal(s.current.projectCompatibilitySourceGeneration, before);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(refreshes, 0);
  });
}

test('creating a preferred Sass import-only partial revokes real removal evidence', async t => {
  const s = await panel(t);
  await s.prepared();
  const root = path.join(s.root, 'a');
  await mkdir(path.join(root, 'vendor'), { recursive: true });
  await writeFile(path.join(root, 'theme.scss'), '@import "./vendor/theme";');
  await writeFile(path.join(root, 'vendor/_theme.scss'), '.x { color: red; }');
  const findFiles = s.platform.findFiles;
  s.platform.findFiles = async search => search.include.includes('mdx,css')
    ? [path.join(root, 'theme.scss')] : findFiles(search);
  const analyze = () => analyzeDependencyUsage({ platform: s.platform,
    folder: { id: s.root, name: 'workspace', path: s.root }, dir: 'a',
    manifestText: '{}', packageNames: ['only-here'], token });
  const initial = (await analyze()).get('only-here');
  assert.equal(initial.truncated, false);
  assert.equal(initial.references.length, 0);
  s.gate.resolve();
  await s.ready();
  await until(() => s.posted.some(message => message.status === 'cleanup-result'));
  const usage = s.current.usageCoordinator;
  await usage.handleAnalyzeRemovalImpact({ requestId: 'sass-impact', packages: ['clean-pkg'] });
  const guard = usage.smartCleanupRemovalEvidence('sass-impact', ['clean-pkg']);
  assert.ok(guard);
  assert.equal(guard.isCurrent(), true);
  const preferred = path.join(root, 'vendor/_theme.import.scss');
  await writeFile(preferred, '@use "pkg:only-here";');
  const watcher = s.watchers.findLast(value => value.glob.includes('**/*.{js'));
  assert.ok(path.matchesGlob('vendor/_theme.import.scss', watcher.glob));
  watcher.listener(preferred);
  assert.equal(guard.isCurrent(), false);
  assert.equal(usage.smartCleanupRemovalEvidence('sass-impact', ['clean-pkg']), null);
  assert.ok((await analyze()).get('only-here').references.length > 0);
});

for (const followed of ['stylesheet', 'plugin', 'compatibility']) {
  for (const event of ['change', 'delete']) {
    test(`${event} of a canonical ${followed} target in vendor revokes evidence`, async t => {
      const s = await panel(t);
      await s.prepared();
      const root = path.join(s.root, 'a');
      await mkdir(path.join(root, 'vendor'), { recursive: true });
      const extension = followed === 'stylesheet' ? 'css' : 'cjs';
      const actual = path.join(root, `vendor/actual.${extension}`);
      const link = path.join(root, `vendor/linked.${extension}`);
      await writeFile(actual, followed === 'stylesheet' ? '.x {}' : 'module.exports = {};');
      if (!await symlinkOrSkip(t, `actual.${extension}`, link)) return;
      const source = followed === 'stylesheet' ? '@import "./vendor/linked.css";'
        : '@plugin "./vendor/actual.cjs";';
      await writeFile(path.join(root, 'theme.css'), source);
      const findFiles = s.platform.findFiles;
      if (followed !== 'compatibility') s.platform.findFiles = async search =>
        search.include.includes('mdx,css') ? [path.join(root, 'theme.css')] : findFiles(search);
      s.gate.resolve();
      await s.ready();
      const usage = s.current.usageCoordinator;
      await until(() => s.posted.some(message => message.status === 'cleanup-result'));
      await usage.handleAnalyzeRemovalImpact({ requestId: 'impact', packages: ['clean-pkg'] });
      const guard = usage.smartCleanupRemovalEvidence('impact', ['clean-pkg']);
      assert.ok(guard);
      if (followed === 'compatibility') {
        s.platform.findFiles = async search => path.matchesGlob('entry.cjs', search.include)
          ? [path.join(root, 'entry.cjs')] : [];
        if (!await symlinkOrSkip(t, 'vendor/actual.cjs', path.join(root, 'entry.cjs'))) return;
        await collectProjectCompatibilityEvidence({ platform: s.platform,
          folder: { id: s.root, name: 'workspace', path: s.root }, dir: 'a', manifestText: '{}', packageName: 'clean-pkg' });
        s.platform.findFiles = findFiles;
      }
      const changed = event === 'delete' && followed === 'stylesheet' ? link : actual;
      if (event === 'delete') await rm(changed);
      else await writeFile(changed, '/* changed */');
      const watcher = s.watchers.findLast(value => value.glob.includes('**/*.{js'));
      watcher.listener(changed);
      assert.equal(guard.isCurrent(), false);
    });
  }
}

test('a replacement usage scan stops watching excluded files it no longer follows', async t => {
  const s = await panel(t);
  await s.prepared();
  const root = path.join(s.root, 'a');
  await mkdir(path.join(root, 'vendor'), { recursive: true });
  await writeFile(path.join(root, 'theme.css'), '@import "./vendor/theme.css";');
  await writeFile(path.join(root, 'vendor/theme.css'), '.x {}');
  const findFiles = s.platform.findFiles;
  s.platform.findFiles = async search => search.include.includes('mdx,css')
    ? [path.join(root, 'theme.css')] : findFiles(search);
  s.gate.resolve();
  await s.ready();
  await until(() => s.posted.some(message => message.status === 'cleanup-result'));
  await writeFile(path.join(root, 'theme.css'), '.x {}');
  const usage = s.current.usageCoordinator;
  usage.invalidateProjectSource();
  await usage.handleAnalyzeRemovalImpact({ requestId: 'replacement', packages: ['clean-pkg'] });
  const guard = usage.smartCleanupRemovalEvidence('replacement', ['clean-pkg']);
  assert.ok(guard);
  s.watchers.findLast(value => value.glob.includes('**/*.{js')).listener(path.join(root, 'vendor/theme.css'));
  assert.equal(guard.isCurrent(), true);
});
