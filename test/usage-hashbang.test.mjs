import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnreadTemplateImports, scanSourceForImports } from '../out/core/usage/importScan.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

for (const bom of ['', '\ufeff']) {
  for (const newline of ['\n', '\r\n']) {
    test(`CLI hashbang preserves import locations and complete coverage: ${JSON.stringify({ bom, newline })}`, async () => {
      const source = `${bom}#!/usr/bin/env node${newline}import "only-here";`;
      assert.equal(hasUnreadTemplateImports(source), false);
      assert.deepEqual(scanSourceForImports(source), [{
        packageName: 'only-here', line: 2, column: 9,
        snippet: 'import "only-here";', kind: 'import',
      }]);
      const result = (await usageWorkspace([['cli.js', source]]).analyze()).get('only-here');
      assert.equal(result.references.length, 1);
      assert.equal(result.references[0].line, 2);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.coverageReasons ?? [], []);
    });
  }
}

test('hashbang contents are comments, including at end of file', () => {
  for (const bom of ['', '\ufeff']) {
    for (const tail of ['', '\nimport "only-here";']) {
      const source = bom + '#! import "comment-only"; require("also-comment-only"); `${import("hidden")}' + tail;
      assert.equal(hasUnreadTemplateImports(source), false);
      assert.deepEqual(scanSourceForImports(source).map(match => match.packageName), tail ? ['only-here'] : []);
    }
  }
});

test('hashbang syntax after any preceding content keeps incomplete coverage', () => {
  for (const prefix of [' ', '\n', '\ufeff ', '\ufeff\ufeff', 'const x = 1;\n']) {
    const source = `${prefix}#!/usr/bin/env node\nimport "only-here";`;
    assert.equal(hasUnreadTemplateImports(source), true, JSON.stringify(prefix));
    assert.deepEqual(scanSourceForImports(source), [], JSON.stringify(prefix));
  }
});

test('hashbang text inside existing comments and literals keeps its behavior', () => {
  for (const prefix of [
    '// #! import "comment-only";',
    '/* #! import "comment-only"; */',
    'const text = "#!";',
    'const text = `#!`;',
    'const pattern = /#!/;',
  ]) {
    const source = `${prefix}\nimport "only-here";`;
    assert.equal(hasUnreadTemplateImports(source), false, prefix);
    assert.deepEqual(scanSourceForImports(source).map(match => match.packageName), ['only-here'], prefix);
  }
});
