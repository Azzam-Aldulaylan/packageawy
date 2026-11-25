import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { token, symlinkOrSkip } from './helpers/usage-coverage.mjs';

// A project with a linked folder whose real files live elsewhere, as editor
// search lists them: through the link, inside the project folder.
// Editor search matches dot-folders, which path.matchesGlob skips by default.
const matches = (file, glob) => path.matchesGlob(file.replace(/(^|\/)\./g, '$1'), glob);
async function linkedProject(t, projectFiles, { link = '.claude', outsideFiles = [['helper.js', 'import "outside-only";']], linkType = 'dir' } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-links-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  for (const [file, text] of projectFiles) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  for (const [file, text] of outsideFiles) {
    await mkdir(path.dirname(path.join(outside, file)), { recursive: true });
    await writeFile(path.join(outside, file), text);
  }
  await mkdir(root, { recursive: true });
  const linkTarget = linkType === 'dir' ? outside : path.join(outside, outsideFiles[0][0]);
  if (!await symlinkOrSkip(t, linkTarget, path.join(root, link), linkType === 'dir' ? 'dir' : 'file')) return null;
  const listed = [
    ...projectFiles.map(([file]) => file),
    ...(linkType === 'dir' ? outsideFiles.map(([file]) => `${link}/${file}`) : [link]),
  ];
  const folder = { id: root, name: 'project', path: root };
  const platform = {
    statFile: stat, readFile,
    async findFiles(search) {
      return listed.filter(file => matches(file, search.include)).map(file => path.join(root, file));
    },
  };
  return (packageNames, manifestText = '{}') => analyzeDependencyUsage({ platform, folder, dir: '', manifestText, packageNames, token });
}

test('files reached through a link to another folder do not make the scan incomplete', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'import "used-here";']]);
  if (analyze === null) return;
  const results = await analyze(['used-here', 'unused-here']);
  for (const name of ['used-here', 'unused-here']) {
    assert.equal(results.get(name).truncated, false, name);
    assert.deepEqual(results.get(name).coverageReasons ?? [], [], name);
  }
  assert.equal(results.get('used-here').references.length, 1);
  assert.equal(results.get('unused-here').references.length, 0);
  const assessment = assessRemoval({ usage: results.get('unused-here'), scriptReferences: [], configReferences: [], stillRequiredBy: [], peerRequirements: [] });
  assert.notEqual(assessment.status, 'unknown');
});

test('a linked file that is not an AI tool folder keeps the scan incomplete, as before', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'export {};']], { link: 'src/linked.js', linkType: 'file' });
  if (analyze === null) return;
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, true);
  assert.equal(result.references.length, 0);
});

const REASON = 'linked AI tool folders outside the project that the project refers to';
for (const [label, files] of [
  ['a relative import', [['src/main.js', 'import x from "../.claude/helper.js";']]],
  ['an import without extension', [['src/main.js', 'import x from "../.claude/helper";']]],
  ['an absolute import', [['src/main.js', 'require("/srv/app/.claude/helper.js");']]],
  ['a root-relative import', [['src/main.js', 'import "/.claude/helper.js";']]],
  ['a different letter case', [['src/main.js', 'import "../.CLAUDE/helper.js";']]],
  ['an escaped specifier', [['src/main.js', String.raw`import "../.claude/helper.js";`]]],
  ['a tsconfig alias', [['src/main.js', 'import "@tools/helper";'], ['tsconfig.json', '{"compilerOptions":{"paths":{"@tools/*":[".claude/*"]}}}']]],
  ['a jsconfig alias', [['src/main.js', 'import "@tools/helper";'], ['jsconfig.json', '{"compilerOptions":{"paths":{"@tools/*":[".claude/*"]}}}']]],
  ['a bundler alias', [['src/main.js', 'import "@tools/helper";'], ['vite.config.js', 'export default { resolve: { alias: { "@tools": "./.claude" } } };']]],
]) {
  test(`${label} that names the linked folder keeps removals blocked`, async t => {
    const analyze = await linkedProject(t, files);
    if (analyze === null) return;
    const result = (await analyze(['outside-only'])).get('outside-only');
    assert.equal(result.truncated, true);
    assert.ok(result.coverageReasons.includes(REASON), JSON.stringify(result.coverageReasons));
  });
}

test('a package script that names the linked folder keeps removals blocked', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'export {};']]);
  if (analyze === null) return;
  // The manifest is passed in by the caller, as the extension does.
  const result = (await analyze(['outside-only'], '{"scripts":{"tool":"node --preserve-symlinks ./.claude/helper.js"}}')).get('outside-only');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes(REASON));
});

for (const [label, options] of [
  ['another hidden folder', { link: '.tools' }],
  ['a linked config file loaded by convention', { link: '.prettierrc.cjs', linkType: 'file', outsideFiles: [['prettierrc.cjs', 'module.exports = require("outside-only");']] }],
]) {
  test(`${label} that leads outside the project keeps the scan incomplete`, async t => {
    const analyze = await linkedProject(t, [['src/main.js', 'export {};']], options);
    if (analyze === null) return;
    const result = (await analyze(['outside-only'])).get('outside-only');
    assert.equal(result.truncated, true);
  });
}

test('exclude and ignore lists that name the folder do not block', async t => {
  const analyze = await linkedProject(t, [
    ['src/main.js', 'export {};'],
    ['tsconfig.json', '{"compilerOptions":{},"exclude":["node_modules",".claude"]}'],
    ['eslint.config.js', 'export default [{ ignores: [".claude/**", ".agents/**"] }];'],
  ]);
  if (analyze === null) return;
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.coverageReasons ?? [], []);
});

test('an ignore list that runs code naming the folder keeps removals blocked', async t => {
  const analyze = await linkedProject(t, [
    ['src/main.js', 'export {};'],
    ['eslint.config.js', 'module.exports = [{ ignores: [...require("./.claude/eslint-ignores.cjs")] }];'],
  ]);
  if (analyze === null) return;
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes(REASON));
});

test('a link inside a real AI tool folder is left out too', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'export {};'], ['.claude/settings.json', '{}']], { link: '.claude/skills' });
  if (analyze === null) return;
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, false);
  assert.equal(result.references.length, 0);
});

test('a link that stays inside the project is still read', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-links-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'shared'), { recursive: true });
  await writeFile(path.join(base, 'shared/feature.js'), 'import "inside-link";');
  if (!await symlinkOrSkip(t, path.join(base, 'shared'), path.join(base, 'linked'), 'dir')) return;
  const listed = ['shared/feature.js', 'linked/feature.js'];
  const platform = {
    statFile: stat, readFile,
    async findFiles(search) {
      return listed.filter(file => matches(file, search.include)).map(file => path.join(base, file));
    },
  };
  const result = (await analyzeDependencyUsage({
    platform, folder: { id: base, name: 'p', path: base }, dir: '', manifestText: '{}', packageNames: ['inside-link'], token,
  })).get('inside-link');
  assert.ok(result.references.length >= 1);
});
