import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { buildUnusedFinding } from '../out/core/usage/unused.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const readable = [
  ['script-first Vue', 'page.vue', `<script>\nimport x from 'only-here';\n</script>\n<template>It's here</template>`, 2],
  ['template-first Vue', 'page.vue', `<template>It's here</template>\n<script lang="ts">\nimport x from 'only-here';\n</script>`, 3],
  ['Svelte', 'page.svelte', `<h1>It's here</h1>\n<script>\nimport x from 'only-here';\n</script>`, 3],
  ['Astro frontmatter', 'page.astro', `---\nimport x from 'only-here';\n---\n<h1>It's here</h1>`, 2],
  ['Astro script', 'page.astro', `<h1>It's here</h1>\n<script>\nimport x from 'only-here';\n</script>`, 3],
  ['MTS', 'page.mts', `\nimport x from 'only-here';`, 2],
  ['CTS', 'page.cts', `\nconst x = require('only-here');`, 2],
];
for (const [name, file, text, line] of readable) {
  test(`${name} references keep their original coordinates and prevent an unused finding`, async () => {
    const result = (await usageWorkspace([[file, text]]).analyze()).get('only-here');
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].filePath, file);
    assert.equal(result.references[0].line, line);
    assert.equal(result.references[0].column, text.split('\n')[line - 1].indexOf('only-here') + 1);
    assert.equal(result.truncated, false);
    assert.equal(buildUnusedFinding('only-here', result), null);
  });
}

test('multiple component scripts are scanned independently and markup strings are not references', async () => {
  const result = (await usageWorkspace([['page.vue', `<script>import 'only-here';</script>
<template title="import('fake')">It's here</template>
<script setup lang='ts'>import 'second';</script>`]]).analyze({ packageNames: ['only-here', 'second', 'fake'] }));
  assert.equal(result.get('second').references[0].line, 3);
  assert.equal(result.get('fake').references.length, 0);
  assert.equal(result.get('only-here').truncated, true, 'unread markup import() still gates coverage');
});

const unread = [
  ['MDX', 'doc.mdx', `It's prose\nimport x from 'only-here';`, '.mdx files'],
  ['Svelte markup import()', 'page.svelte', `{#await import('only-here')}loading{/await}`, 'import() calls in component markup'],
  ['external script src', 'page.vue', `<script src="https://example.com/app.js"></script>`, 'script src targets'],
  ['missing local script src', 'page.vue', `<script src="./missing.ts"></script>`, 'script src targets'],
  ['unsupported script language', 'page.svelte', `<script lang="coffee">require 'only-here'</script>`, 'unsupported languages'],
  ['unsupported script type', 'page.vue', `<script type="text/coffeescript">require 'only-here'</script>`, 'unsupported languages'],
  ['failed script extraction', 'page.vue', `<script lang="ts">import 'only-here';`, 'could not be extracted'],
  ['failed style extraction', 'page.vue', `<style>@import 'only-here';`, 'could not be extracted'],
  ['failed Astro frontmatter extraction', 'page.astro', `---\nimport 'only-here';`, 'could not be extracted'],
  ['empty unclosed Astro frontmatter', 'page.astro', '---', 'could not be extracted'],
  ['malformed block opening', 'page.vue', `<script lang="ts"\nimport 'only-here';`, 'could not be extracted'],
  ['require interpolation', 'page.ts', 'const value = `${require("only-here")}`;', 'template-literal interpolations'],
  ['nested template interpolation', 'page.ts', 'const value = `${foo(`hello`), require("only-here")}`;', 'template-literal interpolations'],
  ['nested interpolated template', 'page.ts', 'const value = `${`hello ${require("only-here")}`}`;', 'template-literal interpolations'],
  ['import interpolation', 'page.ts', 'const value = `${import("only-here")}`;', 'template-literal interpolations'],
];
for (const directive of ['import', 'use', 'plugin']) {
  unread.push([`component style @${directive}`, 'page.svelte', `<style>@${directive} 'only-here';</style>`, 'style blocks']);
  for (const extension of ['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss']) {
    unread.push([`${extension} @${directive}`, `style.${extension}`, `@${directive} 'only-here';`, 'stylesheets']);
  }
}
for (const [name, file, text, reason] of unread) {
  test(`${name} reaches both finding confidence and the removal gate with a reason`, async () => {
    const result = (await usageWorkspace([[file, text]]).analyze()).get('only-here');
    assert.equal(result.references.length, 0);
    assert.equal(result.truncated, true);
    assert.ok(result.coverageReasons.some(entry => entry.includes(reason)));
    const finding = buildUnusedFinding('only-here', result);
    assert.equal(finding.confidence, 'low');
    assert.ok(finding.evidence.reason.includes(reason));
    const assessment = assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] });
    assert.equal(assessment.status, 'unknown');
    assert.ok(assessment.evidence[0].summary.includes(reason));
  });
}

for (const src of ['./hidden.mts', '/hidden.mts']) {
  test(`a readable local script src ${src} is followed even outside source discovery`, async () => {
    const workspace = usageWorkspace([
      ['page.vue', `<script src="${src}" lang="ts"></script>`],
      ['hidden.mts', `import 'only-here';`],
    ], { hidden: ['hidden.mts'] });
    const result = (await workspace.analyze()).get('only-here');
    assert.equal(result.truncated, false);
    assert.equal(result.references[0].filePath, 'hidden.mts');
    assert.deepEqual(workspace.reads.sort(), ['hidden.mts', 'page.vue']);
  });
}

test('local script src discovered as source is read and indexed only once', async () => {
  const workspace = usageWorkspace([
    ['page.vue', `<script src="./external.ts"></script>`], ['external.ts', `import 'only-here';`],
  ]);
  const result = (await workspace.analyze()).get('only-here');
  assert.equal(result.references.length, 1);
  assert.equal(workspace.reads.filter(file => file === 'external.ts').length, 1);
  assert.equal(result.truncated, false);
});

test('styles without dependency directives and ordinary templates leave coverage complete', async () => {
  const result = (await usageWorkspace([
    ['style.scss', '.foo { color: red; }'],
    ['page.svelte', `<script>const prose = 'import("only-here")';
const template = \`plain import("only-here")\`;
const escaped = \`\\\${require("only-here")}\`;</script><style>p { color: red; }</style>`],
  ]).analyze()).get('only-here');
  assert.equal(result.truncated, false);
  assert.equal(result.references.length, 0);
});

for (const file of ['nuxt.config.json', 'svelte.config.json', 'astro.config.json', 'playwright.config.json',
  'cypress.config.json', '.storybook/main.json', 'tsup.config.json']) {
  test(`a package named only in ${file} is used`, async () => {
    const result = (await usageWorkspace([[file, '{ "plugins": ["only-here"] }']]).analyze()).get('only-here');
    assert.equal(result.references[0].kind, 'config');
    assert.equal(result.references[0].filePath, file);
    assert.equal(buildUnusedFinding('only-here', result), null);
  });
}
for (const key of ['eslintConfig', 'prettier', 'jest', 'lint-staged', 'babel', 'stylelint', 'browserslist', 'config', 'customTool']) {
  test(`a package named only in package.json ${key} is used`, async () => {
    const manifest = JSON.stringify({ dependencies: { 'only-here': '*' }, [key]: { plugins: ['only-here'] } });
    const result = (await usageWorkspace([], { manifest }).analyze()).get('only-here');
    assert.equal(result.references[0].kind, 'config');
    assert.equal(result.references[0].context, `package.json ${key}`);
    assert.equal(buildUnusedFinding('only-here', result), null);
  });
}

test('package.json config matches nested object keys and ESLint shorthand without counting dependency metadata', async () => {
  const manifest = JSON.stringify({
    name: 'only-here', dependencies: { 'only-here': '*' }, peerDependenciesMeta: { 'only-here': { optional: true } },
    overrides: { 'only-here': '*' }, resolutions: { 'only-here': '*' },
    jest: { transform: { '^.+': 'nested-package' } },
    'lint-staged': { '*.ts': { 'key-package': true } }, eslintConfig: { extends: ['next/core-web-vitals'] },
  });
  const results = await usageWorkspace([], { manifest }).analyze({ packageNames: ['only-here', 'nested-package', 'key-package', 'eslint-config-next'] });
  assert.equal(results.get('only-here').references.length, 0);
  for (const name of ['nested-package', 'key-package', 'eslint-config-next']) assert.equal(results.get(name).references[0].kind, 'config');
});

test('a stylesheet also discovered as config still makes coverage incomplete', async () => {
  const result = (await usageWorkspace([['.storybook/theme.scss', '@use "a-different-package";']]).analyze()).get('only-here');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.includes('stylesheets with @import, @use or @plugin'));
});

for (const file of ['unreadable.mdx', 'unreadable.scss']) {
  test(`unreadable ${file} is discovered and explains its coverage gap`, async () => {
    const result = (await usageWorkspace([[file, null]]).analyze()).get('only-here');
    assert.equal(result.truncated, true);
    assert.ok(result.coverageReasons.some(reason => reason.includes(file.endsWith('mdx') ? '.mdx files' : 'stylesheets')));
  });
}

test('nested template text cannot hide the import after it as a comment', async () => {
  const result = (await usageWorkspace([
    ['page.ts', 'const x = `${fn(`https://example.com`)}`; import "only-here";'],
  ]).analyze()).get('only-here');
  assert.equal(result.references.length, 1);
  assert.equal(result.truncated, false);
});
