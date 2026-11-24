import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, rm } from 'node:fs/promises';
import { hasUnreadTemplateImports, scanSourceForImports } from '../out/core/usage/importScan.js';
import { scanStylesheet } from '../out/core/usage/styleScan.js';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { usageWorkspace, token, symlinkOrSkip } from './helpers/usage-coverage.mjs';

async function diskWorkspace(t, entries) {
  const root = await mkdtemp(path.join(tmpdir(), 'packageawy-local-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of entries) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const folder = { id: root, name: 'workspace', path: root };
  const platform = {
    statFile: stat, readFile,
    async findFiles(search) {
      const files = [];
      async function visit(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          const relative = path.relative(path.join(root, search.dir), absolute);
          if (search.exclude && path.matchesGlob(relative, search.exclude)) continue;
          if (entry.isDirectory()) await visit(absolute);
          else if (entry.isFile() && path.matchesGlob(relative, search.include)) files.push(absolute);
        }
      }
      await visit(path.join(root, search.dir));
      return files.slice(0, search.maxResults);
    },
  };
  return { root, platform, folder,
    analyze: overrides => analyzeDependencyUsage({ platform, folder, dir: '', manifestText: '{}', packageNames: ['only-here'], token, ...overrides }),
    compatibility: () => collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' }),
  };
}

for (const call of ['require.context("./build", true, /\\.js$/)', 'import.meta.glob("./build/**/*.js")']) {
  test(`excluded bulk directory cannot prove coverage: ${call}`, async t => {
    const s = await diskWorkspace(t, [['index.js', call], ['build/a.js', 'require("only-here")']]);
    assert.equal((await s.analyze()).get('only-here').truncated, true);
    assert.ok((await s.compatibility()).scanLimitations.includes('project-source-import-scan-incomplete'));
  });
}
for (const call of ['require.context("./linked", true, /\\.js$/)', 'import.meta.glob("./linked/**/*.js")']) {
  test(`canonical bulk directory cannot escape through symlinks: ${call}`, async t => {
    const s = await diskWorkspace(t, [['index.js', call]]);
    const external = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
    t.after(() => rm(external, { recursive: true, force: true }));
    await writeFile(path.join(external, 'a.js'), 'require("only-here")');
    if (!await symlinkOrSkip(t, external, path.join(s.root, 'linked'), 'dir')) return;
    assert.equal((await s.analyze()).get('only-here').truncated, true);
  });
}

test('an uncovered extension and file cap keep local bulk coverage uncertain', async t => {
  const s = await diskWorkspace(t, [['index.js', 'require.context("./local")'], ['local/a.unknown', 'require("only-here")']]);
  assert.equal((await s.analyze()).get('only-here').truncated, true);
  assert.equal((await s.analyze({ maxFiles: 1 })).get('only-here').truncated, true);
});

for (const [file, source] of [
  ['theme.less', '@part: "../only-here/theme"; @import "prefix/@{part}";'],
  ['theme.scss', '$part: "../only-here/theme"; @use "pkg:prefix/#{$part}";'],
  ['theme.styl', 'part = "../only-here/theme"\n@import "prefix/{part}"'],
]) {
  test(`interpolation can escape a package prefix in ${file}`, async () => {
    const usage = (await usageWorkspace([[file, source]]).analyze()).get('only-here');
    assert.equal(usage.truncated, true);
    assert.ok(usage.coverageReasons.length);
  });
}
for (const file of ['theme.less', 'theme.styl']) {
  test(`unresolved bare include paths in ${file} block all packages and retain plausible package usage`, async () => {
    const results = await usageWorkspace([[file, '@import "tokens";']]).analyze({ packageNames: ['tokens', 'only-here'] });
    assert.equal(results.get('only-here').truncated, true);
    assert.equal(results.get('tokens').references.length, 1);
  });
}
for (const extension of ['scss', 'sass']) {
  for (const partial of ['_tokens', 'tokens']) {
    test(`Sass import-only ${partial}.import.${extension} wins for import only`, async () => {
      const entries = [['theme.scss', '@import "./vendor/tokens";'],
        ['vendor/_tokens.scss', '.x { color: red; }'],
        [`vendor/${partial}.import.${extension}`, '@import "pkg:only-here";']];
      const usage = (await usageWorkspace(entries, { hidden: entries.slice(1).map(([file]) => file) }).analyze()).get('only-here');
      assert.equal(usage.references.length, 1);
      assert.equal(usage.truncated, false);
      entries[0][1] = '@use "./vendor/tokens";';
      const use = (await usageWorkspace(entries, { hidden: entries.slice(1).map(([file]) => file) }).analyze()).get('only-here');
      assert.equal(use.references.length, 0);
      assert.equal(use.truncated, false);
    });
  }
}
for (const pair of [['_tokens.scss', 'tokens.scss'], ['_tokens.scss', '_tokens.sass'], ['_tokens.import.scss', 'tokens.import.scss'], ['_index.import.scss', 'index.import.sass']]) {
  test(`ambiguous Sass candidates stay uncertain: ${pair.join(', ')}`, async () => {
    const base = pair[0].includes('index') ? 'vendor/tokens/' : 'vendor/';
    const entries = [['theme.scss', '@import "./vendor/tokens";'], ...pair.map(file => [base + file, '.x {}'])];
    assert.equal((await usageWorkspace(entries, { hidden: entries.slice(1).map(([file]) => file) }).analyze()).get('only-here').truncated, true);
  });
}

test('large semicolonless Stylus composes scans in linear time', () => {
  const text = '.x\n' + '  composes: item\n'.repeat(16000);
  const start = performance.now();
  const scan = scanStylesheet(text, 'stylus');
  assert.ok(performance.now() - start < 2000, '16,000 declarations must scan within 2 seconds');
  assert.deepEqual(scan.targets, []);
  assert.deepEqual(scanStylesheet('composes: x from "only-here/theme"', 'stylus').targets.map(target => target.target), ['only-here/theme']);
});

for (const clause of ['export { projects };', 'export type { ProtocolError };', 'export { projects }\n', 'export { from as projects };']) {
  test(`local export ends before a following import: ${clause}`, () => {
    const text = `const projects = 1;\n${clause}\nimport x from "y";`;
    assert.equal(hasUnreadTemplateImports(text, 'index.ts'), false);
    assert.deepEqual(scanSourceForImports(text, 'index.ts').map(match => match.packageName), ['y']);
  });
}
test('export-clause fix retains real reexports and unread truncated clauses', () => {
  assert.deepEqual(scanSourceForImports('export { a } from "real";').map(match => match.packageName), ['real']);
  for (const text of ['export { a', 'export { a } from', 'export { a } unexpected from variable']) {
    assert.equal(hasUnreadTemplateImports(text, 'index.ts'), true, text);
  }
});

for (const loader of ['import', 'require']) {
  test(`relative next-intl template ${loader} with covered JSON stays uncertain`, async t => {
    const s = await diskWorkspace(t, [['src/i18n/request.ts', `const messages = (await ${loader}(\`../../messages/\${locale}.json\`)).default;`], ['messages/en.json', '{"hello":"Hello"}']]);
    assert.equal((await s.analyze()).get('only-here').truncated, true);
    assert.equal((await s.compatibility()).truncated, true);
  });
}
for (const target of ['../../messages/${locale}.js', '../../build/${locale}.js', '../../../outside/${locale}.json', '../../messages/${locale}/../x.json', '../../node_modules/${locale}.json']) {
  test(`template targets require containment and actual scan coverage: ${target}`, async t => {
    const s = await diskWorkspace(t, [['src/i18n/request.ts', `import(\`${target}\`)`], ['messages/en.js', 'require("only-here")'], ['build/en.js', 'require("only-here")']]);
    // A discovered use can coexist with incomplete coverage.
    const usage = (await s.analyze({ maxFiles: target.includes('/messages/${locale}.js') ? 1 : 6000 })).get('only-here');
    assert.equal(usage.truncated, true);
  });
}
test('a local template must not hide executable interpolation', async t => {
  const s = await diskWorkspace(t, [['index.js', 'import(`./messages/${require("only-here")}.json`)'], ['messages/en.json', '{}']]);
  assert.equal((await s.analyze()).get('only-here').references.length, 1);
});


test('a from clause beyond the bounded export window stays unread', () => {
  const text = 'export { a }' + ' '.repeat(4096) + 'from "real";';
  assert.equal(hasUnreadTemplateImports(text, 'index.ts'), true);
});

for (const [call, complete] of [
  ['require.context("./local", true, /\\.js$/)', true],
  ['import.meta.glob("./local/**/*.js")', true],
  ['import(`./local/${name}.js`)', false],
]) {
  test(`local directory proof only covers static bulk loaders: ${call}`, async t => {
    const s = await diskWorkspace(t, [['index.js', call], ['local/a.js', 'require("only-here")']]);
    const usage = (await s.analyze()).get('only-here');
    assert.equal(usage.truncated, !complete);
    assert.equal(usage.references.length, 1);
    assert.equal((await s.compatibility()).truncated, !complete);
  });
}

test('an external symlink nested under a local glob prefix keeps uncertainty', async t => {
  const s = await diskWorkspace(t, [['index.js', 'import.meta.glob("./local/**/*.js")'], ['local/a.js', 'const x = 1;']]);
  const external = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'b.js'), 'require("only-here")');
  if (!await symlinkOrSkip(t, external, path.join(s.root, 'local/escape'), 'dir')) return;
  assert.equal((await s.analyze()).get('only-here').truncated, true);
});

for (const content of ['not JSON', '"' + 'x'.repeat(2 * 1024 * 1024) + '"']) {
  test(`JSON proof rejects ${content.length > 100 ? 'oversized' : 'invalid'} data`, async t => {
    const s = await diskWorkspace(t, [['index.js', 'import(`./messages/${locale}.json`)'], ['messages/en.json', content]]);
    assert.equal((await s.analyze()).get('only-here').truncated, true);
  });
}

test('core callers cannot claim local coverage without a host proof', () => {
  for (const source of ['require.context("./local")', 'import.meta.glob("./local/*")', 'import(`./local/${name}.js`)']) {
    assert.equal(hasUnreadTemplateImports(source, 'index.js'), true);
  }
});


test('an import-only symlink outside the project cannot fall back to a normal partial', async t => {
  const s = await diskWorkspace(t, [['theme.scss', '@import "./vendor/tokens";'], ['vendor/_tokens.scss', '.x {}']]);
  const external = await mkdtemp(path.join(tmpdir(), 'packageawy-outside-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'tokens.scss'), '@import "only-here";');
  if (!await symlinkOrSkip(t, path.join(external, 'tokens.scss'), path.join(s.root, 'vendor/_tokens.import.scss'))) return;
  assert.equal((await s.analyze()).get('only-here').truncated, true);
});


for (const clause of ["export { \"a } from 'fake'\" as a } from \"real\";", "export * as \"x from 'fake'\" from \"real\";"]) {
  test(`quoted export names cannot hide a real from clause: ${clause}`, () => {
    assert.equal(hasUnreadTemplateImports(clause, 'index.ts'), false);
    assert.deepEqual(scanSourceForImports(clause, 'index.ts').map(match => match.packageName), ['real']);
  });
}
