/**
 * The Release workflow runs scripts/release/release-checks.mjs before it
 * builds or publishes anything. These tests feed it fake changelogs, tag
 * listings and store responses, so a broken check fails here instead of
 * letting a duplicate or undated release through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

test('the odd and even minor rule rejects mismatched channels', () => {
  assert.equal(isPreReleaseMinor('0.9.5'), true);
  assert.equal(isPreReleaseMinor('1.10.0'), false);
  const stableOnOdd = evaluateRelease({ ...CLEAN, preRelease: false });
  assert.equal(stableOnOdd.ok, false);
  assert.deepEqual(stableOnOdd.warnings, []);
  assert.match(stableOnOdd.errors[0], /odd minor.*--pre-release true/);
  const preOnEven = evaluateRelease({ ...CLEAN, version: '1.0.0', changelog: '## [1.0.0] - 2026-11-10\n\n- x\n' });
  assert.equal(preOnEven.ok, false);
  assert.deepEqual(preOnEven.warnings, []);
  assert.match(preOnEven.errors[0], /even minor.*--pre-release false/);
  const stable = evaluateRelease({ ...CLEAN, version: '1.0.0', preRelease: false, changelog: '## [1.0.0] - 2026-11-10\n\n- x\n' });
  assert.equal(stable.ok, true);
  assert.deepEqual(stable.errors, []);
  assert.deepEqual(stable.warnings, []);
});

test('verify exits with an error for each mismatched channel', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'release-checks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'scripts/release/release-checks.mjs');
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync('scripts/release/release-checks.mjs', script);
  for (const [version, flag, expected] of [['1.0.0', 'true', 'false'], ['1.1.0', 'false', 'true']]) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    writeFileSync(path.join(root, 'CHANGELOG.md'), `## [${version}] - 2026-11-10\n\n- Release.\n`);
    const result = spawnSync(process.execPath, [script, 'verify', '--offline', '--pre-release', flag], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`requires --pre-release ${expected}`));
    const matched = spawnSync(process.execPath, [script, 'verify', '--offline', '--pre-release', expected], { encoding: 'utf8' });
    assert.equal(matched.status, 0);
    assert.match(matched.stdout, /Release checks passed/);
  }
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
