import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { folder, token, symlinkOrSkip } from './helpers/usage-coverage.mjs';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { UsageAnalysisState } from '../out/host/usage/usageAnalysisState.js';
import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { buildUnusedFinding } from '../out/core/usage/unused.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const status = usage => assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status;

for (const [file, text, packages] of [
  ['theme.scss', '.x { color: red }', ['sass', 'sass-embedded']],
  ['theme.sass', '.x\n  color: red', ['sass', 'sass-embedded']],
  ['theme.less', '.x { color: red }', ['less']],
  ['theme.styl', '.x\n  color red', ['stylus']],
  ['page.vue', '<style lang="scss">.x { color: red }</style>', ['sass', 'sass-embedded']],
  ['page.svelte', '<style lang="sass">.x\n  color: red</style>', ['sass', 'sass-embedded']],
  ['page.vue', '<style lang="less">.x { color: red }</style>', ['less']],
  ['page.svelte', '<style lang="stylus">.x\n  color red</style>', ['stylus']],
]) {
  test(`implicit preprocessor for ${file} ${packages.join('/')} is protected`, async () => {
    const results = await usageWorkspace([[file, text]]).analyze({ packageNames: [...packages, 'unused'] });
    for (const name of packages) {
      assert.notEqual(status(results.get(name)), 'low-risk');
      assert.notEqual(buildUnusedFinding(name, results.get(name))?.confidence, 'high');
    }
    assert.equal(status(results.get('unused')), 'low-risk');
  });
}

async function keptAndRemovable(entries, name = 'only-here', options = {}) {
  const workspace = usageWorkspace(entries, options);
  const results = await workspace.analyze({ packageNames: [name, 'unused'] });
  assert.ok(results.get(name).references.length > 0, 'stylesheet-only package must have references');
  assert.equal(buildUnusedFinding(name, results.get(name)), null);
  assert.equal(status(results.get(name)), 'review');
  assert.equal(results.get('unused').truncated, false);
  assert.equal(status(results.get('unused')), 'low-risk');
  return { workspace, results };
}

for (const [label, file, text, name] of [
  ['Tailwind v3 globals', 'app/globals.css', '@import "tailwindcss/base";\n@import "tailwindcss/components";\n@import "tailwindcss/utilities";', 'tailwindcss'],
  ['Tailwind v4 globals', 'app/globals.css', '@import "tailwindcss";', 'tailwindcss'],
  ['Sass forward', 'theme.scss', '@forward "pkg:only-here/theme";', 'only-here'],
  ['Sass tilde', 'theme.scss', '@use "~only-here/theme";', 'only-here'],
  ['scoped Sass', 'theme.scss', '@use "pkg:@scope/theme/styles";', '@scope/theme'],
  ['CSS url import with suffixes', 'theme.css', '@import url("only-here/theme.css") layer(base) supports(display: grid) screen and (min-width: 20px);', 'only-here'],
  ['unquoted package asset', 'theme.css', '.x { background: url(only-here/image.png) }', 'only-here'],
  ['bare package asset', 'theme.css', '.x { background: url("only-here") }', 'only-here'],
  ['tilde package asset', 'theme.scss', '.x { background: url("~only-here/image.png") }', 'only-here'],
  ['pkg protocol asset', 'theme.scss', '.x { background: url("pkg:only-here/image.png") }', 'only-here'],
  ['scoped package asset', 'theme.css', '.x { src: url(@scope/font/font.woff2) }', '@scope/font'],
  ['relative node_modules asset', 'theme.css', '.x { src: url("../node_modules/some-pkg/x.woff2") }', 'some-pkg'],
  ['root-relative scoped node_modules asset', 'theme.css', '.x { background: url("/node_modules/@scope/pkg/x.png") }', '@scope/pkg'],
  ['CSS modules composes', 'theme.module.css', '.x { composes: base from "only-here/theme.css"; }', 'only-here'],
  ['CSS modules value', 'theme.module.css', '@value accent from "only-here/theme.css";', 'only-here'],
  ['ICSS', 'theme.css', ':import("only-here/theme.css") { x: y; }', 'only-here'],
  ['Less options', 'theme.less', '@import (reference, less) "~only-here/theme";', 'only-here'],
  ['Stylus require', 'theme.styl', '@require "~only-here/theme"\n.x\n  color red', 'only-here'],
  ['Stylus unquoted import', 'theme.styl', '@import ~only-here/theme', 'only-here'],
  ['Tailwind plugin', 'theme.css', '@plugin "only-here" { strategy: class; }', 'only-here'],
  ['Tailwind config', 'theme.css', '@config "only-here/config";', 'only-here'],
  ['Tailwind reference', 'theme.css', '@reference "only-here";', 'only-here'],
  ['Tailwind source package', 'theme.css', '@source "only-here/templates";', 'only-here'],
  ['Vue style src', 'page.vue', '<style src="only-here/styles.css"></style>', 'only-here'],
  ['Svelte style src', 'page.svelte', '<style src="~only-here/styles.css"></style>', 'only-here'],
  ['Sass meta load', 'theme.scss', '@use "sass:meta" as m; @include m.load-css("pkg:only-here/theme");', 'only-here'],
  ['escaped package string', 'theme.css', '@import "only\\2d here/styles.css";', 'only-here'],
  ['escaped quote in subpath', 'theme.css', '@import "only-here/it\\\'s.css";', 'only-here'],
]) {
  test(`${label} retains its CSS dependency and permits an unrelated removal`, async () => {
    await keptAndRemovable([[file, text]], name);
  });
}

for (const [target, content] of [
  ['./missing.png', undefined],
  ['./unreadable.png', null],
  ['./binary.woff2', '\0\xff\0\xff'],
  ['./large.png', 'x'.repeat(2 * 1024 * 1024 + 1)],
  ['./asset.css', '@import "only-here";'],
  ['../missing.png', undefined],
  ['/missing.png', undefined],
  ['only-here/asset.css', '@import "second";'],
  ['./node_modules/only-here/asset.css', '@import "second";'],
]) {
  test(`static asset url(${target}) never reads asset contents`, async () => {
    const file = path.posix.normalize(target);
    const workspace = usageWorkspace([
      ['theme.css', `.x { background: url("${target}"); }`],
      ...(content === undefined ? [] : [[file, content]]),
    ], { hidden: [file] });
    const stats = [];
    const originalStat = workspace.platform.statFile;
    workspace.platform.statFile = async absolutePath => {
      stats.push(path.relative(folder.path, absolutePath).split(path.sep).join('/'));
      return originalStat(absolutePath);
    };
    const results = await workspace.analyze({ packageNames: ['only-here', 'second', 'unused'] });
    assert.deepEqual(workspace.reads, ['theme.css']);
    assert.deepEqual(stats, ['theme.css', ...(target.startsWith('/') ? [file.slice(1), 'public/' + file.slice(1)] : [file])]);
    for (const usage of results.values()) {
      assert.equal(usage.truncated, false);
      assert.equal(usage.coverageReasons, undefined);
    }
    assert.equal(results.get('only-here').references.length, target.includes('only-here') ? 1 : 0);
    assert.equal(results.get('second').references.length, 0);
    assert.equal(status(results.get('unused')), 'low-risk');
  });
}

test('a missing CSS url import still blocks removals', async () => {
  const result = (await usageWorkspace([['theme.css', '@import url("./missing.css");']]).analyze()).get('only-here');
  assert.equal(result.truncated, true);
  assert.equal(status(result), 'unknown');
  assert.deepEqual(result.coverageReasons, ['@import target in theme.css that could not be read']);
});

test('multiple Sass import targets each retain their own package', async () => {
  const { results } = await keptAndRemovable([['theme.scss', '@import "pkg:only-here/a", "~second/b";']], 'only-here');
  assert.equal(results.get('unused').truncated, false);
  const result = (await usageWorkspace([['theme.scss', '@import "pkg:only-here/a", "~second/b";']]).analyze({ packageNames: ['second'] })).get('second');
  assert.equal(result.references.length, 1);
});

for (const component of ['vue', 'svelte']) {
  test(`${component} style dependencies retain original file and line coordinates`, async () => {
    const { results } = await keptAndRemovable([[`page.${component}`, '<template>hello</template>\n<style>\n@import "only-here/styles";\n</style>']]);
    const reference = results.get('only-here').references[0];
    assert.equal(reference.filePath, `page.${component}`);
    assert.equal(reference.line, 3);
    assert.equal(reference.column, 10);
    assert.equal(reference.snippet, '@import "only-here/styles";');
  });
}

for (const [target, file, imported] of [
  ['./hidden.css', 'hidden.css', '@import "only-here";'],
  ['./palette', '_palette.scss', '@forward "pkg:only-here";'],
  ['palette', '_palette.scss', '@use "pkg:only-here";'],
  ['./palette.scss', '_palette.scss', '@use "pkg:only-here";'],
  ['./tokens', 'tokens/index.scss', '@use "pkg:only-here";'],
  ['./tokens', 'tokens/_index.scss', '@use "pkg:only-here";'],
  ['./tokens', 'tokens/_index.sass', '@use "pkg:only-here"'],
  ['./node_modules/only-here/index.css', 'node_modules/only-here/index.css', '@import "second";'],
  ['./.hidden/base.css', '.hidden/base.css', '@import "only-here";'],
]) {
  test(`relative or local stylesheet ${target} is read through ${file}`, async () => {
    const { workspace } = await keptAndRemovable([['theme.scss', `@use "${target}";`], [file, imported]], 'only-here', { hidden: [file] });
    assert.ok(workspace.reads.includes(file));
  });
}

for (const component of ['vue', 'svelte']) {
  test(`${component} local style src is followed outside discovery`, async () => {
    await keptAndRemovable([[`page.${component}`, '<style src="./hidden.css"></style>'], ['hidden.css', '@import "only-here";']], 'only-here', { hidden: ['hidden.css'] });
  });
}

for (const directive of ['config', 'plugin']) {
  test(`Tailwind local @${directive} is read and its imports are scanned`, async () => {
    await keptAndRemovable([['theme.css', `@${directive} "./hidden.cjs";`], ['hidden.cjs', 'module.exports = require("only-here");']], 'only-here', { hidden: ['hidden.cjs'] });
  });
}

test('local stylesheet cycles terminate without losing package references', async () => {
  await keptAndRemovable([['a.css', '@import "./b.css";'], ['b.css', '@import "./a.css"; @import "only-here";']]);
});

for (const [file, text] of [
  ['theme.scss', '@use "variables";'],
  ['theme.scss', '@forward "tokens/colors";'],
  ['theme.scss', '@import "variables", "colors";'],
  ['theme.scss', '@use "@scope/variables";'],
  ['theme.css', '@import "./missing.css";'],
  ['theme.css', '@import "../outside.css";'],
  ['theme.css', '@import "#{$name}";'],
  ['theme.scss', '@use $name;'],
  ['theme.less', '@import "@{name}/theme";'],
  ['theme.css', '.x { background: url(var(--asset)); }'],
  ['page.vue', '<style src="./missing.css"></style>'],
  ['page.svelte', '<style lang="unknown">@import "only-here";</style>'],
  ['theme.css', '@import;'],
]) {
  test(`unresolved ${file} ${text} blocks every zero-reference package with an explanation`, async () => {
    const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'unused'] });
    for (const usage of results.values()) {
      assert.equal(usage.truncated, true);
      assert.equal(status(usage), 'unknown');
      assert.ok(usage.coverageReasons.some(reason => reason.includes(file)));
      assert.equal(buildUnusedFinding(usage.packageName, usage).confidence, 'low');
      assert.ok(usage.coverageReasons.every(reason => !/[\u2013\u2014;→]/.test(reason)));
    }
  });
}

for (const [file, text, name] of [
  ['theme.css', '@import "only-here/${variant}.css";', 'only-here'],
  ['theme.scss', '@use "pkg:only-here/#{$variant}";', 'only-here'],
  ['theme.less', '.x { background: url("~only-here/@{asset}"); }', 'only-here'],
  ['theme.css', '@reference "@scope/theme/${variant}.css";', '@scope/theme'],
]) {
  test(`unproven expression ${text} keeps project-wide uncertainty`, async () => {
    const results = await usageWorkspace([[file, text]]).analyze({ packageNames: [name, 'unused'] });
    assert.equal(status(results.get(name)), 'unknown');
    assert.equal(results.get(name).truncated, true);
    assert.equal(buildUnusedFinding(name, results.get(name)).confidence, 'low');
    assert.equal(status(results.get('unused')), 'unknown');
    assert.equal(results.get('unused').truncated, true);
    assert.ok(results.get('unused').coverageReasons.length);
  });
}

for (const [file, text] of [
  ['theme.css', '/* @import "fake"; url(fake/a) */ .x { content: "@import fake"; }'],
  ['theme.scss', '// @forward "fake";\n.x { content: "url(fake/a)"; }'],
  ['theme.scss', '@use "sass:math"; @use "sass:meta";'],
  ['theme.css', '@import url(https://example.com/style.css) screen; @import "//example.com/style.css";'],
  ['theme.css', '.x { background: url(data:image/svg+xml;base64,abc); mask: url(#filter); }'],
  ['theme.css', '@source inline("url(fake/a) @import fake"); @source not inline("fake");'],
  ['theme.module.css', '.x { composes: button from global; }'],
]) {
  test(`nonpackage syntax in ${file} does not block removals`, async () => {
    const usage = (await usageWorkspace([[file, text]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 0);
    assert.equal(usage.truncated, false);
    assert.equal(status(usage), 'low-risk');
  });
}

for (const target of ['../node_modules/only-here', '../node_modules/only-here/**/*.tsx']) {
  test(`Tailwind source directory ${target} retains the package`, async () => {
    await keptAndRemovable([['styles/theme.css', `@source "${target}";`]]);
  });
}

test('an existing bare CSS filename is read before treating it as a package', async () => {
  await keptAndRemovable([['theme.css', '@import "hidden.css";'], ['hidden.css', '@import "only-here";']], 'only-here', { hidden: ['hidden.css'] });
});

for (const target of ['https://example.com/theme.css', '//example.com/theme.css']) {
  test(`Sass remote url(${target}) needs no package coverage`, async () => {
    const usage = (await usageWorkspace([['theme.scss', `@import url(${target});`]]).analyze()).get('only-here');
    assert.equal(usage.truncated, false);
  });
}

for (const text of ['@plugin var(--module);', '@import "prefix" + $name;', '@import "./missing.css";']) {
  test(`computed or missing target ${text} cannot imply complete coverage`, async () => {
    const usage = (await usageWorkspace([['theme.css', text]]).analyze()).get('only-here');
    assert.equal(usage.truncated, true);
    assert.equal(status(usage), 'unknown');
  });
}

test('an unreadable exact stylesheet target cannot be replaced by a readable fallback', async () => {
  const workspace = usageWorkspace([
    ['theme.scss', '@use "./tokens";'], ['tokens.scss', null], ['_tokens.scss', '@use "pkg:only-here";'],
  ], { hidden: ['tokens.scss', '_tokens.scss'] });
  const result = (await workspace.analyze()).get('only-here');
  assert.equal(result.truncated, true);
  assert.equal(status(result), 'unknown');
  assert.ok(result.coverageReasons.some(reason => reason.includes('@use target in theme.scss')));
});

async function nativeStyles(t, entries) {
  const base = await mkdtemp(path.resolve('out/style-native-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await mkdir(root);
  for (const [file, text] of entries) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const workspaceFolder = { ...folder, path: root };
  const workspace = usageWorkspace(entries, { workspaceFolder });
  const reads = [];
  const platform = { ...workspace.platform, statFile: stat, async readFile(file) { reads.push(file); return readFile(file); } };
  return { root, base, reads, analyze: (overrides = {}) => analyzeDependencyUsage({
    platform, folder: workspaceFolder, dir: '', manifestText: '{}', packageNames: ['only-here', 'unused'], token,
    ...overrides,
  }) };
}

for (const assetsExist of [true, false]) {
  test(`Next.js public asset URLs permit removal with public/fonts ${assetsExist ? 'present' : 'missing'}`, async t => {
    const manifestText = JSON.stringify({ dependencies: { next: '15.0.0', tailwindcss: '3.4.0', unused: '1.0.0' } });
    const fixture = await nativeStyles(t, [
      ['package.json', manifestText],
      ['src/app/layout.tsx', 'import "./globals.css"; export default function Layout({ children }) { return <html><body>{children}</body></html>; }'],
      ['src/app/globals.css', '@import "tailwindcss/base";\n@font-face {\n  src: url("/fonts/FrutigerLTArabic-55Roman.ttf") format("truetype");\n}\nbody {\n  cursor: url("/images/icons8-incoming-mail-67.png"), pointer;\n}'],
      ...(assetsExist ? [
        ['public/fonts/FrutigerLTArabic-55Roman.ttf', Buffer.from([0, 1, 0, 0, 255])],
        ['public/images/icons8-incoming-mail-67.png', Buffer.from([137, 80, 78, 71, 0, 255])],
      ] : []),
    ]);
    const results = await fixture.analyze({ manifestText, packageNames: ['next', 'tailwindcss', 'unused'] });
    for (const usage of results.values()) {
      assert.equal(usage.truncated, false);
      assert.equal(usage.coverageReasons, undefined);
    }
    assert.ok(results.get('tailwindcss').references.some(reference =>
      reference.filePath === 'src/app/globals.css' && reference.snippet === '@import "tailwindcss/base";'));
    assert.equal(status(results.get('tailwindcss')), 'review');
    assert.equal(status(results.get('unused')), 'low-risk');
    assert.ok(fixture.reads.every(file => !/\.(ttf|png)$/.test(file)));
  });
}

test('native Sass resolution follows a real directory index', async t => {
  const fixture = await nativeStyles(t, [['theme.scss', '@use "./palette";'], ['palette/_index.scss', '@forward "pkg:only-here";']]);
  const results = await fixture.analyze();
  assert.equal(status(results.get('only-here')), 'review');
  assert.equal(status(results.get('unused')), 'low-risk');
  assert.ok(fixture.reads.some(file => file.endsWith('_index.scss')));
});

test('native symlink stylesheet cycles use canonical file identities', async t => {
  const fixture = await nativeStyles(t, [['theme.css', '@import "./link/theme.css"; @import "only-here";']]);
  if (!await symlinkOrSkip(t, fixture.root, path.join(fixture.root, 'link'), 'dir')) return;
  const results = await fixture.analyze();
  assert.equal(status(results.get('only-here')), 'review');
  assert.equal(status(results.get('unused')), 'low-risk');
  assert.ok(fixture.reads.length < 10);
});

test('a relative style symlink outside the project is uncertain and never read', async t => {
  const fixture = await nativeStyles(t, [['theme.css', '@import "./escape.css";']]);
  const external = path.join(fixture.base, 'external.css');
  await writeFile(external, '@import "only-here";');
  if (!await symlinkOrSkip(t, external, path.join(fixture.root, 'escape.css'))) return;
  const results = await fixture.analyze();
  assert.equal(status(results.get('only-here')), 'unknown');
  assert.equal(status(results.get('unused')), 'unknown');
  assert.ok(!fixture.reads.includes(external));
});

test('VS Code missing-file errors do not turn static package imports into unread local files', async () => {
  const workspace = usageWorkspace([['theme.css', '@import "only-here";']]);
  const originalStat = workspace.platform.statFile;
  workspace.platform.statFile = async file => {
    try { return await originalStat(file); }
    catch { throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); }
  };
  const results = await workspace.analyze({ packageNames: ['only-here', 'unused'] });
  assert.equal(status(results.get('only-here')), 'review');
  assert.equal(status(results.get('unused')), 'low-risk');
});


test('project-wide stylesheet uncertainty cannot be reused as complete removal evidence', async () => {
  const results = await usageWorkspace([['theme.css', '@import "only-here/${variant}.css";']])
    .analyze({ packageNames: ['only-here', 'unused'] });
  const state = new UsageAnalysisState(60_000);
  const identity = state.identity('project', computeSourceFingerprint({ manifestText: '{}', lockfileText: null, lockfilePath: null }));
  for (const [name, result] of results) state.set('project', name, identity, result);
  assert.equal(state.getComplete('project', ['only-here'], identity), undefined);
  assert.equal(state.getComplete('project', ['unused'], identity), undefined);
});

test('a package prefix followed by traversal cannot bound an interpolated target', async () => {
  const results = await usageWorkspace([['theme.scss', '@use "~only-here/../other/#{$file}";']])
    .analyze({ packageNames: ['only-here', 'unused'] });
  assert.equal(status(results.get('only-here')), 'unknown');
  assert.equal(status(results.get('unused')), 'unknown');
});

test('a static Tailwind package source glob records a reference', async () => {
  await keptAndRemovable([['theme.css', '@source "only-here/**/*.tsx";']]);
});

test('a fragment import url has no package dependencies', async () => {
  const result = (await usageWorkspace([['theme.css', '@import url(#fragment);']]).analyze()).get('only-here');
  assert.equal(result.truncated, false);
});

for (const text of ['@use "tokens.css";', '@forward "tokens.css";', '@use "sass:meta"; @include meta.load-css("tokens");']) {
  test(`Sass module target ${text} stays uncertain without a known load path`, async () => {
    const results = await usageWorkspace([['theme.scss', text]]).analyze({ packageNames: ['only-here', 'unused'] });
    assert.equal(status(results.get('only-here')), 'unknown');
    assert.equal(status(results.get('unused')), 'unknown');
  });
}

test('a computed bare CSS target under an existing local directory is project-wide uncertainty', async t => {
  const fixture = await nativeStyles(t, [['theme.css', '@import "themes/${variant}.css";'], ['themes/dark.css', '@import "only-here";']]);
  const results = await fixture.analyze();
  assert.equal(results.get('unused').truncated, true);
  assert.equal(status(results.get('unused')), 'unknown');
});

test('interpolation under a Tailwind node_modules source affects its named package', async () => {
  const results = await usageWorkspace([['theme.css', '@source "./node_modules/only-here/${variant}";']])
    .analyze({ packageNames: ['only-here', 'unused'] });
  assert.equal(status(results.get('only-here')), 'unknown');
  assert.equal(status(results.get('unused')), 'low-risk');
});

for (const [file, text] of [
  ['theme.css', '\n.x { background: url("only-here/image.png"); }'],
  ['page.vue', '<template>hello</template>\n<style scoped src="only-here/styles.css"></style>'],
]) {
  test(`stylesheet reference coordinates point at the target in ${file}`, async () => {
    const { results } = await keptAndRemovable([[file, text]]);
    const reference = results.get('only-here').references[0];
    assert.equal(reference.line, 2);
    assert.equal(reference.column, text.split('\n')[1].indexOf('only-here') + 1);
  });
}

for (const [file, text] of [
  ['theme.less', '@import @theme/styles;'],
  ['theme.less', '.x { background: url(@theme/image); }'],
  ['theme.styl', 'theme = "only-here/styles"\n@require theme'],
  ['theme.styl', 'asset = "only-here/image"\n.x\n  background url(asset)'],
]) {
  test(`unquoted preprocessor variables in ${file} cannot imply complete package coverage`, async () => {
    const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'unused'] });
    assert.equal(status(results.get('only-here')), 'unknown');
    assert.equal(status(results.get('unused')), 'unknown');
  });
}

test('a same-named local file cannot hide a static package target from cleanup', async () => {
  await keptAndRemovable([['theme.css', '@plugin "only-here";'], ['only-here.js', 'module.exports = {};']]);
});
