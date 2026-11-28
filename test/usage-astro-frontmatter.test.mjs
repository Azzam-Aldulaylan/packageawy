import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRemoval } from '../out/core/upgrade/removalAssessment.js';
import { walkExpressionCode } from '../out/core/usage/jsxLex.js';
import { extractSourceCoverage } from '../out/core/usage/sourceCoverage.js';
import { collectProjectCompatibilityEvidence } from '../out/host/projectCompatibility/projectEvidenceCollector.js';
import { folder, usageWorkspace } from './helpers/usage-coverage.mjs';

const extractionReason = 'Astro frontmatter that could not be extracted';

for (const [name, body] of [
  ['division', 'const value = a / b;'],
  ['regex with a slash in its class', 'const pattern = /[/`]/g;'],
  ['division after a regex', 'const value = /[/]/ / 2;'],
  ['nested template', 'const value = `${a / b + `${/[/]/.test(v)}`}`;'],
  ['nested interpolation delimiters', 'const value = `${({ a: [fn(1)] }).a}`;'],
  ['ordinary identifier', 'const a = 1;'],
  ['parenthesized await', 'const data = await (await fetch(url)).json();'],
  ['for await with a block body', 'const chunks = [];\nfor await (const chunk of Astro.props.stream) { chunks.push(chunk); }'],
  ['plain for before regex', 'for (const x of xs) /re/.test(x);'],
  ['for await before regex', 'for await (const x of xs) /re/.test(x);'],
  ['for await with a block comment', 'for /* c */ await (const x of xs) /re/.test(x);'],
  ['for await with line comments', 'for // c\nawait // c\n(const x of xs) {}'],
  ['for await in template interpolation', 'const value = `${async () => { for /* c */ await (const x of xs) {} }}`;'],
]) {
  test(`Astro usage finds imports and allows removal after ${name}`, async () => {
    const text = `---\n${body}\nimport "only-here";\n---\n<p>It's here</p>`;
    const fence = text.lastIndexOf('---');
    assert.equal(walkExpressionCode(text, 4, index => index === fence), fence);
    const extraction = extractSourceCoverage('page.astro', text);
    assert.deepEqual(extraction.reasons, []);
    assert.equal(extraction.scripts[0].text.trim(), `${body}\nimport "only-here";`);
    const results = await usageWorkspace([['page.astro', text]]).analyze({ packageNames: ['only-here', 'unused'] });
    const used = results.get('only-here');
    assert.equal(used.references.length, 1);
    const importLine = body.split('\n').length + 2;
    assert.equal(used.references[0].line, importLine);
    assert.equal(used.truncated, false);
    const unused = results.get('unused');
    assert.equal(unused.truncated, false);
    assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'low-risk');
    const workspace = usageWorkspace([['page.astro', text]]);
    const evidence = await collectProjectCompatibilityEvidence({
      platform: workspace.platform, folder, dir: '', manifestText: '{}', packageName: 'only-here',
    });
    assert.equal(evidence.truncated, false);
    assert.deepEqual(evidence.scanLimitations ?? [], []);
    assert.deepEqual(evidence.imports.map(reference => reference.specifier), ['only-here']);
    assert.equal(evidence.imports[0].line, importLine);
  });
}

test('Astro for await with a backtick regex stops at the real fence and retains the import', async () => {
  const body = 'for await (const line of Astro.props.lines) /`/.test(line) && matches.push(line);\nconst renderer = await import("only-here");';
  const text = `---\n${body}\n---\n<p>Markup</p>\n\x60\n---\n`;
  const fence = text.indexOf('\n---', 4) + 1;
  assert.equal(walkExpressionCode(text, 4, index => text[index - 1] === '\n' && text.startsWith('---', index)), fence);
  const extraction = extractSourceCoverage('page.astro', text);
  assert.deepEqual(extraction.reasons, []);
  assert.equal(extraction.scripts.length, 1);
  assert.equal(extraction.scripts[0].text.trim(), body);
  assert.ok(extraction.scripts[0].text.includes('import("only-here")'));

  // The unchanged import mask still treats the regex backtick as a template.
  const workspace = usageWorkspace([['page.astro', text]]);
  const results = await workspace.analyze({ packageNames: ['only-here', 'unused'] });
  assert.equal(results.get('only-here').references.length, 0);
  const unused = results.get('unused');
  assert.equal(unused.truncated, true);
  assert.ok(!unused.coverageReasons.includes(extractionReason));
  assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
  const evidence = await collectProjectCompatibilityEvidence({
    platform: workspace.platform, folder, dir: '', manifestText: '{}', packageName: 'only-here',
  });
  assert.equal(evidence.truncated, true);
  assert.deepEqual(evidence.scanLimitations, ['project-source-import-scan-incomplete']);
  assert.deepEqual(evidence.imports, []);
});

for (const [name, body] of [
  ['plain for with contextual of before regex', 'for (const x of /re/) {}'],
  ['for await with contextual of before regex', 'for await (const x of /re/) {}'],
  ['commented for await with contextual of before regex', 'for /* c */ await (const x of /re/) {}'],
  ['debugger before regex', 'debugger\n/`/.test(value);'],
  ...['debugger', 'break', 'continue'].map(word => [`${word} before slash`, `${word} /x/.test(value);`]),
  ...['\n', '\r', '\u2028', '\u2029'].map(terminator => [
    `division after ${JSON.stringify(terminator)}`, `a${terminator}/ b`,
  ]),
  ['division after multiline comment', 'a /*\n*/ / b'],
  ['division after same line comment', 'a /* comment */ / b'],
  ['division after line comment', 'a // comment\n/ b'],
  ['closing brace before slash', 'if (ready) {} /`/.test(value);'],
  ['generic before division', 'fn<T> / 2;'],
  ['unterminated regex', 'const pattern = /unterminated'],
  ['mismatched delimiters', 'const value = (a / b];'],
  ['delimiter underflow', 'const value = a / b);'],
  ['unclosed opener', 'const value = (a / b;'],
  ['mismatched interpolation delimiters', 'const value = `${(a / b]}`;'],
  ['unclosed interpolation opener', 'const value = `${(a / b}`;'],
  ['malformed regex body', '/(/'],
  ['duplicate regex flags', '/x/gg'],
]) {
  test(`Astro ${name} rejects the fence and keeps both consumers incomplete`, async () => {
    // A markup backtick and a second fence expose a regex mistaken for division.
    const text = `---\n${body}\nimport "only-here";\n---\n<p>Markup</p>\n\x60\n---\n`;
    assert.equal(walkExpressionCode(text, 4, index => text[index - 1] === '\n' && text.startsWith('---', index)), null);
    const extraction = extractSourceCoverage('page.astro', text);
    assert.deepEqual(extraction.reasons, [extractionReason]);
    assert.deepEqual(extraction.scripts, []);
    const workspace = usageWorkspace([['page.astro', text]]);
    const results = await workspace.analyze({ packageNames: ['only-here', 'unused'] });
    assert.equal(results.get('only-here').references.length, 0);
    const unused = results.get('unused');
    assert.equal(unused.truncated, true);
    assert.ok(unused.coverageReasons.includes(extractionReason));
    assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
    const evidence = await collectProjectCompatibilityEvidence({
      platform: workspace.platform, folder, dir: '', manifestText: '{}', packageName: 'only-here',
    });
    assert.equal(evidence.truncated, true);
    assert.ok(evidence.scanLimitations.includes('project-source-extraction-incomplete'));
    assert.deepEqual(evidence.imports, []);
  });
}

test('Astro escaped identifiers preserve extraction and imports with the normal scanning coverage gap', async () => {
  const body = String.raw`const \u0061 = 1;`;
  const text = `---\n${body}\nimport "only-here";\n---\n<p>Hello</p>`;
  const fence = text.lastIndexOf('---');
  assert.equal(walkExpressionCode(text, 4, index => index === fence), fence);
  const extraction = extractSourceCoverage('page.astro', text);
  assert.deepEqual(extraction.reasons, []);
  assert.equal(extraction.scripts[0].text.trim(), `${body}\nimport "only-here";`);
  const results = await usageWorkspace([['page.astro', text]]).analyze({ packageNames: ['only-here', 'unused'] });
  assert.equal(results.get('only-here').references.length, 1);
  assert.equal(results.get('only-here').references[0].line, 3);
  const unused = results.get('unused');
  assert.equal(unused.truncated, true);
  assert.ok(unused.coverageReasons.length > 0);
  assert.ok(!unused.coverageReasons.includes(extractionReason));
  assert.equal(assessRemoval({ usage: unused, peerRequirements: [], stillRequiredBy: [] }).status, 'unknown');
});
