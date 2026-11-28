import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { buildUnusedFinding } from '../out/core/usage/unused.js';
import { coverageExplanation, extractSourceCoverage, SOURCE_IMPORT_COVERAGE_REASON } from '../out/core/usage/sourceCoverage.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const readable = [
  ['Vue JSX script', 'page.vue', '<script lang="jsx">const view = <div>{require("only-here")}</div>;</script>', 1],
  ['import interpolation', 'page.ts', 'const value = `${import("only-here")}`;', 1],
  ['nested interpolated template', 'page.ts', 'const value = `${`hello ${require("only-here")}`}`;', 1],
  ['nested template interpolation', 'page.ts', 'const value = `${foo(`hello`), require("only-here")}`;', 1],
  ['require interpolation', 'page.ts', 'const value = `${require("only-here")}`;', 1],
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

for (const extension of ['vue', 'astro']) {
  for (const [name, attributes] of [
    ['nested define:vars', `define:vars={{ config: { theme: 'dark' } }}`],
    ['is:inline', 'is:inline'],
    ['double-quoted attribute text', `is:inline data-example="import('fake')"`],
    ['single-quoted attribute text', `data-example='require("fake")'`],
    ['define:vars call', `define:vars={{ config: import('fake') }}`],
    ['set:html call', `set:html={import('fake')}`],
    ['bound type', ':type="scriptType"'],
    ['spread attributes', '{...attributes}'],
  ]) {
    test(`${extension} ordinary script ${name} keeps main coverage`, async () => {
      const file = `page.${extension}`;
      const text = `<script ${attributes}>\r\n  import 'only-here';\r\n</script>`;
      assert.deepEqual(extractSourceCoverage(file, text).reasons, []);
      const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'fake', 'unused'] });
      const used = results.get('only-here');
      assert.equal(used.references.length, 1);
      assert.equal(used.references[0].line, 2);
      assert.equal(used.references[0].column, 11);
      assert.equal(buildUnusedFinding('only-here', used), null);
      assert.equal(results.get('fake').references.length, 0);
      const unused = results.get('unused');
      assert.equal(unused.truncated, false);
      assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'low-risk');
    });
  }
}

for (const extension of ['vue', 'svelte', 'astro']) {
  const json = '<script type="application/ld+json">{}</script>';
  const expression = value => extension === 'vue' ? `<template>{{${value}}}</template>` : `{${value}}`;
  for (const [name, markup, uncertain, laterReadable = true] of [
    ['string hiding a static import', `${expression(`'<script type="application/json">"'`)}<script>import 'only-here'; //"</script>`, true],
    ['string hiding a computed require', expression(`'<script type="application/json">"' + module['require']('only-here') + '"</script>'`), true],
    ['string brace that rebalances before a fake tag', expression(`'}<script type="application/json">"' + module['require']('only-here') + '"</script>{'`), true],
    ['unbalanced brace after a JSON block', `${json}<p>{</p>`, true],
    ['stray closing brace before a tag', `}${json}`, true],
    ['recovered depth after a stray closing brace', `}{${json}`, true],
    ['conditional expression', expression(`cond && ${json}`), true],
    ['attribute expression', `<div title={cond && ${json}}></div>`, true],
    ['balanced conditional block', `{#if ready}${json}{/if}`, false],
    ['earlier executable and style braces', `<script>const text = "}";</script><style>/* { */</style>${json}`, false],
    ['earlier JSON braces', `<script type="application/json">"}"</script>${json}`, false],
    ['earlier comment braces', `<!-- } -->${json}`, false],
    ['raw opening script in JSON', `<script type="application/json">${JSON.stringify({ text: '<ScRiPt' })}</script>`, true],
    ['raw closing script in JSON', `<script type="application/json">${JSON.stringify({ text: '</ScRiPt>' })}</script>`, true],
    ['HTML closing tag in a JSON string', `<script type="application/json">${JSON.stringify({ text: '<p>Follow our guide.</p>' })}</script>`, false],
    ['comment opener in JSON', `<script type="application/json">${JSON.stringify({ text: '<!-- note' })}</script>`, true],
    ['comment braces around a fake tag', extension === 'vue'
      ? `<template>{{(/* } } */ '<script type="application/json">"' + module['require']('only-here') + '"</script>' /* { { */)}}</template>`
      : `{(/* } */ '<script type="application/json">"' + module['require']('only-here') + '"</script>' /* { */)}`, true],
    ['line comment brace before a fake tag', extension === 'vue'
      ? `<template>{{ value // } }\r\n + '<script type="application/json">"' + module['require']('only-here') + '"</script>' }}</template>`
      : `{ value // }\r\n + '<script type="application/json">"' + module['require']('only-here') + '"</script>' }`, true],
    ['escaped script text in JSON', String.raw`<script type="application/json">{"text":"<\/script><\u0073cript"}</script>`, false],
    ...(extension === 'astro' ? [
      ['self-closing JSON in an expression', '{cond && <script type="application/ld+json" />}', true, false],
      ['self-closing JSON after negative depth', '}{<script type="application/ld+json" />', true, false],
      ['frontmatter braces before JSON', `---\r\nconst text = "}";\r\n---\r\n${json}`, false],
    ] : []),
  ]) {
    test(`${extension} ${name} has conservative removal coverage`, async () => {
      const file = `page.${extension}`;
      const text = `${markup}\r\n<script>  import 'known';</script>`;
      const reasons = extractSourceCoverage(file, text).reasons;
      if (uncertain) assert.ok(reasons.includes('script blocks with unsupported languages or types'));
      else assert.deepEqual(reasons, []);
      const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'known'] });
      const known = results.get('known');
      assert.equal(known.references.length, laterReadable ? 1 : 0);
      if (laterReadable) {
        const line = text.split('\r\n').length;
        assert.equal(known.references[0].line, line);
        assert.equal(known.references[0].column, text.split('\r\n')[line - 1].indexOf('known') + 1);
      }
      const result = results.get('only-here');
      assert.equal(result.references.length, 0);
      assert.equal(result.truncated, uncertain);
      if (uncertain) assert.ok(result.coverageReasons.includes('script blocks with unsupported languages or types'));
      assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, uncertain ? 'unknown' : 'low-risk');
    });
  }
}

for (const extension of ['vue', 'svelte', 'astro']) {
  for (const selfClosing of extension === 'astro' ? [false, true] : [false]) {
    for (const [name, attributes] of [
      ['plain attributes', 'data-label=example hidden'],
      ['double-quoted text', `data-label="/> > literal \`literal\` text"`],
      ['single-quoted text', `data-label='/> > literal \`literal\` text'`],
    ]) {
      test(`${extension} ${selfClosing ? 'self-closing' : 'paired'} JSON with ${name} stays inert`, async () => {
        const file = `page.${extension}`;
        const text = `<script type="application/ld+json" ${attributes}${selfClosing ? ' />' : '>{}</script>'}\r\n<script>import 'only-here';</script>`;
        assert.deepEqual(extractSourceCoverage(file, text).reasons, []);
        const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'fake', 'unused'] });
        assert.equal(results.get('only-here').references[0].line, 2);
        assert.equal(results.get('fake').references.length, 0);
        const unused = results.get('unused');
        assert.equal(unused.truncated, false);
        assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'low-risk');
      });
    }
    for (const [name, attributes] of [
      ['double-quoted literal import', `data-load="import('only-here')"`],
      ['single-quoted literal require', `data-load='require("only-here")'`],
      ['set:html call', `set:html={import('only-here')}`],
      ['double-quoted expression', `data-load="{import('only-here')}"`],
      ['single-quoted expression', `data-load='{import("only-here")}'`],
    ]) {
      test(`${extension} ${selfClosing ? 'self-closing' : 'paired'} JSON with ${name} keeps removal coverage uncertain`, async () => {
        const file = `page.${extension}`;
        const block = `<script type="application/ld+json" ${attributes}${selfClosing ? ' />' : '>{}</script>'}`;
        const text = extension === 'svelte' ? `<svelte:head>${block}</svelte:head>` : block;
        const reason = selfClosing ? 'component blocks that could not be extracted' : 'script blocks with unsupported languages or types';
        const reasons = extractSourceCoverage(file, text).reasons;
        assert.ok(reasons.includes(reason));
        assert.ok(reasons.includes('script blocks with unsupported languages or types'));
        assert.ok(reasons.includes('import() calls in component markup'));
        const result = (await usageWorkspace([[file, text]]).analyze()).get('only-here');
        assert.equal(result.references.length, 0);
        assert.equal(result.truncated, true);
        assert.ok(result.coverageReasons.includes(reason));
        assert.ok(result.coverageReasons.includes('import() calls in component markup'));
        assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
      });
    }
  }
}

for (const attributes of [
  'data-label={`/>`} src="./hidden.ts"',
  'data-label={`/>`} lang="ts"',
  'data-label={`/>`} {...attributes}',
  'data-label={"/>"} src="./hidden.ts"',
  `data-label={'/>'} lang="ts"`,
  'data-label={`>`} src="./hidden.ts"',
  'data-label={`/>`}',
]) {
  test(`Astro JSON self-closing boundary stays uncertain for ${attributes}`, async () => {
    const text = `<script type="application/ld+json" ${attributes} />`;
    assert.ok(extractSourceCoverage('page.astro', text).reasons.length > 0);
    const unused = (await usageWorkspace([['page.astro', text]]).analyze()).get('only-here');
    assert.equal(unused.references.length, 0);
    assert.equal(unused.truncated, true);
    assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
  });
}

for (const extension of ['vue', 'svelte', 'astro']) {
  for (const [name, block, expression = false] of [
    ['JSON import text', `<script type="application/json">${JSON.stringify({ text: "import('only-here')" })}</script>`],
    ['JSON require text', `<script type="application/json">${JSON.stringify({ text: "require('only-here')" })}</script>`],
    ['template expression body', `'<script type="application/json">"' + import('only-here') + '"</script>'`, true],
    ['template expression attribute', `'<script type="application/json" data-label="' + import('only-here') + '">{}</script>'`, true],
  ]) {
    test(`${extension} ${name} retains both removal coverage reasons`, async () => {
      const file = `page.${extension}`;
      const markup = expression ? (extension === 'vue' ? `<template>{{${block}}}</template>` : `{${block}}`) : block;
      const text = `${markup}\r\n<script>  import 'known';</script>`;
      const reasons = ['script blocks with unsupported languages or types', 'import() calls in component markup'];
      assert.deepEqual(extractSourceCoverage(file, text).reasons, reasons);
      const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'known'] });
      const known = results.get('known');
      assert.equal(known.references.length, 1);
      assert.equal(known.references[0].line, 2);
      assert.equal(known.references[0].column, text.split('\r\n')[1].indexOf('known') + 1);
      const result = results.get('only-here');
      assert.equal(result.references.length, 0);
      assert.equal(result.truncated, true);
      for (const reason of reasons) assert.ok(result.coverageReasons.includes(reason));
      assert.equal(buildUnusedFinding('only-here', result).confidence, 'low');
      const assessment = assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] });
      assert.equal(assessment.status, 'unknown');
      for (const reason of reasons) assert.ok(assessment.evidence[0].summary.includes(reason));
    });
  }

  for (const type of ['application/json', 'application/ld+json', 'application/vnd.packageawy+json', "application/x.!#$%&'*+^_`|~-+json"]) {
    test(`${extension} ${type} data leaves later imports and removal coverage intact`, async () => {
      const file = `page.${extension}`;
      const text = [
        `<script type="${type}">`,
        JSON.stringify({ text: `import 'fake';`, url: 'https://example.com' }),
        '</script>',
        '<script>',
        `  import x from 'only-here';`,
        '</script>',
        '<script>',
        `  import 'later';`,
        '</script>',
      ].join('\r\n');
      assert.deepEqual(extractSourceCoverage(file, text).reasons, []);
      const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['only-here', 'later', 'fake', 'unused'] });
      for (const [name, line] of [['only-here', 5], ['later', 8]]) {
        const result = results.get(name);
        assert.deepEqual(result.coverageReasons ?? [], []);
        assert.equal(result.truncated, false);
        assert.equal(result.references.length, 1);
        assert.equal(result.references[0].filePath, file);
        assert.equal(result.references[0].line, line);
        assert.equal(result.references[0].column, text.split('\r\n')[line - 1].indexOf(name) + 1);
        assert.equal(buildUnusedFinding(name, result), null);
      }
      for (const name of ['fake', 'unused']) {
        const result = results.get(name);
        assert.equal(result.truncated, false);
        assert.equal(result.references.length, 0);
        assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'low-risk');
      }
    });
  }

  for (const [name, attributes, body] of [
    ['empty JSON', 'type="application/json"', ' \r\n '],
    ['JSON primitive', 'type="application/json"', ' false '],
    ['unquoted JSON type', 'type=application/json', '[]'],
  ]) {
    test(`${extension} ${name} is inert`, async () => {
      const result = (await usageWorkspace([[`page.${extension}`, `<script ${attributes}>${body}</script>`]]).analyze()).get('only-here');
      assert.equal(result.truncated, false);
      assert.equal(result.references.length, 0);
    });
  }

  test(`${extension} module scripts still scan executable imports`, async () => {
    const result = (await usageWorkspace([[`page.${extension}`, `<script type="module">import 'only-here';</script>`]]).analyze()).get('only-here');
    assert.equal(result.truncated, false);
    assert.equal(result.references.length, 1);
  });

  for (const [name, attributes, body = '{}'] of [
    ['invalid JSON', 'type="application/ld+json"', '{bad}'],
    ['JSON comments', 'type="application/json"', '{/* comment */}'],
    ['unknown type', 'type="application/unknown"'],
    ['template type', 'type="text/template"'],
    ['importmap', 'type="importmap"'],
    ['dynamic type', 'type={scriptType}'],
    ['bound JSON type', 'type="application/json" :type="scriptType"'],
    ['JSON with bound data', 'type="application/json" :data-label="label"'],
    ['JSON with v-bind', 'type="application/json" v-bind="attributes"'],
    ['JSON with v-bind data', 'type="application/json" v-bind:data-label="label"'],
    ['JSON with expression', 'type="application/json" data-label={label}'],
    ['JSON with nested expression', 'type="application/json" define:vars={{ config: { theme: \'dark\' } }}'],
    ['JSON with template literal', 'type="application/json" data-label=`label`'],
    ['JSON with brace template', 'type="application/json" data-label={`label`}'],
    ['longhand bound JSON type', 'type="application/json" v-bind:type="scriptType"'],
    ['spread JSON attributes', 'type="application/json" {...attributes}'],
    ['JSON with lang', 'type="application/json" lang="js"'],
    ['JSON with boolean lang', 'type="application/json" lang'],
    ['JSON with src', 'type="application/json" src="./hidden.js"'],
    ['JSON with bound src', 'type="application/json" :src="scriptSrc"'],
    ['JSON type with parameters', 'type="application/json; charset=utf-8"'],
    ['empty MIME subtype', 'type="application/+json"'],
    ['invalid MIME subtype', 'type="application/not:a+json"'],
  ]) {
    test(`${extension} ${name} keeps removal coverage uncertain`, async () => {
      const file = `page.${extension}`;
      const text = `<script ${attributes}>${body}</script>\n<script>import 'known';</script>`;
      assert.deepEqual(extractSourceCoverage(file, text).reasons, ['script blocks with unsupported languages or types']);
      const results = await usageWorkspace([[file, text]]).analyze({ packageNames: ['known', 'unused'] });
      assert.equal(results.get('known').references.length, 1);
      const result = results.get('unused');
      assert.equal(result.references.length, 0);
      assert.equal(result.truncated, true);
      assert.ok(result.coverageReasons.includes('script blocks with unsupported languages or types'));
      assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
    });
  }
}

for (const selfClosing of [false, true]) {
  for (const attributes of ['', `set:html={import('fake')}`]) {
    test(`Astro ${selfClosing ? 'self-closing' : 'paired'} JSON accepts only static attributes`, async () => {
      const text = `<script type="application/ld+json" ${attributes}${selfClosing ? '/>' : '>{} </script>'}\n<script>import 'only-here';</script>`;
      const reasons = attributes ? ['script blocks with unsupported languages or types', 'import() calls in component markup'] : [];
      assert.deepEqual(extractSourceCoverage('page.astro', text).reasons, reasons);
      const results = await usageWorkspace([['page.astro', text]]).analyze({ packageNames: ['only-here', 'fake', 'unused'] });
      assert.equal(results.get('only-here').references.length, selfClosing && attributes ? 0 : 1);
      if (!selfClosing || !attributes) assert.equal(results.get('only-here').references[0].line, 2);
      assert.equal(results.get('fake').references.length, 0);
      const result = results.get('unused');
      assert.equal(result.truncated, Boolean(attributes));
      assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, attributes ? 'unknown' : 'low-risk');
    });
  }
}

for (const [file, attributes] of [
  ['page.vue', 'type="application/ld+json"'],
  ['page.svelte', 'type="application/ld+json"'],
  ['page.astro', 'type="module"'],
  ['page.astro', 'type="importmap"'],
  ['page.astro', 'type={scriptType}'],
  ['page.astro', 'type="application/json" lang="js"'],
  ['page.astro', 'type="application/json" src="./hidden.js"'],
]) {
  test(`${file} self-closing script ${attributes} keeps its extraction limitation`, () => {
    assert.ok(extractSourceCoverage(file, `<script ${attributes} />`).reasons.includes('component blocks that could not be extracted'));
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
  ['interpolated dynamic import', 'page.ts', 'const value = import(`${name}`);', 'could not fully check'],
  ['unresolved require', 'page.ts', 'const value = require(name);', 'could not fully check'],
  ['dynamic call in JSX', 'page.tsx', '<div>{import(`${name}`)}</div>', 'could not fully check'],
  ['unclosed JSX', 'page.tsx', '<div title="broken', 'could not fully check'],
  ['unclosed JSX expression', 'page.jsx', '<div>{require(name)', 'could not fully check'],
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
];
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
  assert.ok(result.coverageReasons.some(reason => reason.includes('@use target in .storybook/theme.scss')));
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

for (const extension of ['jsx', 'tsx', 'js', 'mjs', 'cjs']) {
  test(`JSX in ${extension} keeps removal coverage complete and every executable reference`, async () => {
    const text = [
      ...(extension === 'tsx' ? [
        'const identity = <T,>(x: T) => x;',
        'const constrained = <T extends unknown>(x: T) => x;',
      ] : []),
      'const view = <>',
      `  <div title="require('fake') / >">`,
      '    {ready && <Child {...require("spread")} />}',
      '    <Child className={`${require("attribute")}`} />',
      '    {`${import("child")}`}',
      `    {/["'{}<>]/.test(value) ? <span /> : <span>{require("nested")}</span>}`,
      '  </div>',
      '</>;',
      'const division = <Child /> / 2;',
      'const comparison = count < 2 ? <Child /> : <Child />;',
      'const after = require("after");',
    ].join('\n');
    const packages = ['spread', 'attribute', 'child', 'nested', 'after', 'fake', 'unused'];
    const results = await usageWorkspace([[`page.${extension}`, text]]).analyze({ packageNames: packages });
    for (const name of packages.slice(0, 5)) {
      const result = results.get(name);
      assert.equal(result.truncated, false);
      assert.equal(result.references.length, 1, name);
      const reference = result.references[0];
      assert.equal(text.split('\n')[reference.line - 1].slice(reference.column - 1, reference.column - 1 + name.length), name);
      assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'review');
    }
    assert.equal(results.get('fake').references.length, 0);
    assert.equal(results.get('unused').truncated, false);
    assert.equal(assessRemoval({ usage: results.get('unused'), peerRequirements: [], stillRequiredBy: [] }).status, 'low-risk');
  });
}

test('unresolved imports hold back every zero-reference candidate while keeping known references', async () => {
  const results = await usageWorkspace([['page.tsx', '<div>{require("known")}{import(`${name}`)}</div>']])
    .analyze({ packageNames: ['known', 'unused'] });
  assert.equal(results.get('known').references.length, 1);
  assert.equal(results.get('unused').truncated, true);
  assert.deepEqual(results.get('unused').coverageReasons, [SOURCE_IMPORT_COVERAGE_REASON]);
  const assessment = assessRemoval({ usage: results.get('unused'), peerRequirements: [], stillRequiredBy: [] });
  assert.equal(assessment.status, 'unknown');
  assert.equal(assessment.evidence[0].summary, "Automatic removals are unavailable because Packageawy could not fully check this project's source code for package imports.");
});

test('coverage copy uses plain sentences and keeps other coverage details', () => {
  assert.equal(coverageExplanation([SOURCE_IMPORT_COVERAGE_REASON]), SOURCE_IMPORT_COVERAGE_REASON);
  assert.equal(coverageExplanation([SOURCE_IMPORT_COVERAGE_REASON, '.mdx files']),
    `${SOURCE_IMPORT_COVERAGE_REASON} Coverage is incomplete for .mdx files.`);
  assert.equal(coverageExplanation(['.mdx files', 'stylesheets with @import, @use or @plugin']),
    `${SOURCE_IMPORT_COVERAGE_REASON} Coverage is incomplete for .mdx files, stylesheets with @import, @use or @plugin.`);
});
