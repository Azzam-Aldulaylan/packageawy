import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnreadTemplateImports, scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { extractSourceCoverage } from '../out/core/usage/sourceCoverage.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const callees = ['require', 'import', 'require.resolve', 'require.resolve.paths', 'import.meta.resolve'];

test('masked matches cannot consume executable JSX or template calls', async () => {
  for (const outer of callees) {
    for (const inner of callees) {
      for (const wrap of [
        call => `<div>${outer}('{${call}}')</div>`,
        call => '`' + outer + "('${" + call + "}')`",
        call => '<div>{`' + outer + "('${" + call + "}')`}</div>",
        call => '`' + outer + '(/* ${' + call + '} */)`',
      ]) {
        const source = 'const view = ' + wrap(`${inner}("only-here")`) + ';';
        const [match, ...rest] = scanSourceForImportSpecifiers(source, 'page.tsx');
        assert.equal(match?.specifier, 'only-here', source);
        assert.deepEqual(rest, [], source);
        assert.equal(match.column, source.indexOf('only-here') + 1, source);
        assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
        const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
        assert.equal(usage.references.length, 1, source);
        assert.equal(usage.truncated, false, source);
      }
    }
  }
});

test('an executable interpolated call cannot consume its nested calls', () => {
  for (const outer of callees) {
    for (const inner of callees) {
      const source = outer + '(`prefix-${' + inner + '("only-here")}`);';
      assert.deepEqual(scanSourceForImportSpecifiers(source).map(match => match.specifier), ['only-here'], source);
      assert.equal(hasUnreadTemplateImports(source), true, source);
    }
  }
});

test('masked callee trivia cannot hide unresolved calls from the coverage gate', async () => {
  for (const callee of callees) {
    const source = '`require(/* ${' + callee + '(name)} */)`;';
    assert.equal(hasUnreadTemplateImports(source), true, source);
    const usage = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
    assert.equal(usage.truncated, true, source);
    assert.equal(assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown', source);
  }
});

test('component scripts retain plain TS lexical modes for every language spelling', async () => {
  for (const extension of ['vue', 'svelte', 'astro']) {
    for (const attributes of [
      'lang="ts"', "setup lang='typescript'", 'LANG=TS',
      'type="text/typescript"', 'type="application/typescript"',
    ]) {
      for (const callee of ['require', 'import']) {
        const source = `<script ${attributes}>\nconst x = <number>${callee}("only-here"); const y = x</number>/.source.length;\n</script>`;
        const usage = (await usageWorkspace([[`page.${extension}`, source]]).analyze()).get('only-here');
        assert.equal(usage.references.length, 1, source);
        assert.equal(usage.references[0].line, 2, source);
        assert.equal(usage.truncated, false, source);
      }
    }
  }
});

test('mixed script blocks use their own language for references and coverage', async () => {
  for (const extension of ['vue', 'svelte', 'astro']) {
    for (const [attributes, language] of [
      ['', 'js'], ['lang="js"', 'js'], ['lang="javascript"', 'js'],
      ['type="module"', 'js'], ['type="text/javascript"', 'js'],
      ['lang="ts"', 'ts'], ['lang="typescript"', 'ts'],
      ['lang="jsx"', 'jsx'], ['lang="tsx"', 'tsx'],
    ]) {
      const jsx = language === 'jsx' || language === 'tsx';
      const expression = jsx ? '<div>require(\'{require("only-here")}\')</div>'
        : '<number>require("only-here"); const y = x</number>/.source.length';
      const source = `<script ${attributes}>\nconst x = ${expression};\n</script>\n<script lang="tsx">const view = <span>{import("second")}</span>;</script>`;
      const coverage = extractSourceCoverage(`page.${extension}`, source);
      assert.deepEqual(coverage.scripts.map(script => script.language), [language, 'tsx']);
      const results = await usageWorkspace([[`page.${extension}`, source]]).analyze({ packageNames: ['only-here', 'second'] });
      assert.equal(results.get('only-here').references.length, 1, source);
      assert.equal(results.get('second').references.length, 1, source);
      assert.equal(results.get('only-here').truncated, false, source);
    }
  }
});

test('ordinary TS scripts and Astro frontmatter remain complete after angle assertions', async () => {
  for (const [file, source] of [
    ['page.vue', '<script lang="ts">const x = <number>require("only-here");</script>'],
    ['page.svelte', '<script lang="typescript">const x = <number>import("only-here");</script>'],
    ['page.astro', '---\nconst x = <number>require("only-here");\n---\n<div />'],
  ]) {
    const usage = (await usageWorkspace([[file, source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1, source);
    assert.equal(usage.truncated, false, source);
  }
});

test('plain script modes also expose unresolved calls to coverage checking', async () => {
  for (const extension of ['vue', 'svelte', 'astro']) {
    for (const attributes of ['lang="ts"', 'lang="typescript"', 'lang="js"', 'type="text/typescript"']) {
      for (const callee of ['require', 'import']) {
        const source = `<script ${attributes}>const x = <number>${callee}(name); const y = x</number>/.source.length;</script>`;
        const usage = (await usageWorkspace([[`page.${extension}`, source]]).analyze()).get('only-here');
        assert.equal(usage.references.length, 0, source);
        assert.equal(usage.truncated, true, source);
        assert.equal(assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown', source);
      }
    }
  }
});
