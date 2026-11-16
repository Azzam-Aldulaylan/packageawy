import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { hasUnreadTemplateImports, scanSourceForImports } from '../out/core/usage/importScan.js';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

// The standalone TS scanner needs the parser's lexical goals to rescan slash
// tokens and template tails. Get those positions from TS's AST, independently
// of the import walker's expression heuristic, then verify the scanner stream.
function typescriptMarker(source) {
  const file = ts.createSourceFile('oracle.ts', source, ts.ScriptTarget.Latest, true);
  assert.deepEqual(file.parseDiagnostics, [], source);
  const regexStarts = new Set();
  const templateContinuations = new Set();
  function visit(node) {
    if (ts.isRegularExpressionLiteral(node)) regexStarts.add(node.getStart(file));
    if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) templateContinuations.add(node.getStart(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  const errors = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard,
    source, error => errors.push(error.message));
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenPos();
    if (regexStarts.has(start)) {
      assert.equal(kind, ts.SyntaxKind.SlashToken, source);
      kind = scanner.reScanSlashToken();
      assert.equal(kind, ts.SyntaxKind.RegularExpressionLiteral, source);
      regexStarts.delete(start);
    } else if (templateContinuations.has(start)) {
      assert.equal(kind, ts.SyntaxKind.CloseBraceToken, source);
      kind = scanner.reScanTemplateToken(false);
      assert.ok(kind === ts.SyntaxKind.TemplateMiddle || kind === ts.SyntaxKind.TemplateTail, source);
      templateContinuations.delete(start);
    }
    assert.equal(scanner.isUnterminated(), false, source);
    tokens.push({ kind, start, text: scanner.getTokenText() });
  }
  assert.deepEqual(errors, [], source);
  assert.equal(regexStarts.size + templateContinuations.size, 0, source);
  const marker = tokens.findIndex(token => token.start === source.lastIndexOf('import "marker"'));
  return tokens[marker]?.kind === ts.SyntaxKind.ImportKeyword && tokens[marker + 1]?.text === '"marker"';
}

for (const operator of ['++', '--']) {
  for (const operand of ['count', '(count)', 'values[0]', '4', '4.', '1e+2', '"4"', '`4`']) {
    for (const template of [false, true]) {
      test(`postfix ${operand}${operator} keeps division in ${template ? 'interpolation' : 'source'}`, () => {
        const expression = `${operand}${operator} / 2`;
        const prefix = template ? 'const value = `${' + expression + '}`;' : expression + ';';
        const source = prefix + ' import "marker"; const r = /}`/;';
        assert.equal(typescriptMarker(source), true);
        assert.equal(hasUnreadTemplateImports(source), false, source);
        assert.deepEqual(scanSourceForImports(source).map(match => match.packageName), ['marker'], source);
      });
    }
  }
}

test('review 3 reproduction retains its import with complete coverage', async () => {
  const source = 'let count = 4; const value = `${count++ / 2}`; import "only-here"; const r = /}`/;';
  const result = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
  assert.equal(result.references.length, 1);
  assert.equal(result.truncated, false);
});

test('ambiguous outer slash contexts cannot certify removal coverage', async () => {
  for (const prefix of ['{}', 'object.']) {
    // Block/object braces and unfinished members need grammar the walker lacks.
    const source = prefix + ' /\'/; import "only-here";';
    const result = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
    assert.equal(result.truncated, true, source);
    assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown', source);
  }
});

test('unterminated outer regex, string and comment walks are incomplete', () => {
  for (const source of ['const r = /unterminated', 'const r = /bad\n; import "marker";', 'const s = "unterminated', '/* unterminated']) {
    assert.equal(hasUnreadTemplateImports(source), true, source);
  }
});

test('TypeScript non-null and contextual for-of slash goals are incomplete', async () => {
  for (const expression of ['count! / 2', '(() => { for (const x of /[\'"}`]/) {} })()']) {
    for (const template of [false, true]) {
      const prefix = template ? 'const value = `${' + expression + '}`;' : `const value = (${expression});`;
      const source = prefix + ' import "marker"; const tail = /}`/;';
      assert.equal(typescriptMarker(source), true);
      assert.equal(hasUnreadTemplateImports(source), true, source);
      const result = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
      assert.equal(result.truncated, true, source);
    }
  }
});

const keywordExpressions = [
  r => `typeof ${r}`, r => `void ${r}`, r => `delete ${r}.x`, r => `new ${r}.constructor()`,
  r => `"x" in ${r}`, r => `count instanceof ${r}.constructor`,
  r => `(() => { return ${r}; })()`, r => `(() => { throw ${r}; })()`,
  r => `(function* () { yield ${r}; })()`, r => `(async () => await ${r})()`,
  r => `(() => { switch (count) { case ${r}: break; } })()`,
  r => `(() => { do ${r}.test("x"); while (false); })()`,
  r => `(() => { if (count) {} else ${r}.test("x"); })()`,
];

test('regex goals after every keyword, prefix update and binary operator retain the import', () => {
  const regex = '/[\'"}`]/';
  const expressions = [
    ...keywordExpressions.map(make => make(regex)),
    `++${regex}.lastIndex`, `--${regex}.lastIndex`, `count / ${regex}.source.length`,
    ...['=', '+', '-', '*', '%', '^', '&', '|', '&&', '||', '??', '<'].map(operator => `count ${operator} ${regex}`),
    `count ? ${regex} : ${regex}`, `(${regex})`, `[${regex}]`, `(${regex}, ${regex})`, `fn(...${regex})`,
    `(() => { if (count) ${regex}.test(""); })()`,
    ...['return', 'typeof', 'in', 'await'].map(word => `object.${word} / 2`),
    'count / /[/*]/.source.length',
  ];
  for (const expression of expressions) {
    for (const template of [false, true]) {
      const prefix = template ? 'const value = `${' + expression + '}`;' : `const value = (${expression});`;
      const source = prefix + ' import "marker"; const tail = /}`/;';
      assert.equal(typescriptMarker(source), true);
      assert.equal(hasUnreadTemplateImports(source), false, source);
      assert.deepEqual(scanSourceForImports(source).map(match => match.packageName), ['marker'], source);
    }
  }
});

// These type forms share tokens with expression operators. Some have a known
// slash goal; the rest must report a gap instead of losing the marker silently.
const typeExpressions = [
  'count as number / 2', 'count as Id<number> / 2', 'count as Id<Id<number>> / 2',
  'fn<number> / 2', 'fn<Id<number>> /* trivia */ / 2',
  'count as void / 2', 'count as void | void / 2', 'count as () => void / 2',
  'count as { run(): void; } | void / 2',
  'count as T extends number ? void : void / 2',
  'count satisfies number / 2', 'count satisfies Id<number> / 2',
  'count satisfies void / 2', 'count satisfies void & void / 2',
  'count satisfies { run(): void; } | void / 2',
  'count satisfies () => void / 2',
  '<number>count / 2', '<Id<number>>count / 2', '<void>count / 2',
  '<number>/[\'"}`]/', '<Id<number>>/[\'"}`]/',
  'count! / 2', 'count!! / 2', 'count! /* trivia */ / 2',
  '(count as Id<number>) / 2', '(count satisfies Id<number>) / 2', '(count!) / 2',
  'count > /[\'"}`]/',
];

test('type context ends at containing delimiters and statement boundaries', () => {
  for (const prefix of [
    'const value = count as number;',
    'const value = count satisfies number;',
    'fn(count as number);',
    'fn(count satisfies number);',
    'const value = object.as;',
    'const value = object.satisfies;',
  ]) {
    const source = prefix + ' void /[\'"}`]/; import "marker";';
    assert.equal(typescriptMarker(source), true);
    assert.equal(hasUnreadTemplateImports(source), false, source);
    assert.deepEqual(scanSourceForImports(source).map(match => match.packageName), ['marker'], source);
  }
});

test('review 4 generic assertion marks the source not read', async () => {
  const source = 'type Id<T> = T; const n = 4; const v = `${n as Id<number> / 2}`; import "only-here"; const r = /}`/;';
  const result = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
  assert.equal(result.truncated, true);
  assert.ok(result.coverageReasons.some(reason => reason.includes('could not be read')));
  assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
});

test('ambiguous TypeScript slash goals mark source and interpolation coverage incomplete', async () => {
  for (const expression of typeExpressions.filter(expression =>
    /(?:>|!|\bvoid)\s*(?:\/\* trivia \*\/\s*)?\//.test(expression))) {
    for (const template of [false, true]) {
      const prefix = template ? 'const value = `${' + expression + '}`;' : `const value = (${expression});`;
      const source = prefix + ' import "marker"; const tail = /}`/;';
      assert.equal(typescriptMarker(source), true);
      assert.equal(hasUnreadTemplateImports(source), true, source);
      const result = (await usageWorkspace([['page.ts', source]]).analyze()).get('only-here');
      assert.equal(result.truncated, true, source);
      assert.equal(assessRemoval({ usage: result, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown', source);
    }
  }
});

test('fixed-seed differential corpus agrees with the TypeScript scanner', () => {
  let seed = 0x17c0ffee;
  const pick = values => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  const regexes = [String.raw`/'/`, '/[`}]/', String.raw`/["'{}\x60]/`, String.raw`/\/'/`, String.raw`/[/*]/`];
  const operands = ['count', '(count)', 'items[0]', '4', '1e+2', '"4"', '`plain`', '`nested ${count / 2}`'];
  for (let index = 0; index < 512 + typeExpressions.length * 2; index += 1) {
    const operand = pick(operands);
    const regex = pick(regexes);
    const typeExpression = index >= 512;
    const expression = typeExpression ? typeExpressions[Math.floor((index - 512) / 2)] : pick([
      () => `${operand}${pick(['++', '--'])} / 2`,
      () => `${pick(['++', '--'])}count / 2`,
      () => `${operand} / ${regex}.source.length`,
      () => `${operand} + ${regex}.source.length`,
      () => pick(keywordExpressions)(regex),
      () => `object.${pick(['typeof', 'return', 'in', 'await'])} / 2`,
      () => `${operand} / 2 / ${regex}.source.length`,
    ])();
    const prefix = index % 2 === 0 ? 'const value = `${' + expression + '}`;'
      : `const value = (${expression});`;
    const source = prefix + ' import "marker"; const tail = /}`/;';
    const expected = typescriptMarker(source);
    const found = scanSourceForImports(source).some(match => match.packageName === 'marker');
    const incomplete = hasUnreadTemplateImports(source);
    assert.equal(expected, true, source);
    assert.ok(incomplete || found, `complete coverage missed marker: seed=0x17c0ffee, case=${index}: ${source}`);
    // The original JS expressions have known goals. Preserve their coverage
    // while allowing conservative gaps for the added TypeScript syntax.
    if (!typeExpression) assert.equal(incomplete, false, `case=${index}: ${source}`);
  }
});
