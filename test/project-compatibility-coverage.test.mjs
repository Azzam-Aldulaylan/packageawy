import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDeprecatedApis } from '../out/core/projectCompatibility/deprecatedApis.js';
import { analyzeImportCompatibility, analyzeRuntimeCompatibility, runProjectCompatibilityAnalyzers } from '../out/core/projectCompatibility/index.js';
import { scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { projectCompatibilityLimitations } from '../out/host/projectCompatibilityCoverage.js';
import { analyzeProjectCompatibilityMedium, appendProjectCompatibilityImportAnalysis } from '../out/host/projectCompatibility/projectCompatibilityAnalysis.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { folder, usageWorkspace } from './helpers/usage-coverage.mjs';

const identity = { packageName: 'next', currentVersion: '15.5.0', targetVersion: '16.0.0', requestId: 'coverage', sourceFingerprint: 'coverage-source' };
const reference = (specifier) => ({ specifier, kind: 'import', filePath: 'src/page.tsx', line: 1, column: 1, snippet: `import x from '${specifier}'`, usageId: 'trusted', referenceIndex: 3 });

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
    test(`${extension} ordinary script ${name} keeps main compatibility evidence`, async () => {
      const filePath = `page.${extension}`;
      const text = `<script ${attributes}>\r\n  import 'only-here/real';\r\n</script>`;
      const { platform } = usageWorkspace([[filePath, text]]);
      const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
      assert.equal(evidence.truncated, false);
      assert.deepEqual(evidence.scanLimitations ?? [], []);
      assert.deepEqual(evidence.imports.map(reference => reference.specifier), ['only-here/real']);
      assert.equal(evidence.imports[0].line, 2);
      assert.equal(evidence.imports[0].column, 11);
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
    test(`${extension} ${name} has conservative compatibility coverage`, async () => {
      const filePath = `page.${extension}`;
      const text = `${markup}\r\n<script>  import 'only-here/real';</script>`;
      const { platform } = usageWorkspace([[filePath, text]]);
      const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
      assert.equal(evidence.truncated, uncertain);
      assert.deepEqual(evidence.scanLimitations ?? [], uncertain ? ['project-source-extraction-incomplete'] : []);
      assert.deepEqual(evidence.imports.map(reference => reference.specifier), laterReadable ? ['only-here/real'] : []);
      if (laterReadable) {
        const line = text.split('\r\n').length;
        assert.equal(evidence.imports[0].line, line);
        assert.equal(evidence.imports[0].column, text.split('\r\n')[line - 1].indexOf('only-here/real') + 1);
      }
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
      test(`${extension} ${selfClosing ? 'self-closing' : 'paired'} JSON with ${name} keeps complete compatibility evidence`, async () => {
        const filePath = `page.${extension}`;
        const text = `<script type="application/ld+json" ${attributes}${selfClosing ? ' />' : '>{}</script>'}\r\n<script>import 'only-here/real';</script>`;
        const { platform } = usageWorkspace([[filePath, text]]);
        const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
        assert.equal(evidence.truncated, false);
        assert.deepEqual(evidence.scanLimitations ?? [], []);
        assert.deepEqual(evidence.imports.map(reference => reference.specifier), ['only-here/real']);
        assert.equal(evidence.imports[0].line, 2);
      });
    }
    for (const [name, attributes] of [
      ['double-quoted literal import', `data-load="import('only-here')"`],
      ['single-quoted literal require', `data-load='require("only-here")'`],
      ['set:html call', `set:html={import('only-here')}`],
      ['double-quoted expression', `data-load="{import('only-here')}"`],
      ['single-quoted expression', `data-load='{import("only-here")}'`],
    ]) {
      test(`${extension} ${selfClosing ? 'self-closing' : 'paired'} JSON with ${name} keeps compatibility evidence incomplete`, async () => {
        const filePath = `page.${extension}`;
        const block = `<script type="application/ld+json" ${attributes}${selfClosing ? ' />' : '>{}</script>'}`;
        const text = extension === 'svelte' ? `<svelte:head>${block}</svelte:head>` : block;
        const { platform } = usageWorkspace([[filePath, text]]);
        const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
        assert.equal(evidence.truncated, true);
        assert.deepEqual(evidence.scanLimitations, ['project-source-extraction-incomplete']);
        assert.deepEqual(evidence.imports, []);
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
  test(`Astro JSON self-closing boundary keeps compatibility incomplete for ${attributes}`, async () => {
    const { platform } = usageWorkspace([['page.astro', `<script type="application/ld+json" ${attributes} />`]]);
    const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
    assert.equal(evidence.truncated, true);
    assert.deepEqual(evidence.scanLimitations, ['project-source-extraction-incomplete']);
    assert.deepEqual(evidence.imports, []);
  });
}

for (const extension of ['vue', 'svelte', 'astro']) {
  for (const [name, block, expression = false] of [
    ['JSON import text', `<script type="application/json">${JSON.stringify({ text: "import('only-here')" })}</script>`],
    ['JSON require text', `<script type="application/json">${JSON.stringify({ text: "require('only-here')" })}</script>`],
    ['template expression body', `'<script type="application/json">"' + import('only-here') + '"</script>'`, true],
    ['template expression attribute', `'<script type="application/json" data-label="' + import('only-here') + '">{}</script>'`, true],
  ]) {
    test(`${extension} ${name} keeps compatibility evidence incomplete`, async () => {
      const filePath = `page.${extension}`;
      const markup = expression ? (extension === 'vue' ? `<template>{{${block}}}</template>` : `{${block}}`) : block;
      const text = `${markup}\r\n<script>  import 'only-here/real';</script>`;
      const { platform } = usageWorkspace([[filePath, text]]);
      const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
      assert.equal(evidence.truncated, true);
      assert.deepEqual(evidence.scanLimitations, ['project-source-extraction-incomplete']);
      assert.deepEqual(evidence.imports.map(reference => reference.specifier), ['only-here/real']);
      assert.equal(evidence.imports[0].line, 2);
      assert.equal(evidence.imports[0].column, text.split('\r\n')[1].indexOf('only-here/real') + 1);
    });
  }

  test(`${extension} JSON-LD preserves compatibility imports and complete source evidence`, async () => {
    const filePath = `page.${extension}`;
    const text = [
      '<script type="application/ld+json">',
      JSON.stringify({ text: `import 'only-here/fake';` }),
      '</script>',
      '<script>',
      `  import x from 'only-here/real';`,
      '</script>',
      `<script>import 'only-here/later';</script>`,
    ].join('\r\n');
    const { platform } = usageWorkspace([[filePath, text]]);
    const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
    assert.equal(evidence.scannedFileCount, 1);
    assert.equal(evidence.truncated, false);
    assert.deepEqual(evidence.scanLimitations ?? [], []);
    assert.deepEqual(evidence.imports.map(reference => reference.specifier), ['only-here/real', 'only-here/later']);
    for (const [index, line] of [[0, 5], [1, 7]]) {
      assert.equal(evidence.imports[index].filePath, filePath);
      assert.equal(evidence.imports[index].line, line);
      assert.equal(evidence.imports[index].column, text.split('\r\n')[line - 1].indexOf(evidence.imports[index].specifier) + 1);
    }
  });

  for (const [name, attributes, body = '{}'] of [
    ['invalid JSON', 'type="application/ld+json"', '{bad}'],
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
    ['JSON with lang', 'type="application/json" lang="js"'],
    ['JSON with src', 'type="application/json" src="./hidden.js"'],
  ]) {
    test(`${extension} ${name} retains the compatibility extraction limitation`, async () => {
      const filePath = `page.${extension}`;
      const { platform } = usageWorkspace([[filePath, `<script ${attributes}>${body}</script>\n<script>import 'only-here/real';</script>`]]);
      const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
      assert.equal(evidence.truncated, true);
      assert.deepEqual(evidence.scanLimitations, ['project-source-extraction-incomplete']);
      assert.deepEqual(evidence.imports.map(reference => reference.specifier), ['only-here/real']);
      assert.equal(evidence.imports[0].line, 2);
    });
  }
}

for (const selfClosing of [false, true]) {
  for (const attributes of ['', `set:html={import('only-here/attribute')}`]) {
    test(`Astro ${selfClosing ? 'self-closing' : 'paired'} JSON dynamic attributes reach compatibility limitations`, async () => {
      const text = `<script type="application/ld+json" ${attributes}${selfClosing ? '/>' : '>{} </script>'}\n<script>import 'only-here/real';</script>`;
      const { platform } = usageWorkspace([['page.astro', text]]);
      const evidence = await collectProjectCompatibilityEvidence({ platform, folder, dir: '', manifestText: '{}', packageName: 'only-here' });
      assert.equal(evidence.truncated, Boolean(attributes));
      assert.deepEqual(evidence.scanLimitations ?? [], attributes ? ['project-source-extraction-incomplete'] : []);
      assert.deepEqual(evidence.imports.map(reference => reference.specifier), selfClosing && attributes ? [] : ['only-here/real']);
      if (!selfClosing || !attributes) assert.equal(evidence.imports[0].line, 2);
    });
  }
}

test('classic root imports are verified only against a published runtime entry', () => {
  for (const [main, paths, status] of [
    ['./dist/main.js', ['dist/main.js'], 'complete'],
    [null, ['index.js'], 'complete'],
    ['dist/main', ['dist/main.js'], 'complete'],
    ['dist/main.mjs', ['dist/main.mjs'], 'complete'],
    ['dist/main.cjs', ['./dist/main.cjs'], 'complete'],
    [undefined, ['index.js'], 'partial'],
    [null, ['index.d.ts'], 'partial'],
    ['index.d.ts', ['index.d.ts'], 'partial'],
    ['index.d.mts', ['index.d.mts'], 'partial'],
    ['index.ts', ['index.ts'], 'partial'],
    ['missing.js', ['index.js'], 'partial'],
    ['dist', ['dist/index.js', 'dist/package.json'], 'partial'],
    ['../outside.js', ['../outside.js'], 'partial'],
    ['/outside.js', ['/outside.js'], 'partial'],
    ['file:main.js', ['file:main.js'], 'partial'],
  ]) {
    const result = analyzeImportCompatibility({ identity, references: [reference('next')], targetSurface: {
      packageName: 'next', version: identity.targetVersion, main,
      exports: { status: 'absent', subpaths: [] }, files: { completeness: 'complete', paths },
    } });
    assert.equal(result.status, status, `main ${main}`);
    assert.deepEqual(result.findings, [], 'unproven is not a confirmed break');
    if (status === 'partial') assert.equal(result.unavailableReason, 'root-entry-point-unverified');
  }
});

test('unknown exports cannot be bypassed by a valid classic main', () => {
  const result = analyzeImportCompatibility({ identity, references: [reference('next')], targetSurface: {
    packageName: 'next', version: identity.targetVersion, main: 'index.js',
    exports: { status: 'unknown', subpaths: [] }, files: { completeness: 'complete', paths: ['index.js'] },
  } });
  assert.equal(result.status, 'partial');
});

test('conditional imports retain a distinct reason rather than pretending environment compatibility', () => {
  const result = analyzeImportCompatibility({ identity, references: [reference('next')], targetSurface: {
    packageName: 'next', version: identity.targetVersion,
    exports: { status: 'known', subpaths: [], conditionalSubpaths: ['.'] },
  } });
  assert.equal(result.unavailableReason, 'conditional-exports-unresolved');
});

test('runtime coverage identifies active-runtime and declared-range limitations independently', () => {
  for (const [projectNodeRange, runtimeNodeVersion, expected] of [
    ['>=20.9', null, ['runtime-node-version-unknown']],
    [null, null, ['runtime-node-version-unknown', 'project-node-range-missing']],
    ['bad range', 'bad version', ['runtime-node-version-invalid', 'project-node-range-invalid']],
    [null, '22.1.0', ['project-node-range-missing']],
    ['>=20.9', '22.1.0', []],
  ]) {
    const result = analyzeRuntimeCompatibility({ identity, evidence: {
      packageName: identity.packageName, targetVersion: identity.targetVersion,
      targetNodeRange: '>=20.9', projectNodeRange, runtimeNodeVersion,
    } });
    assert.deepEqual(result.unavailableReason?.split('|') ?? [], expected);
    assert.equal(result.status, expected.length > 0 ? 'partial' : 'complete');
  }
});

test('deprecated import detector uses real imports, includes re-exports/require/dynamic, ignores text', async () => {
  const source = [
    'import Image from "next/legacy/image";',
    'export { default as LegacyImage } from "next/legacy/image";',
    'const Legacy = require("next/legacy/image");',
    'const load = () => import("next/legacy/image");',
    '// import Image from "next/legacy/image";',
    'const text = `import Image from "next/legacy/image"`;',
    'const regex = /next\\/legacy\\/image/;',
    'import ModernImage from "next/image";',
  ].join('\n');
  const references = scanSourceForImportSpecifiers(source).map((match, index) => ({ ...match, filePath: 'src/page.tsx', usageId: 'trusted', referenceIndex: index }));
  const result = analyzeDeprecatedApis({ identity, references, sourceComplete: true });
  assert.equal(result.status, 'complete');
  assert.equal(result.findings.length, 4);
  for (const finding of result.findings) {
    assert.equal(finding.ruleId, 'next-16-legacy-image-deprecated');
    assert.equal(finding.confidence, 'review');
    assert.equal(finding.source, 'framework-rule');
    assert.equal(finding.packageName, identity.packageName);
    assert.equal(finding.targetVersion, identity.targetVersion);
    assert.equal(finding.evidence[0].kind, 'source-reference');
    assert.equal(finding.evidence[0].usageId, 'trusted');
    assert.match(finding.migrationHint, /next\/image/);
  }
  assert.equal(new Set(result.findings.map(finding => finding.id)).size, 4);
  const analysis = await runProjectCompatibilityAnalyzers({ identity, analyzers: [() => result] });
  assert.equal(analysis.findings.length, 4, 'findings survive identity validation and correlation');
});

test('deprecated rule scope is explicit and does not invent support for other packages or versions', () => {
  for (const [packageName, targetVersion] of [['next', '15.5.24'], ['next', '17.0.0'], ['next', '16.0.0-canary.1'], ['next', 'bad'], ['other', '16.0.0']]) {
    const result = analyzeDeprecatedApis({ identity: { ...identity, packageName, targetVersion }, references: [reference('next/legacy/image')], sourceComplete: true });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.unavailableReason, 'deprecated-api-rules-unavailable');
    assert.deepEqual(result.findings, []);
  }
  const noMatches = analyzeDeprecatedApis({ identity, references: [reference('next/image')], sourceComplete: true });
  assert.equal(noMatches.status, 'complete');
  assert.deepEqual(noMatches.findings, []);
  const truncated = analyzeDeprecatedApis({ identity, references: [], sourceComplete: false });
  assert.equal(truncated.status, 'partial');
  assert.equal(truncated.unavailableReason, 'project-source-scan-truncated');
});

test('source coverage reasons survive medium and deep phases without losing findings or export limitations', async () => {
  const project = { scripts: {}, declaredDependencies: {}, projectNodeRange: null, imports: [reference('next/legacy/image')], ruleFiles: [], scannedFileCount: 1, truncated: true, scanLimitations: ['project-import-reference-limit'], evidenceFingerprint: 'fixture' };
  const medium = await analyzeProjectCompatibilityMedium({ identity, project, toolingPackages: [], toolingMetadataIncomplete: false });
  assert.equal(medium.analyzers.find(entry => entry.analyzerId === 'deprecated-api-compatibility').unavailableReason, 'project-import-reference-limit');
  assert.equal(medium.analyzers.find(entry => entry.analyzerId === 'project-source-scan').unavailableReason, 'project-import-reference-limit');
  for (const conditional of [false, true]) {
    const deep = await appendProjectCompatibilityImportAnalysis({ analysis: medium, project, targetSurface: {
      packageName: 'next', version: identity.targetVersion,
      exports: conditional ? { status: 'known', subpaths: [], conditionalSubpaths: ['./legacy/image'] } : { status: 'known', subpaths: ['./legacy/image'] },
    } });
    const imports = deep.analyzers.find(entry => entry.analyzerId === 'import-compatibility');
    assert.equal(imports.status, 'partial');
    assert.match(imports.unavailableReason, /project-import-reference-limit/);
    if (conditional) assert.match(imports.unavailableReason, /conditional-exports-unresolved/);
    assert.equal(deep.findings.length, medium.findings.length);
  }
});

test('Next.js rule analyzers are omitted for non-Next package reviews', async () => {
  const project = {
    scripts: {},
    declaredDependencies: { 'react-native': '^0.80.0' },
    projectNodeRange: null,
    imports: [reference('react-native-svg-transformer/react-native')],
    ruleFiles: [],
    scannedFileCount: 1,
    truncated: false,
    scanLimitations: [],
    evidenceFingerprint: 'react-native-fixture',
  };
  const analysis = await analyzeProjectCompatibilityMedium({
    identity: {
      ...identity,
      packageName: 'react-native-svg-transformer',
      currentVersion: '1.5.0',
      targetVersion: '1.5.1',
    },
    project,
    toolingPackages: [],
    toolingMetadataIncomplete: false,
  });

  assert.equal(analysis.analyzers.some((entry) => entry.analyzerId === 'next-migration-rules'), false);
  assert.equal(analysis.analyzers.some((entry) => entry.analyzerId === 'deprecated-api-compatibility'), false);
  assert.equal(analysis.analyzers.some((entry) => entry.analyzerId === 'runtime-compatibility'), true);
  assert.equal(analysis.analyzers.some((entry) => entry.analyzerId === 'project-source-scan'), true);
});

test('coverage messages are actionable, deduplicated and never echo raw failures', () => {
  const messages = projectCompatibilityLimitations('project-node-range-missing|runtime-node-version-unknown|project-node-range-missing', 'partial');
  assert.equal(messages.length, 2);
  assert.match(messages[0].reason, /engines.node/);
  assert.match(messages[1].nextStep, /Refresh alone cannot/);
  const unknown = JSON.stringify(projectCompatibilityLimitations('failed: /private/secrets auth=token', 'unavailable'));
  assert.doesNotMatch(unknown, /private|secrets|auth|token/);
  assert.match(unknown, /Next|nextStep/);
  assert.match(projectCompatibilityLimitations('runtime-node-version-unknown', 'cancelled')[0].reason, /cancelled/);
  assert.match(projectCompatibilityLimitations('__proto__', 'unavailable')[0].reason, /could not verify/);
});
