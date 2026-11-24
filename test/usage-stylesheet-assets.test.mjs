import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { scanBulkImport } from '../out/core/usage/bulkImportScan.js';
import { scanStylesheet } from '../out/core/usage/styleScan.js';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { token, usageWorkspace, symlinkOrSkip } from './helpers/usage-coverage.mjs';

async function fixture(t, entries, dir = '') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-usage3-')));
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
        .filter(file => !file.includes('node_modules/') && path.matchesGlob(file, search.include))
        .map(file => path.join(root, file)).slice(0, search.maxResults);
    },
  };
  return { root, reads, stats, platform,
    analyze: (packageNames = ['only-here', 'unused']) => analyzeDependencyUsage({
      platform, folder, dir, manifestText: '{}', packageNames, token,
    }),
    compatibility: () => collectProjectCompatibilityEvidence({ platform, folder, dir, manifestText: '{}', packageName: 'only-here' }),
  };
}

const removal = usage => assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status;
const glob = options => `import.meta.glob("./locales/*.js", ${options})`;
for (const options of [
  '{ base: "../node_modules/only-here", exhaustive: true, eager: true }',
  '{ base: "/node_modules/only-here" }', '{ base: "../../outside" }',
  '{ base: "../../app-other" }', '{ base: "alias" }', '{ base: "./*/dir" }',
  '{ base: 1 }', '{ base: null }', '{ base: {} }', '{ base: compute() }',
  '{ base: "./ok", base: null }', '{ base: "./ok", ...options }',
  '{ unknown: true }', '{ unknown: { nested: [1] } }', '{ eager: compute() }',
  '{ exhaustive: value }', '{ query: { raw: compute() } }', '{ caseSensitive: false }',
]) {
  test(`unsafe glob options keep uncertainty: ${options}`, () => {
    const result = scanBulkImport(glob(options), 'app/src/main.js', 'app');
    assert.equal(result.unread, true);
  });
}

for (const [base, pattern, expected] of [
  ['../assets', './locales/*.js', 'app/assets/locales'],
  ['/assets', './locales/*.js', 'app/assets/locales'],
  ['../assets', '/locales/*.js', 'app/locales'],
]) {
  test(`apply glob base ${base} before classifying ${pattern}`, () => {
    const result = scanBulkImport(`import.meta.glob("${pattern}", { "base": "${base}", eager: true, query: { raw: "" } })`, 'app/src/main.js', 'app');
    assert.equal(result.unread, false);
    assert.deepEqual(result.localDirectories, [expected]);
  });
}

test('glob base reaching node_modules cannot certify usage or compatibility', async t => {
  const s = await fixture(t, [['src/main.js', glob('{ base: "../node_modules/only-here", exhaustive: true, eager: true }')],
    ['node_modules/only-here/locales/en.js', 'export default 1;']]);
  const usage = (await s.analyze()).get('only-here');
  assert.equal(usage.truncated, true);
  assert.notEqual(removal(usage), 'low-risk');
  assert.equal((await s.compatibility()).truncated, true);
});

test('coverage proof follows the base directory, including canonical package aliases', async t => {
  const s = await fixture(t, [['src/main.js', glob('{ base: "../assets" }')],
    ['node_modules/only-here/locales/en.js', 'export default 1;']]);
  if (!await symlinkOrSkip(t, 'node_modules/only-here', path.join(s.root, 'assets'), 'dir')) return;
  assert.equal((await s.analyze()).get('only-here').truncated, true);
  assert.equal((await s.compatibility()).truncated, true);
});

const assetFunctions = [
  ['css', value => `image-set(${value} 1x)`],
  ['css', value => `-webkit-image-set(${value} 1x)`],
  ['less', value => `data-uri(${value})`],
  ['less', value => `data-uri("image/svg+xml", ${value})`],
  ['stylus', value => `embedurl(${value})`],
];
for (const [dialect, call] of assetFunctions) {
  const extension = dialect === 'stylus' ? 'styl' : dialect;
  test(`${call('path')} retains imported asset owners without reading assets`, async t => {
    const text = `.x { background: ${call('"./node_modules/only-here/image.svg"')}; }`;
    const s = await fixture(t, [[`theme.${extension}`, `@import "./icons.${extension}";`],
      [`icons.${extension}`, text], ['node_modules/only-here/image.svg', Buffer.from([0, 255, 0])]]);
    const result = await s.analyze();
    assert.ok(result.get('only-here').references.some(ref => ref.filePath === `icons.${extension}`));
    assert.notEqual(removal(result.get('only-here')), 'low-risk');
    assert.equal(result.get('unused').truncated, false);
    assert.ok(s.reads.every(file => !file.endsWith('.svg')));
  });
  for (const value of ['var(--asset)', '"./prefix/" + variable', '"./#{name}.svg"']) {
    test(`computed ${call(value)} keeps uncertainty`, async () => {
      const result = await usageWorkspace([[`theme.${extension}`, `.x { background: ${call(value)}; }`]]).analyze();
      assert.equal(result.get('only-here').truncated, true);
      assert.notEqual(removal(result.get('only-here')), 'low-risk');
    });
  }
}

test('image-set scans each candidate and ignores type strings and ordinary CSS strings', () => {
  const source = '.x { content: "fake.svg"; background: image-set("./first.svg" 1x type("image/svg+xml"), url("./second.svg") 2x, "./third.svg" 3x); }';
  const scan = scanStylesheet(source);
  assert.deepEqual(scan.targets.map(item => item.target), ['./first.svg', './second.svg', './third.svg']);
  assert.deepEqual(scan.unread, []);
  for (const item of scan.targets) assert.equal(source.slice(item.offset, item.offset + item.target.length), item.target);
});

for (const name of ['image-set', '-webkit-image-set']) {
  test(`${name} URL candidates keep computed local arguments uncertain`, async () => {
    const source = `.x { background: ${name}(url(./pick()) 1x); }`;
    assert.equal(scanStylesheet(source, 'less').targets[0].computed, true);
    const result = await usageWorkspace([['theme.less', source]]).analyze();
    assert.equal(result.get('only-here').truncated, true);
  });
}

for (const [dialect, call, value] of [
  ['less', assetFunctions[2][1], '@asset'], ['stylus', assetFunctions[4][1], 'asset'],
]) {
  test(`${dialect} unquoted variable stays uncertain`, async () => {
    const result = await usageWorkspace([[`theme.${dialect}`, `.x { background: ${call(value)}; }`]]).analyze();
    assert.equal(result.get('only-here').truncated, true);
  });
}

for (const [url, filename] of [
  ['./vendor%20assets/image.svg?ignored=%ZZ#fragment', 'image.svg'],
  ['./vendor%20assets/image%23one.svg?query#fragment', 'image#one.svg'],
  ['./vendor%20assets/image%23one%3Ftwo.svg?query#fragment', 'image#one?two.svg'],
  ['./%6eode_modules/only-here/image.svg', 'image.svg'],
]) {
  test(`percent-decoded ${url} credits the canonical owner`, async t => {
    if (process.platform === 'win32' && filename.includes('?')) return t.skip('Windows filenames cannot contain ?');
    const s = await fixture(t, [['theme.css', '@import "./icons.css";'],
      ['icons.css', `.x { background: url("${url}"); }`], [`node_modules/only-here/${filename}`, 'binary']]);
    if (!await symlinkOrSkip(t, 'node_modules/only-here', path.join(s.root, 'vendor assets'), 'dir')) return;
    const result = await s.analyze();
    assert.ok(result.get('only-here').references.some(ref => ref.filePath === 'icons.css'));
    assert.equal(result.get('unused').truncated, false);
    assert.ok(s.reads.every(file => file.endsWith('.css')));
  });
}

for (const url of ['./bad%ZZ.svg', './bad%C0%AF.svg', '/bad%ZZ.svg']) {
  test(`undecodable URL ${url} keeps uncertainty`, async () => {
    const result = await usageWorkspace([['theme.css', `.x { background: url("${url}"); }`]]).analyze();
    assert.equal(result.get('only-here').truncated, true);
  });
}

for (const dir of ['', 'packages/app']) {
  for (const location of ['', 'public/']) {
    test(`root asset checks project ${dir || '.'}/${location} using metadata only`, async t => {
      const prefix = dir ? dir + '/' : '';
      const s = await fixture(t, [[`${prefix}src/theme.css`, '@import "./icons.css";'],
        [`${prefix}src/icons.css`, '.x { background: url("/vendor/image.svg?v=1#icon"); }'],
        [`${prefix}node_modules/only-here/image.svg`, 'binary']], dir);
      await mkdir(path.join(s.root, prefix + location), { recursive: true });
      if (!await symlinkOrSkip(t, path.join(s.root, `${prefix}node_modules/only-here`), path.join(s.root, prefix + location + 'vendor'), 'dir')) return;
      const result = await s.analyze();
      assert.ok(result.get('only-here').references.some(ref => ref.filePath === `${prefix}src/icons.css`));
      assert.equal(result.get('unused').truncated, false);
      assert.ok(s.reads.every(file => file.endsWith('.css')));
      assert.ok(s.stats.includes(path.join(s.root, prefix + location + 'vendor/image.svg')));
    });
  }
}

test('both project and public canonical owners are retained', async t => {
  const s = await fixture(t, [['src/theme.css', '.x { background: url("/vendor/image.svg"); }'],
    ['node_modules/only-here/image.svg', 'binary'], ['node_modules/second/image.svg', 'binary']]);
  await mkdir(path.join(s.root, 'public'));
  if (!await symlinkOrSkip(t, '../node_modules/only-here', path.join(s.root, 'public/vendor'), 'dir')) return;
  if (!await symlinkOrSkip(t, 'node_modules/second', path.join(s.root, 'vendor'), 'dir')) return;
  const result = await s.analyze(['only-here', 'second', 'unused']);
  for (const name of ['only-here', 'second']) assert.ok(result.get(name).references.length > 0);
  assert.equal(result.get('unused').truncated, false);
  assert.deepEqual(s.reads, [path.join(s.root, 'src/theme.css')]);
});

for (const url of ['./missing.svg', '/missing.svg', './missing%20asset.svg', '/missing%20asset.svg']) {
  test(`missing local asset ${url} stays certain and unread`, async t => {
    const s = await fixture(t, [['src/theme.css', `.x { background: url("${url}"); }`]]);
    const result = await s.analyze();
    assert.equal(result.get('unused').truncated, false);
    assert.equal(removal(result.get('unused')), 'low-risk');
    assert.deepEqual(s.reads, [path.join(s.root, 'src/theme.css')]);
  });
}
