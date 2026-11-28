import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/ci/require-tests-ran.mjs', import.meta.url));
const names = [
  'shared result keeps check statuses beside commands at narrow and wide widths',
  'keyboard-focused security card still allows pointer help',
  'dialog footer controls fit short and narrow viewports in both host themes',
  'bulk summary fits the capped dialog at wide and narrow viewport widths',
  'dependency findings keep reading order, aligned edges and group spacing at 1100px and 400px in both host themes',
];
const passed = names.map((name, index) => `ok ${index + 1} - ${name}`);

function check(t, lines, lineEnding = '\n') {
  const root = mkdtempSync(join(tmpdir(), 'packageawy-required-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (lines) {
    writeFileSync(join(root, 'test-results.tap'), ['TAP version 13', ...lines, `1..${lines.length}`, ''].join(lineEnding));
  }
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}

test('the browser TAP gate passes when all five expected tests ran', t => {
  const result = check(t, passed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All 5 required browser tests ran and passed/);
});

test('the browser TAP gate accepts CRLF output', t => {
  assert.equal(check(t, passed, '\r\n').status, 0);
});

test('the browser TAP gate rejects a skipped test', t => {
  const result = check(t, [`${passed[0]} # SKIP browser unavailable`, ...passed.slice(1)]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(names[0]));
});

test('the browser TAP gate rejects a missing test', t => {
  const result = check(t, passed.slice(1));
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(names[0]));
});

test('the browser TAP gate rejects a failed test', t => {
  const result = check(t, [passed[0].replace(/^ok /, 'not ok '), ...passed.slice(1)]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(names[0]));
});

test('the browser TAP gate rejects a renamed test', t => {
  assert.equal(check(t, [`${passed[0]} renamed`, ...passed.slice(1)]).status, 1);
});

test('the browser TAP gate rejects a todo test', t => {
  assert.equal(check(t, [`${passed[0]} # TODO fix browser`, ...passed.slice(1)]).status, 1);
});

test('the browser TAP gate rejects a missing report', t => {
  assert.equal(check(t).status, 1);
});
