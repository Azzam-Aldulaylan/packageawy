/**
 * Static import/require/dynamic-import detection: src/core/usage/importScan.ts.
 * The interesting cases are the false-positive protections: comments and
 * plain string literals must never count as usage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasUnreadTemplateImports, scanSourceForImportSpecifiers, scanSourceForImports } from '../out/core/usage/importScan.js';
import { importedPackageName, specifierMatchesPackage } from '../out/core/usage/packageNameMatch.js';

function names(matches) {
  return matches.map((m) => m.packageName);
}

test('import x from "foo" is detected', () => {
  const matches = scanSourceForImports(`import x from 'foo';`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'import');
  assert.equal(matches[0].line, 1);
});

test('import { x } from "foo" is detected', () => {
  assert.deepEqual(names(scanSourceForImports(`import { x, y } from 'foo';`)), ['foo']);
});

test('side-effect import "foo" is detected', () => {
  const matches = scanSourceForImports(`import 'foo';`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'import');
});

test('require("foo") is detected', () => {
  const matches = scanSourceForImports(`const x = require('foo');`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'require');
});

test('require.resolve detects a static package subpath in Metro config formatting', () => {
  const source = [
    'const config = {',
    '  transformer: {',
    '    babelTransformerPath: require.resolve(',
    "      'react-native-svg-transformer/react-native',",
    '    ),',
    '  },',
    '};',
  ].join('\n');

  const matches = scanSourceForImportSpecifiers(source);
  assert.deepEqual(matches, [{
    packageName: 'react-native-svg-transformer',
    specifier: 'react-native-svg-transformer/react-native',
    line: 4,
    column: 8,
    snippet: "'react-native-svg-transformer/react-native',",
    kind: 'require',
  }]);
});

test('require.resolve preserves scoped base-package normalization', () => {
  const matches = scanSourceForImportSpecifiers(
    "const configPath = require.resolve('@scope/tool/config/defaults');"
  );
  assert.deepEqual(
    matches.map(({ packageName, specifier, kind }) => ({ packageName, specifier, kind })),
    [{ packageName: '@scope/tool', specifier: '@scope/tool/config/defaults', kind: 'require' }]
  );
});

test('require.resolve ignores comments, documentation strings, and dynamic expressions', () => {
  const source = [
    "// require.resolve('comment-only')",
    "/* require.resolve('block-comment-only') */",
    `const docs = "require.resolve('documentation-only')";`,
    "const dynamic = require.resolve(packageName);",
    'const interpolated = require.resolve(`plugin-${name}`);',
  ].join('\n');

  assert.deepEqual(scanSourceForImportSpecifiers(source), []);
});

test('dynamic import("foo") is detected', () => {
  const matches = scanSourceForImports(`const x = await import('foo');`);
  assert.deepEqual(names(matches), ['foo']);
  assert.equal(matches[0].kind, 'dynamic-import');
});

test('detailed import matches retain exact literal subpaths, including static template literals', () => {
  const matches = scanSourceForImportSpecifiers([
    `import x from 'next/public';`,
    'const y = import(`@scope/pkg/feature`);',
  ].join('\n'));
  assert.deepEqual(matches.map(({ packageName, specifier, kind }) => ({ packageName, specifier, kind })), [
    { packageName: 'next', specifier: 'next/public', kind: 'import' },
    { packageName: '@scope/pkg', specifier: '@scope/pkg/feature', kind: 'dynamic-import' },
  ]);
});

test('interpolated dynamic imports are not mistaken for exact target subpaths', () => {
  const source = 'const module = import(`next/${segment}`);';
  assert.deepEqual(scanSourceForImportSpecifiers(source), []);
  assert.deepEqual(scanSourceForImports(source), [],
    'the backward-compatible usage scan also avoids claiming a statically known package for this expression');
});

test('export ... from "foo" (re-export) is detected', () => {
  assert.deepEqual(names(scanSourceForImports(`export { x } from 'foo';`)), ['foo']);
});

test('a subpath import resolves to the base package name', () => {
  const matches = scanSourceForImports(`import get from 'lodash/get';`);
  assert.deepEqual(names(matches), ['lodash']);
});

test('a scoped package subpath resolves to the scoped base name', () => {
  const matches = scanSourceForImports(`import x from '@scope/foo/subpath';`);
  assert.deepEqual(names(matches), ['@scope/foo']);
});

test('a bare scoped package import resolves to itself', () => {
  assert.deepEqual(names(scanSourceForImports(`import x from '@scope/foo';`)), ['@scope/foo']);
});

test('a relative or absolute specifier is never treated as a package', () => {
  assert.deepEqual(scanSourceForImports(`import x from './local';`), []);
  assert.deepEqual(scanSourceForImports(`import x from '/abs/path';`), []);
  assert.deepEqual(scanSourceForImports(`import fs from 'node:fs';`), []);
});

test('a line comment mentioning a package name does not count', () => {
  assert.deepEqual(scanSourceForImports(`// import foo from 'foo';`), []);
});

test('a block comment mentioning a package name does not count', () => {
  assert.deepEqual(scanSourceForImports(`/* import foo from 'foo'; */`), []);
});

test('a plain string literal (not an import/require specifier) does not count as usage', () => {
  assert.deepEqual(scanSourceForImports(`const message = "please install foo";`), []);
  assert.deepEqual(scanSourceForImports(`const label = 'foo';`), []);
});

test('import-looking documentation strings, templates, and regexes do not become compatibility evidence', () => {
  const source = [
    `const docs = "import Close from 'next/dist/removed'";`,
    `const moreDocs = "require('next/dist/removed')";`,
    "const template = `import Close from 'next/dist/removed'`;",
    `const matcher = /require\\('next\\/dist\\/removed'\\)/;`,
  ].join('\n');
  assert.deepEqual(scanSourceForImportSpecifiers(source), []);
});

test('regex expressions in control-statement positions are not import evidence', () => {
  for (const source of [
    `if (ok) /import Close from 'next/dist/removed'/.test(text);`,
    `while (next()) /require('next/dist/removed')/.test(text);`,
    `for (; ok;) /import('next/dist/removed')/.test(text);`,
    `with (scope) /import X from 'next/dist/removed'/.test(text);`,
  ]) {
    assert.deepEqual(scanSourceForImportSpecifiers(source), []);
  }
});

test('line and column are reported for the specifier location', () => {
  const source = `\nimport x from 'foo';\n`;
  const [match] = scanSourceForImports(source);
  assert.equal(match.line, 2);
  assert.ok(match.column > 0);
});

test('multiple imports across multiple lines are all found with correct kinds', () => {
  const source = [
    `import a from 'alpha';`,
    `const b = require('beta');`,
    `const c = import('gamma');`,
    `const d = require.resolve('delta/adapter');`,
  ].join('\n');
  const matches = scanSourceForImports(source);
  assert.deepEqual(
    matches.map((m) => [m.packageName, m.kind, m.line]),
    [
      ['alpha', 'import', 1],
      ['beta', 'require', 2],
      ['gamma', 'dynamic-import', 3],
      ['delta', 'require', 4],
    ]
  );
});

// --------------------------------------------------------- packageNameMatch

test('importedPackageName strips subpaths for plain and scoped packages', () => {
  assert.equal(importedPackageName('lodash'), 'lodash');
  assert.equal(importedPackageName('lodash/get'), 'lodash');
  assert.equal(importedPackageName('@scope/pkg'), '@scope/pkg');
  assert.equal(importedPackageName('@scope/pkg/sub'), '@scope/pkg');
});

test('importedPackageName rejects relative, absolute, and scheme specifiers', () => {
  assert.equal(importedPackageName('./x'), null);
  assert.equal(importedPackageName('/x'), null);
  assert.equal(importedPackageName('node:fs'), null);
  assert.equal(importedPackageName(''), null);
});

test('specifierMatchesPackage matches exact and subpath specifiers only', () => {
  assert.equal(specifierMatchesPackage('lodash', 'lodash'), true);
  assert.equal(specifierMatchesPackage('lodash/get', 'lodash'), true);
  assert.equal(specifierMatchesPackage('lodash-es', 'lodash'), false);
});

for (const [name, source] of [
  ['closing tags', `<div title="it's / > import('fake')">require("fake")</div>`],
  ['self-closing tag after a spread', '<Component {...props} />'],
  ['fragments', `<><div /><span>it's plain text</span></>`],
  ['nested JSX expressions', '<div>{ok ? <span>{items.map(x => <i>{x}</i>)}</span> : <></>}</div>'],
  ['TSX generic arrow', 'const identity = <T,>(x: T) => x; const view = <div />;'],
  ['constrained TSX generic arrow', 'const identity = <T extends unknown>(x: T) => x; const view = <div />;'],
  ['comparison before JSX', 'const view = count < 2 && count > 0 ? <div /> : <span />;'],
  ['division after JSX', 'const ratio = <div /> / 2;'],
  ['comparison after JSX', 'const less = <div /> < count; const more = <div /> > count;'],
  ['JSX after division', 'const ratio = count / <div />;'],
  ['regex in JSX expressions', `<div>{/["'{}<>]/.test(value) ? <span /> : null}</div>`],
  ['import text in JSX regex', `<div>{/require('fake')/.test(value)}</div>`],
  ['regex next to JSX', String.raw`const view = /<\/div>/.test(value) ? <div /> : <span />;`],
  ['JSX in a template expression', 'const value = `${<div>{`${1 / 2}`}</div>}`;'],
]) {
  test(`${name} does not hide later imports or create uncertainty`, () => {
    const text = source + '\nimport "after";';
    assert.equal(hasUnreadTemplateImports(text, 'page.tsx'), false, source);
    assert.deepEqual(names(scanSourceForImports(text, 'page.tsx')), ['after'], source);
  });
}

test('every executable JSX and template expression retains reference coordinates', () => {
  const text = [
    '<div {...require("spread")} prop={import("attribute")}',
    '  className={`${require("template")}`}>',
    '  {import("child")}',
    '  {`${`nested ${require("nested")}`}`}',
    '  {items.map(x => <span>{require("mapped")}</span>)}',
    '</div>;',
  ].join('\n');
  const matches = scanSourceForImports(text, 'page.tsx');
  assert.deepEqual(names(matches), ['spread', 'attribute', 'template', 'child', 'nested', 'mapped']);
  assert.equal(hasUnreadTemplateImports(text, 'page.tsx'), false);
  for (const match of matches) {
    assert.equal(text.split('\n')[match.line - 1].slice(match.column - 1, match.column - 1 + match.packageName.length), match.packageName);
  }
});

for (const source of [
  'import(`${name}`)', 'import(`pkg/${name}`)', 'import(name)', 'require(name)',
  'require(`pkg/${name}`)', 'import("pkg" + name)', 'require("pkg" + name)',
  'require.resolve(name)', 'require.resolve.paths(name)', 'import.meta.resolve(name)',
  '<div>{import(`${name}`)}</div>',
]) {
  test(`unresolved specifier keeps coverage incomplete: ${source}`, () => {
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), true);
    assert.deepEqual(scanSourceForImports(source, 'page.tsx'), []);
  });
}

for (const source of [
  'const view = <div>', 'const view = <div title="unterminated>',
  'const view = <div>{require("known")', 'const view = <div></span>',
  'const view = <div>{/unterminated}</div>', 'const view = <div>{`unterminated}</div>',
]) {
  test(`unreadable JSX still blocks removals: ${source}`, () => {
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), true);
  });
}

test('comments, literal text and JSX attributes do not make dynamic coverage uncertain', () => {
  const source = [
    '// import(name)', '/* require(name) */',
    'const docs = "require(name)";', 'const template = `import(${name})`;',
    '<div title="require(name)">import(name)</div>;',
    'require(/* before */ `static` /* after */);',
    'import("known", { with: { type: "json" } });',
  ].join('\n');
  assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false);
  assert.deepEqual(names(scanSourceForImports(source, 'page.tsx')), ['static', 'known']);
});

test('TypeScript assertions stay in code in files that do not allow JSX', () => {
  const source = 'const value = <number>count / 2; import "after";';
  for (const extension of ['ts', 'mts', 'cts']) {
    assert.equal(hasUnreadTemplateImports(source, `page.${extension}`), false);
    assert.deepEqual(names(scanSourceForImports(source, `page.${extension}`)), ['after']);
  }
});
