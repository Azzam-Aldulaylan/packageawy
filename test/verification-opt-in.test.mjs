import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyVerificationOptIn,
  MAX_REQUESTED_VERIFICATION_SCRIPTS,
  resolveVerificationOptIn,
} from '../out/host/verificationOptIn.js';

const manifestText = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', build: 'tsc', test: 'jest', lint: 'eslint .' } });
const suggested = ['typecheck', 'build', 'test'];
const script = (name) => ({ id: `package-script:${name}`, scriptName: name });

function resolve(overrides = {}) {
  return resolveVerificationOptIn({
    configured: [],
    currentSetting: [],
    suggestedScriptNames: suggested,
    manifestText,
    request: { verificationScripts: ['build', 'test'] },
    trusted: true,
    ...overrides,
  });
}

test('accepts requested names that the analysis suggested and the manifest still defines, in suggestion order', () => {
  assert.deepEqual(resolve({ request: { verificationScripts: ['test', 'typecheck'] } }), {
    scripts: [script('typecheck'), script('test')],
    remember: false,
  });
});

test('names the analysis did not suggest are ignored even when the manifest defines them', () => {
  assert.deepEqual(resolve({ request: { verificationScripts: ['lint', 'postinstall', '--help', 'build'] } }).scripts, [script('build')]);
});

test('a name removed from the manifest since the analysis is ignored', () => {
  const changed = JSON.stringify({ scripts: { test: 'jest' } });
  assert.deepEqual(resolve({ manifestText: changed }).scripts, [script('test')]);
  assert.deepEqual(resolve({ manifestText: '{' }).scripts, []);
});

test('nothing is accepted in an untrusted workspace', () => {
  assert.deepEqual(resolve({ trusted: false, request: { verificationScripts: ['build'], rememberVerificationScripts: true } }), {
    scripts: [],
    remember: false,
  });
});

test('configured scripts always win over an opt-in', () => {
  assert.deepEqual(resolve({ configured: [script('lint')], request: { verificationScripts: ['build'], rememberVerificationScripts: true } }), {
    scripts: [script('lint')],
    remember: false,
  });
  assert.deepEqual(resolve({ currentSetting: ['lint'] }), { scripts: [], remember: false }, 'a setting added after the analysis wins');
  assert.deepEqual(resolve({ currentSetting: ['missing'] }).scripts, [script('build'), script('test')], 'a setting that selects nothing does not count');
});

test('remember is honored only with at least one accepted name', () => {
  assert.equal(resolve({ request: { verificationScripts: ['build'], rememberVerificationScripts: true } }).remember, true);
  assert.equal(resolve({ request: { verificationScripts: ['lint'], rememberVerificationScripts: true } }).remember, false);
  assert.equal(resolve({ request: { rememberVerificationScripts: true } }).remember, false);
});

test('only the first bounded number of requested names is considered', () => {
  const padding = Array.from({ length: MAX_REQUESTED_VERIFICATION_SCRIPTS }, (_, index) => `x${index}`);
  assert.deepEqual(resolve({ request: { verificationScripts: [...padding, 'build'] } }).scripts, []);
});

function fakePlatform({ trusted = true, failUpdate = false } = {}) {
  const updates = [];
  const warnings = [];
  return {
    updates,
    warnings,
    isWorkspaceTrusted: () => trusted,
    async updateWorkspaceSetting(key, value) {
      if (failUpdate) throw new Error('refused');
      updates.push([key, value]);
    },
    showWarningMessage: (message) => warnings.push(message),
  };
}

test('apply sets the run scripts on the detached analysis and persists only when asked', async () => {
  const platform = fakePlatform();
  const target = { verificationScripts: [], suggestedScriptNames: suggested };
  await applyVerificationOptIn(platform, target, {
    currentSetting: [],
    manifestText,
    request: { verificationScripts: ['build', 'lint'] },
  });
  assert.deepEqual(target.verificationScripts, [script('build')]);
  assert.deepEqual(platform.updates, []);

  const remembered = { verificationScripts: [], suggestedScriptNames: suggested };
  await applyVerificationOptIn(platform, remembered, {
    currentSetting: [],
    manifestText,
    request: { verificationScripts: ['test', 'lint', 'build'], rememberVerificationScripts: true },
  });
  assert.deepEqual(platform.updates, [['upgrade.verificationScripts', ['build', 'test']]]);
});

test('apply without a request leaves the analysis untouched and never reads trust', async () => {
  const platform = { isWorkspaceTrusted: () => assert.fail('trust is not needed') };
  const target = { verificationScripts: [script('lint')], suggestedScriptNames: [] };
  await applyVerificationOptIn(platform, target, { currentSetting: ['lint'], manifestText, request: {} });
  assert.deepEqual(target.verificationScripts, [script('lint')]);
});

test('apply in an untrusted workspace runs and saves nothing', async () => {
  const platform = fakePlatform({ trusted: false });
  const target = { verificationScripts: [], suggestedScriptNames: suggested };
  await applyVerificationOptIn(platform, target, {
    currentSetting: [],
    manifestText,
    request: { verificationScripts: ['build'], rememberVerificationScripts: true },
  });
  assert.deepEqual(target.verificationScripts, []);
  assert.deepEqual(platform.updates, []);
});

test('a failed save warns and still runs the accepted scripts', async () => {
  const platform = fakePlatform({ failUpdate: true });
  const target = { verificationScripts: [], suggestedScriptNames: suggested };
  await applyVerificationOptIn(platform, target, {
    currentSetting: [],
    manifestText,
    request: { verificationScripts: ['build'], rememberVerificationScripts: true },
  });
  assert.deepEqual(target.verificationScripts, [script('build')]);
  assert.equal(platform.warnings.length, 1);
});
