import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from 'node:fs/promises';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { shouldInvalidateSourceEvidence } from '../out/host/usage/sourceEvidenceFiles.js';
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
  const analyze = (packageNames, manifestText = '{}') => analyzeDependencyUsage({ platform, folder, dir: '', manifestText, packageNames, token });
  return Object.assign(analyze, { root, outside, platform });
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
  ['an alias in an extended tsconfig', [['src/main.js', 'import "@tools/helper";'], ['tsconfig.json', '{"extends":"./config/base.json"}'], ['config/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@tools/*":[".claude/*"]}}}']]],
  ['an alias in a tsconfig extended without extension', [['src/main.js', 'import "@tools/helper";'], ['tsconfig.json', '{"extends":["./config/base"]}'], ['config/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@tools/*":[".claude/*"]}}}']]],
  ['an alias named exclude', [['src/main.js', 'import "exclude";'], ['tsconfig.json', '{"compilerOptions":{"paths":{"exclude":[".claude/helper.js"]}}}']]],
  ['an escaped config alias', [['src/main.js', 'import "@tools/helper";'], ['jsconfig.json', String.raw`{"compilerOptions":{"paths":{"@tools/*":["\u002eclaude/*"]}}}`]]],
  ['an alias in a config package', [['src/main.js', 'import "@tools/helper";'], ['tsconfig.json', '{"extends":"shared-config"}'], ['node_modules/shared-config/package.json', '{"name":"shared-config","tsconfig":"./configs/base.json"}'], ['node_modules/shared-config/configs/base.json', '{"compilerOptions":{"paths":{"@tools/*":["${configDir}/.claude/*"]}}}']]],
  ['an alias in a config package found from a nested folder', [['packages/app/src/main.js', 'import "@tools/helper";'], ['packages/app/tsconfig.json', '{"extends":"shared-config/base.json"}'], ['node_modules/shared-config/base.json', '{"compilerOptions":{"paths":{"@tools/*":["${configDir}/../../.claude/*"]}}}']]],
  ['an alias in a hyphenated tsconfig', [['src/main.js', 'import "@tools/helper";'], ['tsconfig-build.json', '{"compilerOptions":{"paths":{"@tools/*":[".claude/*"]}}}']]],
  ['an alias in a config package further up the tree', [['packages/app/src/main.js', 'import "@tools/helper";'], ['packages/app/tsconfig.json', '{"extends":"shared-config/base.json"}'], ['packages/app/node_modules/shared-config/package.json', '{"name":"shared-config"}'], ['node_modules/shared-config/base.json', '{"compilerOptions":{"paths":{"@tools/*":["${configDir}/../../.claude/*"]}}}']]],
  ['a config with extends that cannot be read', [['src/main.js', 'export {};'], ['tsconfig.json', '{"extends": "./config/base.json" ']]],
  ['an alias in a config extended past a comment', [['src/main.js', 'import "@tools/helper";'], ['tsconfig.json', '{"extends" /* base */: "./config/base.json"}'], ['config/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@tools/*":[".claude/*"]}}}']]],
  ['an alias named exclude past a comment', [['src/main.js', 'import "exclude";'], ['tsconfig.json', '{"compilerOptions":{"paths": /* aliases */ {"exclude":[".claude/helper.js"]}}}']]],
  ['an alias named exclude under an escaped key', [['src/main.js', 'import "exclude";'], ['tsconfig.json', String.raw`{"compilerOptions":{"p\u0061ths":{"exclude":[".claude/helper.js"]}}}`]]],
  ['a percent-encoded import', [['src/main.js', 'import "../%2eclaude/helper.js";']]],
  ['a relative import of the place the link leads to', [['src/main.js', 'import "../../outside/helper.js";']]],
]) {
  test(`${label} that names the linked folder keeps removals blocked`, async t => {
    const analyze = await linkedProject(t, files);
    if (analyze === null) return;
    const result = (await analyze(['outside-only'])).get('outside-only');
    assert.equal(result.truncated, true);
    assert.ok(result.coverageReasons.includes(REASON), JSON.stringify(result.coverageReasons));
  });
}

test('an absolute import of the place the link leads to keeps removals blocked', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'export {};']]);
  if (analyze === null) return;
  await writeFile(path.join(analyze.root, 'src/main.js'), `import ${JSON.stringify(path.join(analyze.outside, 'helper.js'))};`);
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes(REASON));
});

test('an alias inherited inside a pnpm store keeps removals blocked', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'import "@tools/helper";'], ['tsconfig.json', '{"extends":"shared-config"}']]);
  if (analyze === null) return;
  const store = path.join(analyze.root, 'node_modules/.pnpm/shared-config@1.0.0/node_modules');
  await mkdir(path.join(store, 'shared-config'), { recursive: true });
  await mkdir(path.join(store, 'inner-config'), { recursive: true });
  await writeFile(path.join(store, 'shared-config/tsconfig.json'), '{"extends":"inner-config/tsconfig.json"}');
  await writeFile(path.join(store, 'inner-config/tsconfig.json'), '{"compilerOptions":{"paths":{"@tools/*":["${configDir}/.claude/*"]}}}');
  if (!await symlinkOrSkip(t, path.join(store, 'shared-config'), path.join(analyze.root, 'node_modules/shared-config'), 'dir')) return;
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes(REASON));
});

test('a config package too large to read keeps removals blocked', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'export {};'], ['tsconfig.json', '{"extends":"huge-config"}']]);
  if (analyze === null) return;
  const dir = path.join(analyze.root, 'node_modules/huge-config');
  await mkdir(dir, { recursive: true });
  for (let index = 0; index <= 200; index += 1) await writeFile(path.join(dir, `config-${index}.json`), '{}');
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes(REASON));
});

test('configs read to check a linked folder are watched for changes', async t => {
  const analyze = await linkedProject(t, [
    ['src/main.js', 'export {};'],
    ['tsconfig.json', '{"extends":["shared-config/tsconfig.json","./config/missing.json","shared-config/new.json"]}'],
    ['node_modules/shared-config/tsconfig.json', '{"compilerOptions":{}}'],
  ]);
  if (analyze === null) return;
  assert.equal((await analyze(['outside-only'])).get('outside-only').truncated, false);
  for (const file of ['node_modules/shared-config/tsconfig.json', 'node_modules/shared-config/new.json', 'config/missing.json', '.claude']) {
    assert.equal(shouldInvalidateSourceEvidence(analyze.platform, analyze.root, path.join(analyze.root, file)), true, file);
  }
});

test('an alias to the place the link leads to, written with escaped backslashes, keeps removals blocked', async t => {
  const analyze = await linkedProject(t, [['src/main.js', 'import "@tools/helper";'], ['vite.config.js', 'export default {};']]);
  if (analyze === null) return;
  const written = analyze.outside.split('/').join('\\\\');
  await writeFile(path.join(analyze.root, 'vite.config.js'), `export default { resolve: { alias: { "@tools": "${written}" } } };`);
  const result = (await analyze(['outside-only'])).get('outside-only');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes(REASON));
});

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
    ['tsconfig.json', '{"compilerOptions":{}, // project\n"exclude":["node_modules",".claude"],}'],
    ['tsconfig.app.json', String.raw`{"exclude":["\u002eclaude"]}`],
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
