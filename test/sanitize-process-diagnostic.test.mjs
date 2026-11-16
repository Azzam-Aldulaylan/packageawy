import assert from 'node:assert/strict';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { sanitizeProcessDiagnostic as sanitize } from '../out/host/sanitizeProcessDiagnostic.js';

function home(t, value) {
  const original = os.homedir;
  os.homedir = () => value;
  syncBuiltinESMExports();
  t.after(() => { os.homedir = original; syncBuiltinESMExports(); });
}

test('Windows home paths redact case and separator variants and environment references', t => {
  home(t, 'C:\\Users\\Alice');
  for (const value of ['C:\\Users\\Alice', 'c:\\users\\alice', 'C:/Users/Alice', 'c:/USERS\\alice',
    '%USERPROFILE%', '%userprofile%', '%HOMEDRIVE%%HOMEPATH%', '%HOMEPATH%', '~']) {
    assert.equal(sanitize(`${value}/private/package.json`, '/tmp/stage'), '<home>/private/package.json', value);
  }
});

test('POSIX home and shell aliases redact only when they refer to the home', t => {
  home(t, '/Users/azzam');
  for (const value of ['/Users/azzam', '~', '$HOME', '${HOME}']) {
    assert.equal(sanitize(`${value}/private`, '/tmp/stage'), '<home>/private', value);
  }
  assert.equal(sanitize('/Users/azzam-other ~someone/private /Users/Alice/private', '/tmp/stage'),
    '/Users/azzam-other ~someone/private /Users/Alice/private');
});

test('credential redaction preserves dependency names, versions and npm lifecycle variables', () => {
  const text = '"@octokit/auth-token": "5.1.0", "auth-token": "1.2.3", "password": "2.0.0"\n' +
    '@octokit/auth-token@5.1.0 npm_package_arg=@octokit/auth-token npm_package_version=5.1.0 npm_config_registry=https://registry.npmjs.org/';
  assert.equal(sanitize(text, '/tmp/stage'), text);
});

test('credential contexts and recognizable standalone tokens remain redacted', () => {
  const secrets = ['secret-value', 'a'.repeat(36), 'b'.repeat(82), 'c'.repeat(64), Buffer.from('test secret'.repeat(6)).toString('base64')];
  const inputs = ['Authorization: Bearer secret-value', 'Proxy-Authorization: Basic secret-value',
    '_auth=secret-value', '_authToken="secret-value"', '_password=secret-value',
    'NODE_AUTH_TOKEN=secret-value', 'npmAuthIdent: secret-value',
    'https://user:secret-value@registry.example/a?token=secret-value&name=auth-token',
    '//user:secret-value@registry.example', '//registry.example/a?token=secret-value&name=auth-token', 'https://user:secret-value@[invalid',
    `npm_${secrets[1]}`, `ghp_${secrets[1]}`, `github_pat_${secrets[2]}`,
    `api_key=${secrets[3]}`, `password: ${secrets[4]}`];
  for (const text of inputs) {
    const result = sanitize(text, '/tmp/stage');
    for (const secret of secrets) assert.ok(!result.includes(secret), `${text} leaked`);
  }
  assert.equal(sanitize('npm_package_arg npm_short ghp_short', '/tmp/stage'), 'npm_package_arg npm_short ghp_short');
});
