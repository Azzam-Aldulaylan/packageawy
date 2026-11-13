import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { token, usageWorkspace } from './helpers/usage-coverage.mjs';

for (const expression of [
  `/'/.test("x")`,
  `/["'}]/.test("x")`,
  String.raw`/\/'/.test("x")`,
  `(() => { return /'/.test("x"); })()`,
  `(() => { if (true) /'/.test("x"); })()`,
  '`nested ${/\'/ .test("x")}`',
  'value / 2',
  '(value) / 2',
]) {
  test(`template regex walker retains the following import: ${expression}`, async () => {
    const text = 'const value = `${' + expression + '}`; import "only-here";';
    const result = (await usageWorkspace([['page.ts', text]]).analyze()).get('only-here');
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].column, text.indexOf('only-here') + 1);
    assert.equal(result.truncated, false);
  });
}

test('template regex walker marks ambiguous slash context as unread', async () => {
  const text = 'const value = `${(() => { {} /\'/ .test("x"); })()}`; import "only-here";';
  const result = (await usageWorkspace([['page.ts', text]]).analyze()).get('only-here');
  assert.equal(result.truncated, true);
  assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
});

for (const discovered of [false, true]) {
  for (const linkedProject of [false, true]) {
    test(`project containment rejects a sibling script symlink: discovered=${discovered}, linkedProject=${linkedProject}`, async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'usage-project-containment-')));
      try {
        const project = path.join(root, 'a');
        const sibling = path.join(root, 'b');
        await mkdir(project);
        await mkdir(sibling);
        const outside = path.join(sibling, 'outside.ts');
        await writeFile(outside, 'import "only-here";');
        const selected = linkedProject ? path.join(root, 'selected') : project;
        if (linkedProject) await symlink(project, selected);
        const link = path.join(selected, 'link.ts');
        await symlink(outside, link);
        const component = path.join(selected, 'z.vue');
        await writeFile(component, '<script src="./link.ts"></script>');
        const reads = [];
        const stats = [];
        const platform = {
          async findFiles(search) {
            return search.include.includes('vue') ? [component, ...(discovered ? [link] : [])] : [];
          },
          async statFile(file) { stats.push(file); return stat(file); },
          async readFile(file) { reads.push(file); return readFile(file); },
        };
        const result = (await analyzeDependencyUsage({
          platform, folder: { id: root, path: root, name: 'workspace' }, dir: path.basename(selected),
          manifestText: '{}', packageNames: ['only-here'], token,
        })).get('only-here');
        assert.deepEqual(reads, [path.join(project, 'z.vue')]);
        assert.deepEqual(stats, [path.join(project, 'z.vue')]);
        assert.equal(result.references.length, 0);
        assert.equal(result.truncated, true);
        assert.ok(result.coverageReasons.includes('script src targets that could not be read'));
        assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const callee of ['require.resolve', 'import.meta.resolve', 'require.resolve.paths']) {
  for (const trivia of ['', ' /* comment */ ', ' // comment\n ']) {
    for (const location of ['source', 'template', 'markup']) {
      test(`resolution calls participate in ${location} detection: ${callee}, trivia=${JSON.stringify(trivia)}`, async () => {
        const call = callee.split('.').join(`${trivia}.${trivia}`) + trivia + '("only-here")';
        const text = location === 'source' ? `const value = ${call};`
          : location === 'template' ? 'const value = `${' + call + '}`;' : `{#await ${call}}loading{/await}`;
        const file = location === 'markup' ? 'page.svelte' : 'page.ts';
        const result = (await usageWorkspace([[file, text]]).analyze()).get('only-here');
        assert.equal(result.references.length, location === 'source' ? 1 : 0);
        assert.equal(result.truncated, location !== 'source');
        if (location !== 'source') {
          assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
        }
      });
    }
  }
}

test('resolution call text in comments and strings is not confirmed usage', async () => {
  const text = [
    '// require.resolve.paths("only-here")',
    '/* import.meta.resolve("only-here") */',
    'const prose = "require.resolve(\'only-here\')";',
    'const raw = `import.meta.resolve("only-here")`;',
  ].join('\n');
  const result = (await usageWorkspace([['page.ts', text]]).analyze()).get('only-here');
  assert.equal(result.references.length, 0);
  assert.equal(result.truncated, false);
});
