import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browserSkip } from './helpers/browser.mjs';

function browserEnvironment(t, required, executable) {
  for (const [name, value] of Object.entries({
    PACKAGEAWY_REQUIRE_BROWSER_TESTS: required,
    PACKAGEAWY_CHROMIUM_PATH: executable,
  })) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'packageawy-browser-skip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('browserSkip throws when browser tests are required and the path is unset', t => {
  browserEnvironment(t, '1', undefined);
  assert.throws(() => browserSkip('Optional browser check'), /PACKAGEAWY_CHROMIUM_PATH must be set/);
});

test('browserSkip returns the skip reason when the browser is optional and unset', t => {
  browserEnvironment(t, undefined, undefined);
  assert.equal(browserSkip('Optional browser check'), 'Optional browser check');
});

for (const required of [undefined, '1']) {
  const mode = required === '1' ? 'required' : 'optional';
  test(`browserSkip rejects a nonexistent explicit path in ${mode} mode`, t => {
    browserEnvironment(t, required, join(directory(t), 'missing'));
    assert.throws(() => browserSkip('Optional browser check'), /must point to an executable file/);
  });

  test(`browserSkip rejects a directory in ${mode} mode`, t => {
    browserEnvironment(t, required, directory(t));
    assert.throws(() => browserSkip('Optional browser check'), /must point to an executable file/);
  });

  test(`browserSkip rejects a non-executable file in ${mode} mode`, {
    skip: process.platform === 'win32' && 'Windows does not support POSIX execute permissions',
  }, t => {
    const executable = join(directory(t), 'chromium');
    writeFileSync(executable, 'browser fixture');
    chmodSync(executable, 0o644);
    browserEnvironment(t, required, executable);
    assert.throws(() => browserSkip('Optional browser check'), /must point to an executable file/);
  });

  test(`browserSkip returns false for an executable file in ${mode} mode`, t => {
    browserEnvironment(t, required, process.execPath);
    assert.equal(browserSkip('Optional browser check'), false);
  });
}
