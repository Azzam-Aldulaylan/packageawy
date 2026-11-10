import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildStagedManifest,
  buildStagedManifestForRemoval,
  preservedSpecifier,
} from '../out/core/upgrade/stagedManifest.js';
import { buildManifestReconciliationArgs } from '../out/core/upgrade/plan.js';

test('upgrade specifiers keep the declaration style where it is a plain version', () => {
  const cases = [
    ['0.21.1', '1.21.1', '1.21.1'],
    ['=0.21.1', '1.21.1', '=1.21.1'],
    ['v0.21.1', '1.21.1', '1.21.1'],
    ['^1.2.3', '2.0.0', '^2.0.0'],
    ['^v1.2.3', '2.0.0', '^2.0.0'],
    ['^ 1.2.3', '2.0.0', '^2.0.0'],
    ['  ~1.2.3  ', '1.4.0', '~1.4.0'],
    ['~ v1.2.3', '1.4.0', '~1.4.0'],
    ['~>1.2.3', '1.4.0', '~>1.4.0'],
    ['^1.2', '1.9.0', '^1.9.0'],
    ['~1', '1.9.0', '~1.9.0'],
    ['^1.0.0-beta.1', '1.0.0', '^1.0.0'],
    ['^1.0.0', '2.0.0-rc.1', '^2.0.0-rc.1'],
    // No single obvious rewrite: the exact target, as the staged path always wrote.
    ['1', '2.0.0', '2.0.0'],
    ['1.2', '1.3.0', '1.3.0'],
    ['1.x', '2.0.0', '2.0.0'],
    ['*', '2.0.0', '2.0.0'],
    ['', '2.0.0', '2.0.0'],
    ['latest', '2.0.0', '2.0.0'],
    ['>=1.0.0', '2.0.0', '2.0.0'],
    ['>=1.0.0 <2.0.0', '2.0.0', '2.0.0'],
    ['^1.0.0 || ^2.0.0', '3.0.0', '3.0.0'],
    ['1.0.0 - 2.0.0', '3.0.0', '3.0.0'],
  ];
  for (const [current, target, expected] of cases) {
    assert.equal(preservedSpecifier(current, target), expected, `${JSON.stringify(current)} -> ${target}`);
  }
});

const source = [
  '{',
  '    "name": "fixture",',
  '    "files": ["dist", "src"],',
  '    "dependencies": {',
  '        "zod": "^3.0.0",',
  '        "axios": "0.21.1",',
  '        "@scope/b": "~1.2.3",',
  '        "lodash": "^4.0.0"',
  '    },',
  '    "devDependencies": {"typescript":   "^5.0.0", "eslint": "8.0.0"},',
  '    "optionalDependencies": {',
  '        "fsevents": "~2.3.0"',
  '    }',
  '}',
  '',
].join('\n');

function withValue(text, from, to) {
  assert.equal(text.split(from).length, 2, `fixture must contain ${from} once`);
  return text.replace(from, to);
}

test('exact pins stay exact and only the changed value text differs', () => {
  const staged = buildStagedManifest(source, [
    { packageName: 'axios', target: '1.21.1', classification: 'prod' },
  ], { rangeStyle: 'preserve' });
  assert.equal(staged, withValue(source, '"axios": "0.21.1"', '"axios": "1.21.1"'));
});

test('caret, tilde and exact styles are kept across dependency blocks byte-for-byte', () => {
  const changes = [
    { packageName: 'zod', target: '4.1.0', classification: 'prod' },
    { packageName: '@scope/b', target: '1.4.0', classification: 'prod' },
    { packageName: 'typescript', target: '5.6.2', classification: 'dev' },
    { packageName: 'eslint', target: '9.1.0', classification: 'dev' },
    { packageName: 'fsevents', target: '2.3.3', classification: 'optional' },
  ];
  let expected = source;
  expected = withValue(expected, '"zod": "^3.0.0"', '"zod": "^4.1.0"');
  expected = withValue(expected, '"@scope/b": "~1.2.3"', '"@scope/b": "~1.4.0"');
  expected = withValue(expected, '"typescript":   "^5.0.0"', '"typescript":   "^5.6.2"');
  expected = withValue(expected, '"eslint": "8.0.0"', '"eslint": "9.1.0"');
  expected = withValue(expected, '"fsevents": "~2.3.0"', '"fsevents": "~2.3.3"');
  assert.equal(buildStagedManifest(source, changes, { rangeStyle: 'preserve' }), expected);

  // The default (resolution pass) writes exact targets with the same layout.
  const exact = buildStagedManifest(source, changes);
  assert.match(exact, /"zod": "4\.1\.0",\n        "axios"/);
  assert.match(exact, /\{"typescript":   "5\.6\.2", "eslint": "9\.1\.0"\}/);
});

test('CRLF, tabs, missing final newline and minified text are preserved', () => {
  const crlf = '{\r\n\t"dependencies": {\r\n\t\t"b": "^1.0.0",\r\n\t\t"a": "1.0.0"\r\n\t}\r\n}';
  assert.equal(
    buildStagedManifest(crlf, [{ packageName: 'a', target: '2.0.0', classification: 'prod' }], { rangeStyle: 'preserve' }),
    crlf.replace('"a": "1.0.0"', '"a": "2.0.0"')
  );
  const minified = '{"dependencies":{"b":"^1.0.0","a":"^1.0.0"}}\n';
  assert.equal(
    buildStagedManifest(minified, [{ packageName: 'a', target: '1.5.0', classification: 'prod' }], { rangeStyle: 'preserve' }),
    '{"dependencies":{"b":"^1.0.0","a":"^1.5.0"}}\n'
  );
});

test('a duplicated key is edited where JSON.parse reads it (the last one)', () => {
  const duplicated = '{"dependencies": {"a": "1.0.0", "a": "^1.0.0"}}';
  const staged = buildStagedManifest(duplicated, [{ packageName: 'a', target: '1.2.0', classification: 'prod' }], { rangeStyle: 'preserve' });
  assert.equal(staged, '{"dependencies": {"a": "1.0.0", "a": "^1.2.0"}}');
});

test('removal deletes only the member text and never re-sorts siblings', () => {
  const remove = (packageName, classification) =>
    buildStagedManifestForRemoval(source, [{ packageName, classification }]);
  assert.equal(remove('axios', 'prod'), source.replace(',\n        "axios": "0.21.1"', ''));
  assert.equal(remove('zod', 'prod'), source.replace('"zod": "^3.0.0",\n        ', ''));
  assert.equal(remove('lodash', 'prod'), source.replace(',\n        "lodash": "^4.0.0"', ''));
  assert.equal(remove('typescript', 'dev'), source.replace('"typescript":   "^5.0.0", ', ''));
  assert.equal(remove('fsevents', 'optional'), source.replace('{\n        "fsevents": "~2.3.0"\n    }', '{}'));

  const several = buildStagedManifestForRemoval(source, [
    { packageName: 'zod', classification: 'prod' },
    { packageName: 'lodash', classification: 'prod' },
    { packageName: 'eslint', classification: 'dev' },
  ]);
  assert.equal(
    several,
    source
      .replace('"zod": "^3.0.0",\n        ', '')
      .replace(',\n        "lodash": "^4.0.0"', '')
      .replace(', "eslint": "8.0.0"', '')
  );
});

test('the lockfile-only restyle pass never runs scripts or touches node_modules', () => {
  assert.deepEqual(buildManifestReconciliationArgs('npm', { ignoreScripts: false, lockfileOnly: true }), [
    'install', '--package-lock-only', '--ignore-scripts',
  ]);
  assert.deepEqual(buildManifestReconciliationArgs('pnpm', { ignoreScripts: false, lockfileOnly: true }), [
    'install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts',
  ]);
  assert.deepEqual(
    buildManifestReconciliationArgs('pnpm', {
      ignoreScripts: true,
      lockfileOnly: true,
      workspace: { importerId: '.', hasWorkspaceManifest: true },
    }),
    ['install', '--lockfile-only', '--no-frozen-lockfile', '-w', '--ignore-scripts']
  );
  // Neither pass names a package, so no save-prefix or key re-sort applies.
  for (const manager of ['npm', 'pnpm']) {
    for (const args of [
      buildManifestReconciliationArgs(manager, { ignoreScripts: true }),
      buildManifestReconciliationArgs(manager, { ignoreScripts: true, lockfileOnly: true }),
    ]) {
      assert.ok(args.every((arg) => !arg.includes('@')));
      assert.equal(args.includes('add'), false);
    }
  }
});
