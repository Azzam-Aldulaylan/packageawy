import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { findPackageInManifestConfig } from '../out/core/usage/packageScripts.js';
import { analyzeDependencyUsage } from '../out/host/usage/usageAnalyzer.js';
import { readFileChunks } from '../out/host/platform/fileChunks.js';
import { stylesheetHasDependencies } from '../out/host/usage/workspaceFiles.js';
import { token, usageWorkspace } from './helpers/usage-coverage.mjs';

for (const kind of ['relative escape', 'symlink file', 'symlink parent']) {
  for (const discovered of [false, true]) {
    test(`script src containment refuses a readable ${kind}, discovered=${discovered}, before any outside read`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'usage-containment-'));
      try {
        const project = path.join(root, 'project');
        await mkdir(project);
        await mkdir(path.join(root, 'external'));
        const outside = path.join(root, 'external', 'outside.ts');
        await writeFile(outside, 'import "only-here";');
        assert.equal(await readFile(outside, 'utf8'), 'import "only-here";');
        let src = '../external/outside.ts';
        if (kind === 'symlink file') {
          src = './link.ts';
          await symlink(outside, path.join(project, 'link.ts'));
        } else if (kind === 'symlink parent') {
          src = './linked/outside.ts';
          await symlink(path.dirname(outside), path.join(project, 'linked'));
        }
        const component = path.join(project, 'z.vue');
        const target = path.resolve(project, src);
        await writeFile(component, `<script src="${src}"></script>`);
        const reads = [];
        const stats = [];
        const platform = {
          async findFiles(search) {
            return search.include.includes('vue') ? [component, ...(discovered ? [target] : [])] : [];
          },
          async statFile(file) { stats.push(file); return stat(file); },
          async readFile(file) { reads.push(file); return readFile(file); },
          readFileChunks,
        };
        const result = (await analyzeDependencyUsage({
          platform, folder: { id: project, path: project, name: 'project' }, dir: '',
          manifestText: '{}', packageNames: ['only-here'], token,
        })).get('only-here');
        assert.deepEqual(reads.map(file => path.basename(file)), ['z.vue']);
        assert.deepEqual(stats.map(file => path.basename(file)), ['z.vue']);
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

const frontmatter = [
  ['block comment', '/*\n---\n*/'],
  ['template literal', 'const text = `\n---\n`;'],
  ['nested template', 'const text = `${fn(`\n---\n`)}`;'],
  ['quoted comment markers', 'const text = "/*"; // `\nconst other = "//";'],
  ['escaped quote', 'const text = "\\\"/*";'],
  ['continued string', 'const text = "a\\\n---\\\nb";'],
];
for (const [kind, prefix] of frontmatter) {
  test(`Astro lexical fence scanning retains imports after ${kind}`, async () => {
    const text = `---\n${prefix}\nimport "only-here";\n---\n<p>Hello</p>`;
    const result = (await usageWorkspace([['page.astro', text]]).analyze()).get('only-here');
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].line, prefix.split('\n').length + 2);
    assert.equal(result.truncated, false);
  });
}
for (const prefix of ['/*', 'const text = `', 'const text = "', 'const pattern = /[/*]/;']) {
  test(`Astro ambiguous or unterminated frontmatter gates coverage: ${prefix}`, async () => {
    const result = (await usageWorkspace([['page.astro', `---\n${prefix}\n---\nimport "only-here";`]]).analyze()).get('only-here');
    assert.equal(result.truncated, true);
    assert.ok(result.coverageReasons.includes('Astro frontmatter that could not be extracted'));
    assert.equal(result.references.length, 0);
  });
}

for (const keyword of ['require', 'import']) {
  for (const trivia of ['/* comment */', '// comment\n', ' /* first */ \n // second\n /* last */ ']) {
    for (const location of ['source', 'template', 'markup']) {
      test(`call trivia ${JSON.stringify(trivia)} after ${keyword} in ${location} cannot bypass usage coverage`, async () => {
        const call = `${keyword}${trivia}("only-here")`;
        const text = location === 'source' ? `const value = ${call};`
          : location === 'template' ? 'const value = `${' + call + '}`;' : `{#await ${call}}loading{/await}`;
        const file = location === 'markup' ? 'page.svelte' : 'page.ts';
        const result = (await usageWorkspace([[file, text]]).analyze()).get('only-here');
        assert.equal(result.references.length, location === 'source' ? 1 : 0);
        assert.equal(result.truncated, location !== 'source');
        if (location !== 'source') assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
      });
    }
  }
}

test('coverage-only MDX presence gates without any content reads, even when discovered as config', async () => {
  const workspace = usageWorkspace([['doc.mdx', 'x'.repeat(100000)], ['.storybook/story.mdx', null]]);
  const result = (await workspace.analyze()).get('only-here');
  assert.deepEqual(workspace.reads, []);
  assert.deepEqual(workspace.chunkReads, []);
  assert.deepEqual(result.coverageReasons, ['.mdx files']);
});

test('coverage stylesheet inspection stops at its first directive and skips remaining stylesheets', async () => {
  const workspace = usageWorkspace(Array.from({ length: 100 }, (_, index) => [
    `${String(index).padStart(3, '0')}.scss`, '@import "only-here";\n' + 'x'.repeat(100000),
  ]));
  const result = (await workspace.analyze()).get('only-here');
  assert.deepEqual(workspace.reads, []);
  assert.deepEqual(workspace.chunkReads, [{ file: '000.scss', bytes: 4096 }]);
  assert.deepEqual(result.coverageReasons, ['stylesheets with @import, @use or @plugin']);
});

for (const directive of ['import', 'use', 'plugin']) {
  test(`stylesheet streaming recognizes @${directive} across chunk boundaries and closes the file`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'usage-style-'));
    const file = path.join(root, 'style.scss');
    const text = ' '.repeat(4094) + `@${directive} "only-here";` + 'x'.repeat(100000);
    let bytes = 0;
    let closed = false;
    try {
      await writeFile(file, text);
      const platform = {
        async *readFileChunks(target) {
          try {
            for await (const chunk of readFileChunks(target)) {
              bytes += chunk.byteLength;
              yield chunk;
            }
          } finally { closed = true; }
        },
      };
      assert.equal(await stylesheetHasDependencies(platform, file, token), true);
      assert.equal(bytes, 8192);
      assert.equal(closed, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('stylesheet streaming waits for a complete directive word boundary', async () => {
  const workspace = usageWorkspace([['style.scss', ' '.repeat(4089) + '@imports "text";']]);
  const result = (await workspace.analyze()).get('only-here');
  assert.equal(result.truncated, false);
});

for (const [name, config] of [
  ['only-here', { config: { message: 'only-here is being removed' } }],
  ['only-here', { config: ['remove only-here', 'only-here-extra', './only-here', 'only-here/path with prose'] }],
  ['@scope/only-here', { config: ['only-here', '@other/only-here', 'scope/only-here'] }],
  ['@scope/cli', { config: ['cli', 'scope'] }],
  ['only-here', { config: { 'remove only-here': true, 'only-here/subpath': true } }],
  ['eslint-config-next', { config: 'next', eslintConfig: { message: 'next', extends: ['next is being removed'] } }],
  ['eslint-plugin-react', { eslintConfig: { message: 'react', plugins: ['react is being removed'] } }],
]) {
  test(`manifest config ignores unrelated strings and keys: ${JSON.stringify(config)}`, () => {
    assert.deepEqual(findPackageInManifestConfig(JSON.stringify(config), name), []);
  });
}
for (const [name, config] of [
  ['only-here', { config: 'only-here/subpath' }],
  ['@scope/only-here', { config: ['@scope/only-here/subpath'] }],
  ['only-here', { 'only-here': true }],
  ['only-here', { config: { 'only-here': false } }],
  ['eslint-config-next', { eslintConfig: { extends: ['next/core-web-vitals'] } }],
  ['eslint-plugin-react', { eslintConfig: { extends: ['plugin:react/recommended'] } }],
  ['@scope/eslint-plugin-foo', { eslintConfig: { plugins: ['@scope/foo'] } }],
]) {
  test(`manifest config retains meaningful references: ${JSON.stringify(config)}`, () => {
    assert.equal(findPackageInManifestConfig(JSON.stringify(config), name).length, 1);
  });
}
