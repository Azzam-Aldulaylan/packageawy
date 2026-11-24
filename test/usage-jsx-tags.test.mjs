import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { hasUnreadTemplateImports, scanSourceForImportSpecifiers } from '../out/core/usage/importScan.js';
import { usageWorkspace } from './helpers/usage-coverage.mjs';

const comments = [
  '// @ts-ignore\n', '// to be changed later\n', '/* between attributes */',
  '// title={t("a:b")}\n// icon={<BarChart className="h-5 w-5" />}\n',
  '/* > /> { require("fake") } <Fake> */',
];
const names = source => scanSourceForImportSpecifiers(source, 'page.tsx').map(match => match.specifier);

function valid(source) {
  const parsed = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(parsed.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, " ")), [], source);
  return parsed;
}

for (const comment of comments) {
  test(`JSX tag comment preserves following expressions: ${JSON.stringify(comment)}`, async () => {
    for (const before of ['', 'value={x} ']) {
      const source = `const view = <Input ${before}${comment} b={require("real")} />;\nimport "after";`;
      valid(source);
      assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
      assert.deepEqual(names(source), ['real', 'after'], source);
      const match = scanSourceForImportSpecifiers(source, 'page.tsx')[0];
      assert.equal(source.split('\n')[match.line - 1].slice(match.column - 1, match.column + 3), 'real');
      const usage = (await usageWorkspace([['page.tsx', source]]).analyze({ packageNames: ['real'] })).get('real');
      assert.equal(usage.references.length, 1);
      assert.equal(usage.truncated, false);
    }
  });
}

test('inline attribute comments and nested tags stay covered', () => {
  for (const markup of [
    '<DetailFile // to be changed later\n file={f} />',
    '<FileUpload maxSize={20 * 1024 * 1024} // 5 MB\n onChange={(f) => field.onChange(f)} // note\n />',
    '<Outer><A/* comment */ b={import("real")} /></Outer>',
    '<A // /> {import("fake")}\n {...require("real")} />',
  ]) {
    const source = `const view = ${markup};`;
    valid(source);
    assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
    assert.deepEqual(names(source), markup.includes('real') ? ['real'] : [], source);
  }
});

const typeArguments = ['any, boolean', 'Map<string, Array<{ value: number }>>',
  '(x: string) => { value: ">" }', 'typeof import("type-package")',
  '/* > */ any, // >\n boolean'];
for (const types of typeArguments) {
  test(`generic JSX element retains expressions: ${types}`, () => {
    for (const markup of [
      `<CreatableSelect<${types}> isMulti value={require("real")} />`,
      `<CreatableSelect /* tag trivia */ <${types}> value={require("real")} />`,
      `<Outer><UI.Select<${types}>> // text\n{import("real")}</UI.Select></Outer>`,
    ]) {
      const source = `const view = ${markup}; import "after";`;
      valid(source);
      assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
      assert.deepEqual(names(source), [...(types.includes('type-package') ? ['type-package'] : []), 'real', 'after'], source);
    }
  });
}

test('tag comments cannot hide dynamic loaders and unreadable type boundaries', () => {
  for (const source of [
    '<A // x\n b={require(name)} />', '<A /* x */ b={import(name)} />',
    '<A /* unclosed b={require("real")} />', '<A<any b={require("real")} />',
    '<A<"unterminated> b={require("real")} />',
  ]) assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), true, source);
});

test('JSX text that resembles comments keeps braces executable', () => {
  for (const text of ['// not a comment', '/* text */', '// ', '/* ']) {
    for (const expression of ['', '{require("real")}']) {
      const source = `const view = <p>${text}${expression}</p>; import "after";`;
      valid(source);
      assert.equal(hasUnreadTemplateImports(source, 'page.tsx'), false, source);
      assert.deepEqual(names(source), expression ? ['real', 'after'] : ['after'], source);
    }
  }
});

test('TS files keep angle assertions and tag-looking comments in code', () => {
  const source = 'const value = <A /* > */>require("real"); import "after";';
  for (const file of ['page.ts', 'page.mts', 'page.cts']) {
    assert.equal(hasUnreadTemplateImports(source, file), false);
    assert.deepEqual(scanSourceForImportSpecifiers(source, file).map(match => match.specifier), ['real', 'after']);
  }
});

test('fixed-seed TSX differential corpus never certifies a missing import', () => {
  let seed = 0x29c0ffee;
  const pick = values => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  for (let index = 0; index < 256; index += 1) {
    const tag = pick(['A', 'UI.Select']);
    const types = pick(['', ...typeArguments.map(value => `<${value}>`)]);
    const comment = pick(comments);
    const element = `<${tag}${types} value={0} ${comment} b={${pick(['require', 'import'])}("real")} />`;
    const source = pick([s => `const view = ${s};`, s => `const view = <Outer>${s}</Outer>;`,
      s => 'const view = `${' + s + '}`;'])(element) + ' import "after";';
    const parsed = valid(source);
    const expected = [];
    function visit(node) {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(parsed) === 'require') &&
          ts.isStringLiteral(node.arguments[0])) expected.push(node.arguments[0].text);
      if (ts.isImportDeclaration(node)) expected.push(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node)) expected.push(node.argument.literal.text);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    const found = names(source);
    const unread = hasUnreadTemplateImports(source, 'page.tsx');
    assert.ok(unread || expected.every(name => found.includes(name)), `seed=0x29c0ffee case=${index}: ${source}`);
    assert.equal(unread, false, source);
    assert.deepEqual(found, expected, source);
  }
});
