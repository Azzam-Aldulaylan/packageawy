import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { scanBulkImport } from '../out/core/usage/bulkImportScan.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { shouldInvalidateSourceEvidence } from '../out/host/usage/sourceEvidenceFiles.js';
import { token, symlinkOrSkip } from './helpers/usage-coverage.mjs';

async function fixture(t, entries, discovered) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-usage5-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of entries) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const folder = { id: root, name: 'usage-fixture', path: root };
  const platform = {
    statFile: stat, readFile,
    async findFiles(search) {
      return discovered.filter(file => path.matchesGlob(file, search.include)).map(file => path.join(root, file));
    },
  };
  return { root, platform, folder,
    analyze: (overrides = {}) => analyzeDependencyUsage({ platform, folder, dir: '', manifestText: '{}', packageNames: ['only-here'], token, ...overrides }),
    compatibility: (overrides = {}) => collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here', ...overrides }),
  };
}

const magic = ['@(pages|vendor)', '!(pages)', '+(vendor)', '*(vendor)', '?(vendor)', '{pages,vendor}', '[pv]*', '*', '?', '**'];
for (const segment of magic) {
  for (const loader of ['glob', 'context']) {
    test(`${loader} ${segment} proves only the directory before the magic segment`, () => {
      const target = `./src/${segment}/nested/${loader === 'glob' ? '*.js' : ''}`;
      const source = loader === 'glob' ? `import.meta.glob(${JSON.stringify(target)})` : `require.context(${JSON.stringify(target)})`;
      assert.deepEqual(scanBulkImport(source, 'main.js').localDirectories, ['src']);
    });
  }
}

for (const segment of ['@(pages|vendor)', '+(vendor)']) {
  test(`${segment} cannot hide excluded imports in usage or compatibility`, async t => {
    const s = await fixture(t, [['main.js', `import.meta.glob("./${segment}/*.js");`],
      ['vendor/feature.js', 'import "only-here";']], ['main.js']);
    assert.equal((await s.analyze()).get('only-here').truncated, true);
    assert.equal((await s.compatibility()).truncated, true);
  });
}

for (const [file, source] of [
  ['theme.css', '@plugin "./vendor/plugin.cjs";'],
  ['theme.css', '@config "./vendor/plugin.cjs";'],
  ['theme.less', '@plugin "./vendor/plugin.cjs";'],
  ['theme.styl', 'use("./vendor/plugin.cjs")'],
]) {
  for (const dependency of ['module.exports = require("./helper.cjs");', String.raw`module.exports = require(".\\helper.cjs");`,
    'import "./helper.cjs";', 'export * from "./helper.cjs";']) {
    test(`${source} with ${dependency} retains uncertainty`, async t => {
      const s = await fixture(t, [[file, source], ['vendor/plugin.cjs', dependency],
        ['vendor/helper.cjs', 'require("only-here");']], [file]);
      const usage = (await s.analyze()).get('only-here');
      assert.equal(usage.truncated, true);
      assert.notEqual(assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status, 'low-risk');
    });
  }
}

test('a source symlink cannot prove a bulk directory beside the link', async t => {
  const s = await fixture(t, [['vendor/main.js', 'require.context("./locales", true, /\\.js$/);'],
    ['vendor/locales/en.js', 'import "only-here";']], ['main.js']);
  if (!await symlinkOrSkip(t, 'vendor/main.js', path.join(s.root, 'main.js'))) return;
  assert.equal((await s.analyze()).get('only-here').truncated, true);
  assert.equal((await s.compatibility()).truncated, true);
});

test('Less (less) overrides an imported CSS extension', async t => {
  const s = await fixture(t, [['theme.less', '@import (less) "./vendor/theme.css";'],
    ['vendor/theme.css', '.x { width: image-width("only-here/a.png"); }']], ['theme.less']);
  assert.ok((await s.analyze()).get('only-here').references.length > 0);
});

test('Less (css) overrides an imported Less extension', async t => {
  const s = await fixture(t, [['theme.less', '@import (css) "./vendor/theme.less";'],
    ['vendor/theme.less', '.x { width: image-width("only-here/a.png"); }']], ['theme.less']);
  assert.equal((await s.analyze()).get('only-here').references.length, 0);
});

for (const kind of ['analyze', 'compatibility']) {
  test(`cancelled ${kind} keeps the preceding followed-file identities`, async t => {
    const s = await fixture(t, [['vendor/main.js', 'export const value = 1;']], ['main.js']);
    if (!await symlinkOrSkip(t, 'vendor/main.js', path.join(s.root, 'main.js'))) return;
    await s[kind]();
    s.platform.findFiles = async () => [];
    const controller = new AbortController();
    controller.abort();
    await s[kind]({ token: { ...token, isCancellationRequested: true }, signal: controller.signal });
    assert.equal(shouldInvalidateSourceEvidence(s.platform, s.root, path.join(s.root, 'vendor/main.js')), true);
  });
}

test('an excluded plugin is watched while its first read is pending', async t => {
  const s = await fixture(t, [['theme.css', '@plugin "./vendor/plugin.cjs";'],
    ['vendor/plugin.cjs', 'module.exports = {};']], ['theme.css']);
  let release;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const read = s.platform.readFile;
  s.platform.readFile = async file => {
    if (file.endsWith('plugin.cjs')) { started(); await held; }
    return read(file);
  };
  const scan = s.analyze();
  await reading;
  assert.equal(shouldInvalidateSourceEvidence(s.platform, s.root, path.join(s.root, 'vendor/plugin.cjs')), true);
  release();
  await scan;
});
