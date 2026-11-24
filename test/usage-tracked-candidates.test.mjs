import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { shouldInvalidateSourceEvidence } from '../out/host/usage/sourceEvidenceFiles.js';
import { token, symlinkOrSkip } from './helpers/usage-coverage.mjs';

async function fixture(t, file, source, entries = []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-usage6-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (file, text) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  await write(file, source);
  for (const [name, text] of entries) await write(name, text);
  const platform = {
    statFile: stat, readFile,
    async findFiles(search) {
      return path.matchesGlob(file, search.include) ? [path.join(root, file)] : [];
    },
  };
  return { root, platform, write,
    tracked: file => shouldInvalidateSourceEvidence(platform, root, path.join(root, file)),
    analyze: () => analyzeDependencyUsage({ platform, folder: { id: root, name: 'usage-fixture', path: root },
      dir: '', manifestText: '{}', packageNames: ['only-here'], token }),
  };
}

test('cached missing candidates retain their lexical identity after a directory symlink is replaced', async t => {
  const s = await fixture(t, 'theme.scss',
    '@import "./vendor/original/theme"; @import "./vendor/alias/theme";',
    [['vendor/original/_theme.scss', '.x { color: red; }']]);
  const alias = path.join(s.root, 'vendor/alias');
  if (!await symlinkOrSkip(t, 'original', alias, 'dir')) return;
  const candidate = 'vendor/alias/_theme.import.scss';
  let misses = 0;
  s.platform.statFile = async file => {
    if (file === path.join(s.root, 'vendor/original/_theme.import.scss')) misses += 1;
    return stat(file);
  };
  assert.equal((await s.analyze()).get('only-here').truncated, false);
  assert.equal(misses, 1, 'the second import must use the cached miss');
  await rm(alias);
  await s.write(candidate, '@use "pkg:only-here";');
  assert.equal(s.tracked(candidate), true, 'the cached alias must remain tracked after retargeting');
  assert.ok((await s.analyze()).get('only-here').references.length > 0);
  await s.write('theme.scss', '/* imports removed */');
  await s.analyze();
  assert.equal(s.tracked(candidate), false);
});

for (const [file, source, fallback, candidate] of [
  ['theme.scss', '@use "./vendor/theme";', 'vendor/_theme.scss', 'vendor/theme.scss'],
  ['theme.sass', '@forward "./vendor/theme"', 'vendor/theme/_index.sass', 'vendor/_theme.sass'],
  ['theme.scss', '@import "./vendor/theme";', 'vendor/theme/_index.scss', 'vendor/theme/_index.import.scss'],
  ['theme.scss', '@import "./vendor/theme.scss";', 'vendor/_theme.scss', 'vendor/_theme.import.scss'],
  ['theme.scss', '@include meta.load-css("./vendor/theme");', 'vendor/theme/_index.scss', 'vendor/_theme.scss'],
  ['theme.less', '@import "./vendor/theme";', 'vendor/_theme.less', 'vendor/theme.less'],
  ['theme.styl', '@require "./vendor/theme"', 'vendor/_theme.styl', 'vendor/theme.styl'],
  ['theme.css', '@config "./vendor/plugin";', 'vendor/plugin.cjs', 'vendor/plugin.js'],
  ['theme.css', '@plugin "./vendor/plugin";', 'vendor/plugin.cjs', 'vendor/plugin.ts'],
  ['theme.less', '@plugin "./vendor/plugin";', 'vendor/plugin.cjs', 'vendor/plugin.mjs'],
  ['theme.styl', 'use("./vendor/plugin")', 'vendor/plugin.cjs', 'vendor/plugin.js'],
]) {
  test(`missing ${candidate} for ${source} is tracked and retired on replacement`, async t => {
    const s = await fixture(t, file, source, [[fallback, '/* no dependencies */']]);
    const initial = (await s.analyze()).get('only-here');
    assert.equal(initial.truncated, false);
    assert.equal(initial.references.length, 0);
    assert.equal(s.tracked(candidate), true);
    await s.write(candidate, '/* created */');
    assert.equal(s.tracked(candidate), true);
    await s.write(file, '/* directive removed */');
    await s.analyze();
    assert.equal(s.tracked(candidate), false);
    assert.equal(s.tracked(fallback), false);
  });
}

for (const [file, source, candidate, entries] of [
  ['theme.scss', '@use "./vendor/missing"; @use "./vendor/missing";', 'vendor/_missing.scss', []],
  ['theme.css', '.x { background: url("./vendor/missing.png"); }', 'vendor/missing.png', []],
  ['theme.styl', 'json("./vendor/missing.json")', 'vendor/missing.json', []],
  ['theme.css', '@import "./vendor/theme.css";', 'vendor/local-package',
    [['vendor/theme.css', '@source "local-package/**/*.tsx"; @source "local-package/**/*.tsx";']]],
  ['theme.css', '@plugin "./vendor/plugin.cjs";', 'vendor/locales',
    [['vendor/plugin.cjs', 'require.context("./locales", true, /\\.js$/);']]],
]) {
  test(`inspected missing input ${candidate} is tracked for ${source}`, async t => {
    const s = await fixture(t, file, source, entries);
    await s.analyze();
    assert.equal(s.tracked(candidate), true);
    assert.equal(s.tracked('node_modules/unrelated/new.js'), false);
    assert.equal(s.tracked('.next/cache/new.js'), false);
    await s.write(file, '/* directive removed */');
    await s.analyze();
    assert.equal(s.tracked(candidate), false);
  });
}
