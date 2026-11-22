import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { hasUnreadTemplateImports, scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const reviewInputs = [
  'export ' + ' '.repeat(4087) + 'type * from "only-here";',
  String.raw`<div>{requ\u0069re("only-here")}</div>`,
  '<div>{module["require"]("only-here")}</div>',
];
const repeatedCalls = 'require("only-here");'.repeat(64_000);

test('review inputs explicitly report incomplete coverage', () => {
  for (const source of reviewInputs) {
    assert.deepEqual(scanSourceForImportSpecifiers(source, 'page.tsx'), [], source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), true, source);
  }
});

test('capped re-exports stay incomplete at every optional type-token boundary', async () => {
  for (const visible of ['', 't', 'ty', 'typ', 'type', 'type ']) {
    const source = 'export ' + ' '.repeat(4096 - 7 - visible.length) + 'type * from "only-here";';
    assert.equal(hasUnreadTemplateImports(source, 'page.ts'), true, visible);
  }
  const usage = (await usageWorkspace([['page.ts', reviewInputs[0]]]).analyze()).get('only-here');
  assert.equal(usage.truncated, true);
  assert.equal(assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
});

test('escaped executable identifiers and computed loader access block removal', async () => {
  const expressions = [
    String.raw`requ\u0069re("only-here")`, String.raw`\u{72}equire("only-here")`,
    String.raw`const oth\u0065r = 1`, String.raw`mod\u0075le["require"]("only-here")`,
    ...['module', 'globalThis', 'window', 'require'].flatMap(receiver => [
      `${receiver}["require"]("only-here")`, `${receiver}['import']("only-here")`,
      receiver + '[`require`]("only-here")', String.raw`${receiver}["requ\u0069re"]("only-here")`,
      `${receiver}[key]("only-here")`, `${receiver}?.[key]("only-here")`,
      `${receiver} /* comment */ ["re" + "quire"]("only-here")`,
      receiver + '[`requ${part}`]("only-here")',
    ]),
  ];
  for (const expression of expressions) {
    for (const source of [expression, `<div>{${expression}}</div>`, '`${' + expression + '}`']) {
      assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), true, source);
    }
  }
  for (const source of reviewInputs.slice(1)) {
    const usage = (await usageWorkspace([['page.tsx', source]]).analyze()).get('only-here');
    assert.equal(usage.truncated, true, source);
    assert.equal(assessRemoval({ usage, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown', source);
  }
});

test('literal and comment text and known unrelated computed keys keep coverage complete', () => {
  for (const source of [
    String.raw`// requ\u0069re("only-here"); module[key]("only-here")`,
    String.raw`const docs = 'requ\u0069re("only-here"); module[key]("only-here")';`,
    String.raw`const docs = /requ\u0069re/;`,
    String.raw`<div>requ\u0069re("only-here"); module[key]("only-here")</div>`,
    'const docs = `module[key]("only-here")`;',
    'module["exports"] = {}; window?.["location"]; globalThis[`console`];',
    'window /* comment */ ["location"]; globalThis["con\\u0073ole"];',
  ]) assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
});

test('many same-line references reuse precomputed line boundaries and snippets', () => {
  const originalIndexOf = String.prototype.indexOf;
  let repeatedLineSearches = 0;
  let matches;
  const start = performance.now();
  try {
    String.prototype.indexOf = function (search, position) {
      if (search === '\n' && this.valueOf() === repeatedCalls) repeatedLineSearches += 1;
      return originalIndexOf.call(this, search, position);
    };
    matches = scanSourceForImportSpecifiers(repeatedCalls, 'page.ts');
  } finally {
    String.prototype.indexOf = originalIndexOf;
  }
  assert.equal(repeatedLineSearches, 0);
  assert.deepEqual(matches, Array.from({ length: 64_000 }, (_, index) => ({
    packageName: 'only-here', specifier: 'only-here', kind: 'require',
    line: 1, column: index * 'require("only-here");'.length + 10,
    snippet: repeatedCalls.slice(0, 160) + '…',
  })));
  assert.ok(performance.now() - start < 5000, '64,000 references should scan within 5 seconds');
  assert.equal(hasUnreadTemplateImports(repeatedCalls, 'page.ts'), false);
});

test('cached snippets preserve trimmed lines and CRLF coordinates', () => {
  const matches = scanSourceForImportSpecifiers('  require("a"); require("b");  \r\n\n\timport "c";  ', 'page.ts');
  assert.deepEqual(matches.map(({ line, column, snippet }) => ({ line, column, snippet })), [
    { line: 1, column: 12, snippet: 'require("a"); require("b");' },
    { line: 1, column: 26, snippet: 'require("a"); require("b");' },
    { line: 3, column: 10, snippet: 'import "c";' },
  ]);
});
