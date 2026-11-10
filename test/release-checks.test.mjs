/**
 * The Release workflow runs scripts/release/release-checks.mjs before it
 * builds or publishes anything. These tests feed it fake changelogs, tag
 * listings and store responses, so a broken check fails here instead of
 * letting a duplicate or undated release through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateRelease,
  extractReleaseNotes,
  findChangelogSection,
  isPreReleaseMinor,
  isValidDate,
  parseMarketplaceVersions,
  parseOpenVsxVersions,
  parseRemoteTags,
} from '../scripts/release/release-checks.mjs';

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

## [0.9.5] - 2026-11-10

### Added

- Something new.

## [0.9.4] - 2026-11-02

### Fixed

- Something old.
`;

const CLEAN = {
  version: '0.9.5',
  changelog: CHANGELOG,
  preRelease: true,
  remoteTags: ['v0.9.3', 'v0.9.4'],
  marketplaceVersions: ['0.9.4', '0.9.3'],
  openVsxVersions: ['0.9.4'],
};

test('a dated, unpublished version passes', () => {
  const result = evaluateRelease(CLEAN);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('the changelog section stops at the next version heading', () => {
  assert.deepEqual(findChangelogSection(CHANGELOG, '0.9.5'), {
    date: '2026-11-10',
    body: '### Added\n\n- Something new.',
  });
  assert.equal(extractReleaseNotes(CHANGELOG, '0.9.4'), '### Fixed\n\n- Something old.');
  assert.equal(findChangelogSection(CHANGELOG, '0.9.6'), undefined);
});

test('the version is matched exactly, not as a pattern or a prefix', () => {
  const changelog = '## [0.9.50] - 2026-11-10\n\n- x\n\n## [0x9x5] - 2026-11-10\n\n- y\n';
  assert.equal(findChangelogSection(changelog, '0.9.5'), undefined);
});

test('Windows line endings still parse', () => {
  assert.equal(findChangelogSection(CHANGELOG.replaceAll('\n', '\r\n'), '0.9.5')?.date, '2026-11-10');
});

test('a missing, undated, misdated or empty section fails', () => {
  assert.match(evaluateRelease({ ...CLEAN, version: '0.9.6' }).errors[0], /no "## \[0\.9\.6\] - YYYY-MM-DD"/);
  assert.match(
    evaluateRelease({ ...CLEAN, changelog: '## [0.9.5]\n\n- x\n' }).errors[0],
    /has no date/
  );
  assert.match(
    evaluateRelease({ ...CLEAN, changelog: '## [0.9.5] - 2026-13-40\n\n- x\n' }).errors[0],
    /not a YYYY-MM-DD date/
  );
  assert.match(evaluateRelease({ ...CLEAN, changelog: '## [0.9.5] - 2026-11-10\n\n## [0.9.4]\n' }).errors[0], /empty/);
});

test('a version that is not x.y.z fails before anything else', () => {
  const result = evaluateRelease({ ...CLEAN, version: '0.9.5-beta.1' });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
});

test('an existing tag fails', () => {
  const result = evaluateRelease({ ...CLEAN, remoteTags: ['v0.9.5'] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /v0\.9\.5 already exists/);
});

test('a version already on either store fails', () => {
  assert.match(evaluateRelease({ ...CLEAN, marketplaceVersions: ['0.9.5'] }).errors[0], /Marketplace/);
  assert.match(evaluateRelease({ ...CLEAN, openVsxVersions: ['0.9.5'] }).errors[0], /Open VSX/);
});

test('lookups that could not run are skipped with a warning', () => {
  const result = evaluateRelease({
    ...CLEAN,
    remoteTags: undefined,
    marketplaceVersions: undefined,
    openVsxVersions: undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 3);
});

test('the odd and even minor rule only warns', () => {
  assert.equal(isPreReleaseMinor('0.9.5'), true);
  assert.equal(isPreReleaseMinor('1.10.0'), false);
  const stableOnOdd = evaluateRelease({ ...CLEAN, preRelease: false });
  assert.equal(stableOnOdd.ok, true);
  assert.match(stableOnOdd.warnings[0], /odd minor/);
  const preOnEven = evaluateRelease({ ...CLEAN, version: '0.10.0', changelog: '## [0.10.0] - 2026-11-10\n\n- x\n' });
  assert.equal(preOnEven.ok, true);
  assert.match(preOnEven.warnings[0], /even minor/);
});

test('dates must be real calendar dates', () => {
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-1-05'), false);
});

test('remote tags are read from git ls-remote output', () => {
  const output = 'abc\trefs/tags/v0.9.4\ndef\trefs/tags/v0.9.4^{}\n\nghi\trefs/heads/main\n';
  assert.deepEqual(parseRemoteTags(output), ['v0.9.4']);
  assert.deepEqual(parseRemoteTags(''), []);
});

test('store responses are read into version lists', () => {
  assert.deepEqual(parseMarketplaceVersions('{"versions":[{"version":"0.9.3"},{"version":"0.9.1"}]}'), [
    '0.9.3',
    '0.9.1',
  ]);
  assert.throws(() => parseMarketplaceVersions('{}'));
  assert.deepEqual(
    parseOpenVsxVersions({ version: '0.9.1', allVersions: { latest: 'u', 'pre-release': 'u', '0.9.1': 'u', '0.9.0': 'u' } }),
    ['0.9.1', '0.9.0']
  );
  assert.deepEqual(parseOpenVsxVersions({}), []);
});
