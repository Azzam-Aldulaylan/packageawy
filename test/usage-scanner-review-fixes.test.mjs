import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { hasUnreadTemplateImports, scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const specifiers = (source, file = 'page.tsx') => scanSourceForImportSpecifiers(source, file).map(match => match.specifier);

test('compact static imports and re-exports retain references and complete coverage', async () => {
  for (const quote of ['"', "'"]) {
    for (const declaration of [
      'import', 'import{value}from', 'import{}from', 'import*as ns from',
      'import value from', 'import value,{other}from', 'import value,*as ns from',
      'import type{Foo}from', 'import type*as ns from', 'import type Foo from',
      'import{type Foo,value as renamed}from',
      'export{value}from', 'export{}from', 'export*from', 'export*as ns from',
      'export type{Foo}from', 'export type*from', 'export type*as ns from',
      'export{type Foo,value as renamed}from',
    ]) {
      const source = `${declaration}${quote}only-here${quote};`;
      const parsed = ts.createSourceFile('page.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      assert.deepEqual(parsed.parseDiagnostics, [], source);
      assert.deepEqual(scanSourceForImportSpecifiers(source, 'page.ts'), [{
        packageName: 'only-here', specifier: 'only-here', kind: 'import',
        line: 1, column: source.indexOf('only-here') + 1, snippet: source,
      }], source);
      assert.equal(hasUnreadTemplateImports(source, 'page.ts'), false, source);
      const usage = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
      assert.equal(usage.references.length, 1, source);
      assert.equal(usage.truncated, false, source);
    }
  }
});

test('compact unreadable re-exports cannot certify complete coverage', async () => {
  for (const declaration of ['export{value}from', 'export*from', 'export type{Foo}from', 'export type*from']) {
    const source = declaration + String.raw`"\157nly-here";`;
    assert.deepEqual(specifiers(source, 'page.ts'), [], source);
    await incomplete(source, 'page.ts');
  }
  for (const declaration of ['export{', 'export type{']) {
    await incomplete(declaration + 'value,'.repeat(1000) + '}from"only-here";', 'page.ts');
  }
});

test('compact loader calls retain static references and complete coverage', () => {
  for (const callee of ['import', 'require', 'require.resolve', 'require.resolve.paths', 'import.meta.resolve', 'require?.', 'require<string>']) {
    for (const quote of ['"', "'", '`']) {
      const source = `${callee}(${quote}only-here${quote});`;
      assert.deepEqual(specifiers(source, 'page.ts'), ['only-here'], source);
      assert.equal(hasUnreadTemplateImports(source, 'page.ts'), false, source);
    }
  }
});

test('compact declarations keep keyword boundaries', () => {
  for (const source of [
    'myimport"only-here";', 'imported"only-here";',
    'myexport{value}from"only-here";', 'exported{value}from"only-here";',
    'export typeFoo{value}from"only-here";', 'export{value}fromage"only-here";',
    'import{value}fromage"only-here";',
  ]) assert.deepEqual(specifiers(source, 'page.ts'), [], source);
  for (const source of ['export{value};', 'export type{Foo};']) {
    assert.deepEqual(specifiers(source, 'page.ts'), [], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.ts'), false, source);
  }
});

async function incomplete(source, file = 'page.tsx') {
  assert.equal(hasUnreadTemplateImports(source, file), true, source);
  const usage = (await usageWorkspace([[file, source]]).analyze()).get('only-here');
  assert.equal(usage.truncated, true, source);
  assert.equal(assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown', source);
}

const parameters = [
  '<T ,>', '< T , >', '<T/* , > */ ,>', '<T // >\n ,>',
  '<const T,>', '<const /* > */ T ,>', '<T extends unknown>',
  '<T /* > */ extends /* , */ unknown,>', '<const T extends readonlyType,>',
  '<T extends ns.Type[], U = unknown,>', '<T, U,>',
  '<T extends { id: string }>', '<T extends { id: string }[]>',
  '<const T extends Map<string, number>>', '<T = { id: string },>',
  '<T extends Map<string, Array<{ id: string }>> = Map<string, { id: string }[]>>',
  '<T extends { value: ">"; nested: { id: string }; items: [string, number] }>',
  '<T /* > */ extends /* < */ { id: string } = { id: string }>',
];

test('TSX type parameters cannot hide imports behind comment closing tags', async () => {
  for (const params of parameters) {
    for (const wrap of [
      expression => `const f = ${expression};`,
      expression => `consume(${expression});`,
      expression => `consume(0, ${expression});`,
      expression => `function make() { return ${expression}; }`,
    ]) {
      const source = wrap(`${params}(x: T) => require("only-here")`) + ' // </T>\n';
      const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      assert.deepEqual(parsed.parseDiagnostics, [], source);
      assert.deepEqual(specifiers(source), ['only-here'], source);
      assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
      const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
      assert.equal(usage.references.length, 1, source);
      assert.equal(usage.truncated, false, source);
    }
  }
});

test('TSX generic prefixes cut off before or inside extends keep coverage incomplete', async () => {
  for (const visible of ['', 'e', 'ex', 'ext', 'exte', 'exten', 'extend', 'extends']) {
    const source = 'const f=<T' + ' '.repeat(4096 - 2 - visible.length) + 'extends {}>(x:T)=>require("only-here"); // </T>';
    await incomplete(source);
  }
});

test('lang="tsx" component scripts use the same generic classification', async () => {
  for (const extension of ['vue', 'svelte', 'astro']) {
    for (const params of parameters) {
      const source = `<script lang="tsx">\nconst f = ${params}(x: T) => import("only-here"); // </T>\n</script>`;
      const usage = (await usageWorkspace([[`page.${extension}`, source]]).analyze()).get('only-here');
      assert.equal(usage.references.length, 1, source);
      assert.equal(usage.truncated, false, source);
    }
  }
});

test('ambiguous angle starts and unbalanced generic constraints stay incomplete', async () => {
  for (const angle of ['<T,', '<T @>', '<T extends { value: string >', '<const T extends Map<string, number>']) {
    for (const wrap of [s => `const f = ${s}`, s => `f(${s}`, s => `f(0, ${s}`, s => `function f() { return ${s}`]) {
      await incomplete(wrap(angle + '(x: T) => require("only-here"); // </T>'));
    }
  }
});

test('unclosed JSX and dynamic calls in JSX expressions stay incomplete', async () => {
  for (const source of [
    'const f = <T attr>(x: T) => require("only-here"); // unclosed',
    'const view = <div>/* unclosed */;',
    'const view = <div>/* </div> */;',
    'const view = <div>{/* </div> */ require(name)}</div>;',
  ]) await incomplete(source);
});

test('ordinary JSX text, tags and expressions keep complete coverage', () => {
  for (const source of [
    '<div>(require("fake"))</div>;',
    '<T prop="value">require("fake")</T>;',
    '<div>{/* </div> */ require("only-here")}</div>;',
    '<div>{// </div>\nimport("only-here")}</div>;',
    '<Component href="https://example.com" />;',
    'const view = <div>/* text */</div>;',
    'const view = <div>// </div>\n;',
    'const view = <T attr>require("fake"); // </T>;',
  ]) {
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    assert.deepEqual(specifiers(source), source.includes('only-here') ? ['only-here'] : [], source);
  }
});

test('slashes and JavaScript-looking characters in JSX text preserve the following import', async () => {
  for (const markup of [
    '<p>https://example.com</p>', '<p>// text /* text */ / path</p>',
    '<p>"quotes" `ticks` \\ escapes require("fake")</p>',
    '<><p>https://example.com</p><p>/* text */</p></>',
    '<p>https://example.com{require("also-here")}</p>',
  ]) {
    const source = `const view = ${markup};\nimport "only-here";`;
    assert.deepEqual(specifiers(source), markup.includes('also-here') ? ['also-here', 'only-here'] : ['only-here'], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1, source);
    assert.equal(usage.references[0].line, 2, source);
    assert.equal(usage.truncated, false, source);
  }
});

test('loader names used as property keys, bare members and shorthand keep complete coverage', async () => {
  for (const expression of [
    'const options = { require: true };', 'const options = { import: true };',
    'const options = { other: 1, require: true, import: false };',
    'const options = { require };', 'const options = { other: 1, require, last: 2 };',
    'const options = { nested: { require } };', 'consume({ require });',
    'function options() { return { require }; }',
    'options.require; options.import;', 'options?.require; options?.import;',
    'options.require = true; options.import = false;',
    'options.require.enabled; options.import.enabled;',
    'const options = { require: require("also-here"), import: import("third") };',
    'const options = { /* key */ require /* value */ : true };',
    'const options = { other: "}", /* shorthand */ require };',
  ]) {
    const source = `${expression}\nimport "only-here";`;
    assert.deepEqual(specifiers(source), expression.includes('also-here') ? ['also-here', 'third', 'only-here'] : ['only-here'], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1, source);
    assert.equal(usage.truncated, false, source);
  }
});

test('property exemptions retain blocking for computed access, aliases and dynamic loader calls', async () => {
  for (const expression of [
    'require["resolve"](name)', 'require?.[key](name)', 'module["require"](name)',
    'module.require[key](name)', 'module.require(name)', 'window.import(name)',
    'const load = require;', 'consume(0, require, 1)', 'consume(...require)',
    'const load = module.require;', 'const load = globalThis?.require;',
    'const options = { ...require };', 'const options = { load: require };',
    'const options = { require: require(name) };',
    'const options = { import: import(name) };',
  ]) {
    await incomplete(expression);
    const source = `${expression};\nimport "only-here";`;
    assert.deepEqual(specifiers(source), ['only-here'], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), true, source);
    const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1, source);
    assert.equal(usage.truncated, true, source);
  }
});

const callees = ['require', 'import', 'require.resolve', 'require.resolve.paths', 'import.meta.resolve', 'require?.', 'require<string>'];
const escapedNames = [String.raw`\x6fnly-here`, String.raw`\u006fnly-here`, String.raw`\u{6f}nly-here`, String.raw`\u{0000006f}nly-here`, String.raw`\only-here`, 'only-\\\nhere', 'only-\\\r\nhere'];

test('escaped literal specifiers are decoded before matching with raw source coordinates', async () => {
  for (const raw of escapedNames) {
    for (const callee of callees) {
      for (const quote of ['"', "'", '`']) {
        const source = 'const x = `${' + callee + '(' + quote + raw + quote + ')}`;';
        assert.deepEqual(specifiers(source), ['only-here'], source);
        assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
        const match = scanSourceForImportSpecifiers(source, 'page.tsx')[0];
        assert.equal(match.line, 1, source);
        assert.equal(match.column, source.indexOf(raw) + 1, source);
      }
    }
    const source = 'const x = `${import("' + raw + '")}`;';
    const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1, source);
    assert.equal(usage.truncated, false, source);
  }
});

test('static imports and re-exports decode escaped specifiers too', () => {
  for (const raw of escapedNames) {
    for (const declaration of [q => `import ${q}`, q => `import x from ${q}`, q => `export { x } from ${q}`, q => `export * from ${q}`]) {
      const source = declaration('"' + raw + '"') + ';';
      assert.deepEqual(specifiers(source), ['only-here'], source);
      assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    }
  }
  assert.deepEqual(specifiers(String.raw`require("@scope\u002fpkg\x2fsub");`), ['@scope/pkg/sub']);
  assert.deepEqual(specifiers(String.raw`require("only\n\r\t\b\f\v\0\'\"\x2fhere");`), ['only\n\r\t\b\f\v\0\'"/here']);
  assert.deepEqual(specifiers('require(`only\\${here}`)'), ['only${here}']);
});

test('uncertain escapes cannot certify complete coverage', async () => {
  for (const raw of [String.raw`\157nly-here`, String.raw`\8nly-here`, String.raw`\01nly-here`, String.raw`\x6only-here`, String.raw`\u{110000}`, String.raw`\u{xyz}`, String.raw`\u00zz`]) {
    for (const wrap of [q => `require(${q})`, q => '`${import(' + q + ')}`', q => `import x from ${q}`, q => `export * from ${q}`]) {
      const source = wrap('"' + raw + '"');
      assert.deepEqual(specifiers(source), [], source);
      await incomplete(source);
    }
  }
});

test('optional and simple typed loader calls are static references', async () => {
  for (const callee of ['require?.', 'require<string>', 'require /* a */ ?. /* b */', 'require /* a */ < /* b */ string /* c */ >', 'require<ns.Type[], unknown>?.', 'require.resolve?.', 'import.meta.resolve?.']) {
    const source = `${callee}("only-here");`;
    assert.deepEqual(specifiers(source), ['only-here'], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1, source);
    assert.equal(usage.truncated, false, source);
  }
});

test('unrecognized loader shapes keep coverage incomplete', async () => {
  for (const callee of ['require?.', 'require<string>', 'require["resolve"]', 'require?.resolve', 'require.resolve.paths?.call', 'require!', 'require<Map<string, number>>', 'require<{ value: string }>', '(require)', 'import.source', 'import.defer', 'import.meta["resolve"]', 'import.meta.resolve<string | number>']) {
    await incomplete(`${callee}(name);`, 'page.ts');
  }
});

test('bounded static matching preserves multiline declarations and marks oversized ones incomplete', async () => {
  for (const head of ['import {', 'export {']) {
    const source = `${head}\n alpha,\n beta,\n} from "only-here";`;
    assert.deepEqual(specifiers(source), ['only-here'], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    await incomplete(head + '\nitem,\n'.repeat(1000) + '} from "only-here";');
  }
  await incomplete('require(' + ' '.repeat(5000) + '"only-here");');
  await incomplete('export ' + ' '.repeat(5000) + '* from "only-here";');
  await incomplete('export type ' + ' '.repeat(5000) + '{ X } from "only-here";');
});

test('semicolonless export declarations scan in linear time', () => {
  const source = Array.from({ length: 32_000 }, (_, i) => `export const value${i} = ${i}`).join('\n') + '\nimport "only-here";';
  const start = performance.now();
  assert.deepEqual(specifiers(source, 'page.ts'), ['only-here']);
  assert.equal(hasUnreadTemplateImports(source, 'page.ts'), false);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, `32,000 exports took ${elapsed.toFixed(0)} ms (limit 5 s)`);
});
