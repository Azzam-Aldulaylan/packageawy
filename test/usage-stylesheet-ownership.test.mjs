import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hasUnreadTemplateImports } from '../out/core/usage/importScan.js';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { usageWorkspace, token, symlinkOrSkip } from './helpers/usage-coverage.mjs';

async function fixture(t, entries) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-usage2-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of entries) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const folder = { id: root, name: 'usage-fixture', path: root };
  const reads = [];
  const stats = [];
  const platform = {
    async statFile(file) { stats.push(file); return stat(file); },
    async readFile(file) { reads.push(file); return readFile(file); },
    async findFiles(search) {
      return entries.map(([file]) => file)
        .filter(file => !file.startsWith('node_modules/') && path.matchesGlob(file, search.include))
        .map(file => path.join(root, file)).slice(0, search.maxResults);
    },
  };
  return { root, reads, stats,
    analyze: (packageNames = ['only-here', 'unused']) => analyzeDependencyUsage({
      platform, folder, dir: '', manifestText: '{}', packageNames, token,
    }),
    compatibility: () => collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' }),
  };
}

for (const loader of ['require', 'import']) {
  test(`${loader} template can escape a fully covered messages directory`, async t => {
    const source = 'const name = "../node_modules/only-here/index";\n' +
      `module.exports = ${loader}(\`./messages/\${name}.js\`);`;
    const s = await fixture(t, [['index.cjs', source], ['messages/en.json', '{}'],
      ['node_modules/only-here/index.js', 'module.exports = "loaded";']]);
    const value = await createRequire(import.meta.url)(path.join(s.root, 'index.cjs'));
    assert.equal(loader === 'import' ? value.default : value, 'loaded');
    assert.equal((await s.analyze()).get('only-here').truncated, true);
    assert.equal((await s.compatibility()).truncated, true);
  });
  test(`${loader} templates stay unread even with an affirmative local proof`, () => {
    assert.equal(hasUnreadTemplateImports(`${loader}(\`./messages/\${locale}.json\`)`, 'index.js', undefined, '', () => true), true);
  });
}

for (const name of ['only-here', '@scope/only-here']) {
  test(`discovered stylesheet symlink also retains canonical owner ${name}`, async t => {
    const s = await fixture(t, [['index.js', 'import "./linked.css";'], ['linked.css', ''],
      [`node_modules/${name}/theme.css`, '.real { color: red; }']]);
    await rm(path.join(s.root, 'linked.css'));
    if (!await symlinkOrSkip(t, `./node_modules/${name}/theme.css`, path.join(s.root, 'linked.css'))) return;
    const results = await s.analyze([name, 'unused']);
    assert.ok(results.get(name).references.length > 0);
    assert.equal(results.get('unused').truncated, false);
  });
  for (const directive of ['@import "./linked.css";', '@import url("./linked.css");']) {
    test(`canonical stylesheet owner ${name} is referenced by ${directive}`, async t => {
      const s = await fixture(t, [['theme.css', directive], [`node_modules/${name}/theme.css`, '.real { color: red; }']]);
      if (!await symlinkOrSkip(t, `./node_modules/${name}/theme.css`, path.join(s.root, 'linked.css'))) return;
      const results = await s.analyze([name, 'unused']);
      assert.ok(results.get(name).references.some(ref => ref.filePath === 'theme.css' && ref.snippet === directive));
      assert.equal(results.get('unused').truncated, false);
    });
  }
}

const loaders = ['load-css', 'load_css', 'meta.load-css', 'meta.load_css', 'alias.load-css', 'alias.load_css', 'my_meta.load_css'];
for (const dialect of ['scss', 'sass']) {
  for (const loader of loaders) {
    const setup = loader.includes('.') ? `@use "sass:meta" as ${loader.split('.')[0]}` : '@use "sass:meta" as *';
    const source = target => `${setup};\n@include ${loader}("${target}");`;
    test(`${dialect} ${loader} retains explicit packages`, async () => {
      const results = await usageWorkspace([[`theme.${dialect}`, source('pkg:only-here/theme')]]).analyze();
      assert.ok(results.get('only-here').references.length > 0);
      assert.equal(results.get('only-here').truncated, false);
    });
    test(`${dialect} ${loader} follows local partials`, async () => {
      const results = await usageWorkspace([[`theme.${dialect}`, source('./local')],
        ['_local.scss', '@use "pkg:only-here/theme";']], { hidden: ['_local.scss'] }).analyze();
      assert.ok(results.get('only-here').references.some(ref => ref.filePath === '_local.scss'));
    });
    for (const target of ['tokens', 'prefix/#{$file}']) {
      test(`${dialect} ${loader} keeps unresolved ${target} uncertain`, async () => {
        const results = await usageWorkspace([[`theme.${dialect}`, source(target)]]).analyze();
        assert.equal(results.get('only-here').truncated, true);
      });
    }
  }
}

for (const target of ['~prefix/../only-here/image.png', 'prefix/../only-here/image.png',
  'pkg:@scope/prefix/../../only-here/image.png', '~prefix/../@scope/only-here/image.png']) {
  test(`asset package traversal stays uncertain: ${target}`, async () => {
    const name = target.includes('/@scope/only-here') ? '@scope/only-here' : 'only-here';
    const results = await usageWorkspace([['theme.css', `.x { background: url("${target}"); }`]])
      .analyze({ packageNames: ['prefix', name, 'unused'] });
    assert.equal(results.get(name).truncated, true);
    assert.equal(results.get('prefix').references.length, 0);
  });
}

for (const name of ['only-here', '@scope/only-here']) {
  for (const target of ['./linked.png', 'linked.png', './linked.png?v=1#image']) {
    test(`asset ${target} credits canonical package ${name} without reading contents`, async t => {
      const s = await fixture(t, [['theme.css', `.x { background: url("${target}"); }`],
        [`node_modules/${name}/image.png`, Buffer.from([137, 80, 78, 71, 255])]]);
      if (!await symlinkOrSkip(t, `./node_modules/${name}/image.png`, path.join(s.root, 'linked.png'))) return;
      const results = await s.analyze([name, 'unused']);
      assert.ok(results.get(name).references.some(ref => ref.filePath === 'theme.css'));
      assert.equal(results.get('unused').truncated, false);
      assert.deepEqual(s.reads, [path.join(s.root, 'theme.css')]);
      assert.ok(s.stats.some(file => file.endsWith('linked.png') || file.endsWith('image.png')));
    });
  }
}
