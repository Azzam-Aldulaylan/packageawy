/**
 * The Available column's display decision: pure, no React/DOM
 * involved. See upgrade-action.test.mjs for why this repo tests presentation
 * logic this way instead of rendering components.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentVersionDisplay, availableVersionDisplay, availablePrimaryVersion } from '../out/host/versionDisplay.js';

const fields = (current, wanted, latest, upgradeTo = null) => ({ current, wanted, latest, upgradeTo });

test('neither value present renders an em dash', () => {
  assert.deepEqual(availableVersionDisplay(fields('1.0.0', null, null)), { kind: 'dash' });
});

test('up to date: the single value has no caption and no update', () => {
  assert.deepEqual(availableVersionDisplay(fields('20.19.43', '20.19.43', '20.19.43')), {
    kind: 'version', value: '20.19.43', suggested: false, caption: null, updateKind: null,
  });
});

test('offered upgrade equal to latest and wanted keeps the "Latest · within range" caption', () => {
  assert.deepEqual(availableVersionDisplay(fields('20.0.0', '20.19.43', '20.19.43', '20.19.43')), {
    kind: 'version', value: '20.19.43', suggested: true, caption: { kind: 'latest-within-range' }, updateKind: 'minor',
  });
});

test('offered upgrade equal to latest but outside the range is captioned "Latest" only', () => {
  assert.deepEqual(availableVersionDisplay(fields('20.19.43', '20.19.43', '26.1.2', '26.1.2')), {
    kind: 'version', value: '26.1.2', suggested: true, caption: { kind: 'latest' }, updateKind: 'major',
  });
});

test('an offered upgrade that is not the latest is the bold value, with the latest underneath (axios case)', () => {
  assert.deepEqual(availableVersionDisplay(fields('0.21.1', '0.21.1', '1.21.1', '0.21.4')), {
    kind: 'version', value: '0.21.4', suggested: true, caption: { kind: 'other-latest', version: '1.21.1' }, updateKind: 'patch',
  });
});

test('no offered upgrade falls back to latest, then wanted, and is not marked suggested', () => {
  const alias = availableVersionDisplay(fields('1.0.0', '1.0.0', '2.0.0'));
  assert.equal(alias.value, '2.0.0');
  assert.equal(alias.suggested, false);
  assert.deepEqual(alias.caption, { kind: 'latest' });
  assert.equal(availableVersionDisplay(fields('1.0.0', '1.2.0', null)).value, '1.2.0');
});

test('the within-range line is gone: no caption ever names the wanted version', () => {
  const display = availableVersionDisplay(fields('20.19.43', '20.19.43', '26.1.2', '26.1.2'));
  assert.ok(!JSON.stringify(display).includes('withinRange'));
});

test('no resolved current version never classifies an update', () => {
  assert.deepEqual(availableVersionDisplay(fields(null, '20.19.43', '20.19.43')), {
    kind: 'version', value: '20.19.43', suggested: false, caption: null, updateKind: null,
  });
});

test('availablePrimaryVersion prefers the offered upgrade, then latest, then wanted', () => {
  assert.equal(availablePrimaryVersion({ upgradeTo: '0.21.4', latest: '1.21.1', wanted: '0.21.1' }), '0.21.4');
  assert.equal(availablePrimaryVersion({ upgradeTo: null, latest: '1.21.1', wanted: '0.21.1' }), '1.21.1');
  assert.equal(availablePrimaryVersion({ upgradeTo: null, latest: null, wanted: '0.21.1' }), '0.21.1');
  assert.equal(availablePrimaryVersion({ upgradeTo: null, latest: null, wanted: null }), null);
});

test('a resolved current version with no unresolvable reason is shown as-is, untagged', () => {
  assert.deepEqual(currentVersionDisplay('1.0.0', '^1.0.0', undefined), {
    kind: 'resolved',
    value: '1.0.0',
    tag: null,
  });
});

test('a resolved current version can still carry a tag: e.g. a git/file/tarball dependency with a real resolved version', () => {
  assert.deepEqual(currentVersionDisplay('1.2.3', '^1.0.0', 'git'), {
    kind: 'resolved',
    value: '1.2.3',
    tag: 'git',
  });
});

test('no resolved version, with an explicit unresolvable reason, falls back to the declared range tagged with that reason', () => {
  assert.deepEqual(currentVersionDisplay(null, '^18.2.0', 'workspace-link'), {
    kind: 'declared-range',
    value: '^18.2.0',
    tag: 'workspace-link',
  });
  assert.deepEqual(currentVersionDisplay(null, 'file:../shared', 'file'), {
    kind: 'declared-range',
    value: 'file:../shared',
    tag: 'file',
  });
  assert.deepEqual(currentVersionDisplay(null, '^1.0.0', 'no-lockfile'), {
    kind: 'declared-range',
    value: '^1.0.0',
    tag: 'no-lockfile',
  });
});

test('no resolved version and no unresolvable reason still falls back to the declared range, tagged "unresolved", a dependency declared but missing from an otherwise-present lockfile', () => {
  assert.deepEqual(currentVersionDisplay(null, '^1.0.0', undefined), {
    kind: 'declared-range',
    value: '^1.0.0',
    tag: 'unresolved',
  });
});

test('no resolved version and no declared range (defensive: should not occur in practice) renders a dash, still tagged', () => {
  assert.deepEqual(currentVersionDisplay(null, '', undefined), { kind: 'dash', tag: 'unresolved' });
  assert.deepEqual(currentVersionDisplay(null, '', 'no-lockfile'), { kind: 'dash', tag: 'no-lockfile' });
});
