import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnreadTemplateImports, scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const operators = ['<<', '<<=', '<=', '>>', '>>=', '>>>', '>>>=', '>='];

function assertCovered(source, expected, file) {
  assert.deepEqual(scanSourceForImportSpecifiers(source, file).map(match => match.specifier), expected, source);
  assert.equal(hasUnreadTemplateImports(source, file), false, source);
}

test('whole angle operators preserve following compact imports and exports', () => {
  for (const operator of operators) {
    for (const right of ['2', 'limit']) {
      for (const declaration of [
        'require("only-here");', 'import("only-here");', 'import"only-here";',
        'import{value}from"only-here";', 'export{value}from"only-here";', 'export*from"only-here";',
      ]) {
        const source = `let flags=1;flags${operator}${right};${declaration}`;
        for (const file of [undefined, 'bundle.js', 'bundle.jsx', 'bundle.ts', 'bundle.tsx']) {
          assertCovered(source, ['only-here'], file);
        }
      }
    }
  }
  assertCovered('const flags=1<<2;require("only-here");', ['only-here']);
});

test('angle operators expect an expression, including regex literals and single JSX openings', () => {
  for (const operator of operators) {
    const regexSource = `let flags=1;flags${operator}/require("fake")/.test(value);require("only-here");`;
    if (operator === '>>' || operator === '>>>') {
      // These tokens can also close nested TypeScript generics before division.
      assert.equal(hasUnreadTemplateImports(regexSource, 'bundle.js'), true, regexSource);
    } else assertCovered(regexSource, ['only-here']);
    const expression = `flags${operator}<View>require("fake"){require("only-here")}</View>`;
    for (const source of [
      `let flags=1;${expression};`,
      'let flags=1;const text=`${' + expression + '}`;',
      `let flags=1;const view=<Outer>{${expression}}</Outer>;`,
    ]) assertCovered(source, ['only-here'], 'page.tsx');
  }
});

const bundles = [
  {
    name: 'esbuild-style minified bundle',
    source: 'var n=(t,e)=>()=>(e||(e={exports:{}},t(e.exports,e)),e.exports);var r=n((t,e)=>{var o=1<<2;o<<=1;o>>=1;o>>>=0;e.exports={flags:o,load:()=>require("only-here")}});module.exports=r();',
  },
  {
    name: 'React production-style lane scheduling snippet',
    source: '"use strict";function clz32(e){return e===0?32:31-(Math.log(e)/Math.LN2|0)}function nextLane(e){var n=e&-e;return n<=4?n:n>=134217728?0:1<<31-clz32(e)}function retry(e){var n=e<<1;return n>4194304&&(n=128),n}var lanes=nextLane(42),retryLane=retry(lanes);exports.load=function(){return require("only-here")};',
  },
];

for (const { name, source } of bundles) {
  test(`${name} retains references and complete workspace coverage`, async () => {
    assertCovered(source, ['only-here']);
    const match = scanSourceForImportSpecifiers(source, 'bundle.js')[0];
    assert.equal(match.line, 1);
    assert.equal(match.column, source.indexOf('only-here') + 1);
    const usage = (await usageWorkspace([['bundle.js', source]]).analyze()).get('only-here');
    assert.equal(usage.references.length, 1);
    assert.equal(usage.truncated, false);
    assert.deepEqual(usage.coverageReasons ?? [], []);
  });
}
