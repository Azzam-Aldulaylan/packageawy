import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { scanStylesheet } from '../out/core/usage/styleScan.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { token, usageWorkspace, symlinkOrSkip } from './helpers/usage-coverage.mjs';

const removal = usage => assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status;
async function fixture(t, entries) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-usage4-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of entries) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const reads = [];
  const platform = {
    statFile: stat,
    async readFile(file) { reads.push(path.relative(root, file).split(path.sep).join('/')); return readFile(file); },
    async findFiles(search) {
      return entries.map(([file]) => file).filter(file => file === 'theme.styl' || file === 'theme.less')
        .filter(file => path.matchesGlob(file, search.include)).map(file => path.join(root, file));
    },
  };
  return { root, reads, analyze: () => analyzeDependencyUsage({
    platform, folder: { id: root, name: 'usage-fixture', path: root }, dir: '',
    manifestText: '{}', packageNames: ['only-here', 'unused'], token,
  }) };
}

for (const [file, source] of [
  ['theme.scss', '.x { color: red; }'], ['theme.sass', '.x\n  color: red'],
  ['page.vue', '<style lang="scss">.x { color: red; }</style>'],
  ['page.svelte', '<style lang="sass">.x\n  color: red</style>'],
]) {
  test(`${file} protects implicit node-sass`, async () => {
    const results = await usageWorkspace([[file, source]]).analyze({ packageNames: ['node-sass', 'unused'] });
    assert.ok(results.get('node-sass').references.length > 0);
    assert.notEqual(removal(results.get('node-sass')), 'low-risk');
    assert.equal(removal(results.get('unused')), 'low-risk');
  });
}

for (const dialect of ['scss', 'sass']) {
  for (const loader of ['load', 'meta.load', 'alias.load']) {
    const source = argument => `@use "sass:meta" as ${loader.includes('.') ? loader.split('.')[0] : '*'};\n@include css(${loader}(${argument}));`;
    test(`${dialect} ${loader} retains explicit packages`, async () => {
      const result = await usageWorkspace([[`theme.${dialect}`, source('"pkg:only-here"')]])
        .analyze({ packageNames: ['only-here', 'unused'] });
      assert.ok(result.get('only-here').references.length > 0);
      assert.notEqual(removal(result.get('only-here')), 'low-risk');
      assert.equal(removal(result.get('unused')), 'low-risk');
    });
    test(`${dialect} ${loader} follows local partials`, async () => {
      const result = await usageWorkspace([[`theme.${dialect}`, source('"./local"')],
        ['_local.scss', '@use "pkg:only-here";']], { hidden: ['_local.scss'] }).analyze();
      assert.ok(result.get('only-here').references.some(ref => ref.filePath === '_local.scss'));
    });
    for (const argument of ['"unresolved"', '$file', '"prefix/#{$file}"', '"./prefix/" + $file']) {
      test(`${dialect} ${loader} ${argument} stays uncertain`, async () => {
        const result = (await usageWorkspace([[`theme.${dialect}`, source(argument)]]).analyze()).get('only-here');
        assert.equal(result.truncated, true);
        assert.notEqual(removal(result), 'low-risk');
      });
    }
  }
}

const fileFunctions = [
  ['stylus', 'json', 'tokens.json', '{"brand":"red"}'],
  ['stylus', 'use', 'plugin.js', 'module.exports = () => {};'],
  ['stylus', 'image-size', 'image.png', Buffer.from([0, 255, 0])],
  ...['image-size', 'image-width', 'image-height'].map(name => ['less', name, 'image.png', Buffer.from([0, 255, 0])]),
];
for (const [dialect, loader, filename, content] of fileFunctions) {
  const file = dialect === 'stylus' ? 'theme.styl' : 'theme.less';
  const source = argument => `.x { value: ${loader}(${argument}); }`;
  for (const target of [`only-here/${filename}`, `./node_modules/only-here/${filename}`, `./node_modules/@scope/only-here/${filename}`]) {
    test(`${dialect} ${loader} retains ${target}`, async () => {
      const name = target.includes('@scope') ? '@scope/only-here' : 'only-here';
      const result = await usageWorkspace([[file, source(JSON.stringify(target))],
        [target.replace(/^\.\//, ''), content.toString()]], { hidden: [target.replace(/^\.\//, '')] })
        .analyze({ packageNames: [name, 'unused'] });
      assert.ok(result.get(name).references.some(ref => ref.filePath === file));
      assert.notEqual(removal(result.get(name)), 'low-risk');
    });
  }
  test(`${dialect} ${loader} accepts local files and credits canonical owners`, async t => {
    const s = await fixture(t, [[file, source(`"./linked/${filename}"`)],
      [`node_modules/only-here/${filename}`, content]]);
    if (!await symlinkOrSkip(t, 'node_modules/only-here', path.join(s.root, 'linked'), 'dir')) return;
    const result = await s.analyze();
    assert.ok(result.get('only-here').references.some(ref => ref.filePath === file));
    // Uncertainty is retained for script sources read through symlinks.
    assert.equal(removal(result.get('unused')), loader === 'use' ? 'unknown' : 'low-risk');
    assert.ok(s.reads.includes(`node_modules/only-here/${filename}`));
  });
  for (const argument of ['"./missing"', '"unresolved"', 'file', '"./prefix/" + file', 'pick()', '"./{file}"', '', '""']) {
    test(`${dialect} ${loader}(${argument}) stays uncertain`, async () => {
      const result = (await usageWorkspace([[file, source(argument)]]).analyze()).get('only-here');
      assert.equal(result.truncated, true);
      assert.notEqual(removal(result), 'low-risk');
    });
  }
  test(`${dialect} ${loader} has no false package from comments or strings`, () => {
    const text = `/* ${loader}("fake") */ .x { content: '${loader}("fake")'; value: ${loader}("./${filename}"); }`;
    const scan = scanStylesheet(text, dialect);
    assert.deepEqual(scan.targets.map(item => item.target), [`./${filename}`]);
    const [target] = scan.targets;
    assert.equal(text.slice(target.offset, target.offset + target.target.length), target.target);
  });
}

for (const options of ['', ', { hash: true, optional: true }']) {
  test(`local Stylus JSON${options} is data, not script or stylesheet`, async t => {
    const s = await fixture(t, [['theme.styl', `tokens = json("./tokens.json"${options})`],
      ['tokens.json', JSON.stringify({ text: 'require("only-here")' })]]);
    const result = await s.analyze();
    assert.equal(result.get('only-here').references.length, 0);
    assert.equal(removal(result.get('unused')), 'low-risk');
    assert.deepEqual(s.reads, ['theme.styl', 'tokens.json']);
  });
}

for (const extension of ['js', 'cjs', 'mjs']) {
  test(`Stylus local ${extension} plugin is followed as script`, async t => {
    const s = await fixture(t, [['theme.styl', `use("./plugins/local.${extension}")`],
      [`plugins/local.${extension}`, 'const dependency = require("only-here"); module.exports = () => dependency;']]);
    const result = await s.analyze();
    assert.ok(result.get('only-here').references.some(ref => ref.filePath === `plugins/local.${extension}`));
    assert.equal(removal(result.get('unused')), 'low-risk');
    assert.ok(s.reads.includes(`plugins/local.${extension}`));
  });
}

for (const options of ['', '("option") ', '(foo, (bar)) ']) {
  test(`Less @plugin ${options}follows local plugin scripts`, async t => {
    const s = await fixture(t, [['theme.less', `@plugin ${options}"./plugins/local";`],
      ['plugins/local.js', 'const dependency = require("only-here"); module.exports = dependency;']]);
    const result = await s.analyze();
    assert.ok(result.get('only-here').references.some(ref => ref.filePath === 'plugins/local.js'));
    assert.equal(removal(result.get('unused')), 'low-risk');
  });
  test(`Less @plugin ${options}retains packages`, async () => {
    const result = (await usageWorkspace([['theme.less', `@plugin ${options}"only-here";`]]).analyze()).get('only-here');
    assert.ok(result.references.length > 0);
  });
}

for (const source of ['@plugin (options) @file;', '@plugin (options) "./missing.js";']) {
  test(`unresolved Less plugin stays uncertain: ${source}`, async () => {
    const result = (await usageWorkspace([['theme.less', source]]).analyze()).get('only-here');
    assert.equal(result.truncated, true);
  });
}

test('Stylus @require already follows local styles and retains packages', async () => {
  const result = await usageWorkspace([['theme.styl', '@require "./local"'],
    ['local.styl', '@require "~only-here/theme"']], { hidden: ['local.styl'] })
    .analyze({ packageNames: ['only-here', 'unused'] });
  assert.ok(result.get('only-here').references.some(ref => ref.filePath === 'local.styl'));
  assert.equal(removal(result.get('unused')), 'low-risk');
});

test('nested loaders in Stylus options are also checked', async t => {
  const s = await fixture(t, [['theme.styl', 'json("./tokens.json", { hash: true, plugin: use("./plugin.js") })'],
    ['tokens.json', '{}'], ['plugin.js', 'module.exports = require("only-here");']]);
  const result = await s.analyze();
  assert.ok(result.get('only-here').references.some(ref => ref.filePath === 'plugin.js'));
  assert.equal(removal(result.get('unused')), 'low-risk');
});

for (const [dialect, loader, filename, content] of fileFunctions) {
  const file = dialect === 'stylus' ? 'theme.styl' : 'theme.less';
  test(`${dialect} ${loader} does not accept an expression with a quoted comma`, async t => {
    const s = await fixture(t, [[file, `.x { value: ${loader}("./${filename}" ","); }`], [filename, content]]);
    assert.equal((await s.analyze()).get('only-here').truncated, true);
  });
  test(`${dialect} ${loader} cannot follow a symlink outside the project`, async t => {
    const s = await fixture(t, [[file, `.x { value: ${loader}("./linked/${filename}"); }`]]);
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-usage4-outside-')));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, filename), content);
    if (!await symlinkOrSkip(t, outside, path.join(s.root, 'linked'), 'dir')) return;
    const result = await s.analyze();
    assert.equal(result.get('only-here').truncated, true);
    assert.notEqual(removal(result.get('only-here')), 'low-risk');
    assert.deepEqual(s.reads, [file]);
  });
  test(`${dialect} ${loader} unresolved node_modules target retains ownership and uncertainty`, async () => {
    const result = (await usageWorkspace([[file, `.x { value: ${loader}("./node_modules/only-here/${filename}"); }`]])
      .analyze()).get('only-here');
    assert.ok(result.references.length > 0);
    assert.equal(result.truncated, true);
  });
}

test('unsupported local Stylus plugin types keep uncertainty', async t => {
  const s = await fixture(t, [['theme.styl', 'use("./plugin.node")'], ['plugin.node', 'binary']]);
  assert.equal((await s.analyze()).get('only-here').truncated, true);
});

test('local Stylus plugin computed imports keep uncertainty', async t => {
  const s = await fixture(t, [['theme.styl', 'use("./plugin.js")'], ['plugin.js', 'module.exports = require(name);']]);
  assert.equal((await s.analyze()).get('only-here').truncated, true);
});

for (const [dialect, loader, filename] of fileFunctions.filter(([, loader]) => loader !== 'use')) {
  const file = dialect === 'stylus' ? 'theme.styl' : 'theme.less';
  test(`${dialect} ${loader} cannot accept a directory as proof of a local file`, async t => {
    const s = await fixture(t, [[file, `.x { value: ${loader}("./${filename}"); }`]]);
    await mkdir(path.join(s.root, filename));
    assert.equal((await s.analyze()).get('only-here').truncated, true);
  });
}
