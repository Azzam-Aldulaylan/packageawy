/**
 * The "Showing partial results" banner: one sentence per symptom, naming the
 * actual cause, and never the same cause twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { partialResultsText } from '../out/host/partialResultsCopy.js';

const COMPLETE = { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] };
const data = (overrides = {}) => ({ availability: COMPLETE, ...overrides });
const advisoriesPartial = { ...COMPLETE, advisories: 'partial' };

function assertNoDuplicateSentences(text) {
  const sentences = text.split(/(?<=\.)\s+/);
  assert.equal(new Set(sentences).size, sentences.length, `duplicate sentence in: ${text}`);
}

test('nothing missing means no banner', () => {
  assert.equal(partialResultsText(data()), null);
  assert.equal(partialResultsText(data({ availability: { ...COMPLETE, advisories: 'off' } })), null);
});

test('update checks keep their count, and sign-in registries are left to their own banner', () => {
  const availability = {
    updates: 'partial',
    advisories: 'complete',
    unavailableUpdatePackages: ['a', 'b', 'c'],
    signInRequired: [{ registryHost: 'npm.example.com', packages: ['c'] }],
  };
  assert.equal(partialResultsText(data({ availability })), '2 package update checks unavailable. See the Packageawy log for the reason.');
  assert.equal(
    partialResultsText(data({ availability: { ...availability, unavailableUpdatePackages: ['a', 'c'] } })),
    '1 package update check unavailable. See the Packageawy log for the reason.'
  );
  assert.equal(
    partialResultsText(data({ availability: { ...availability, unavailableUpdatePackages: ['c'] } })),
    null,
    'only sign-in packages: nothing for this banner'
  );
});

test('a failed advisory fetch names its code', () => {
  assert.equal(
    partialResultsText(data({ availability: { ...COMPLETE, advisories: 'unavailable' }, advisoriesError: { code: 'NETWORK', message: 'x' } })),
    'Vulnerability data is unavailable (NETWORK).'
  );
});

test('each audit reason has its own sentence; a missing reason is a generic failure', () => {
  const audit = (reason) => partialResultsText(data({ auditUnavailable: true, auditUnavailableReason: reason, packageManager: 'npm' }));
  assert.equal(audit('npm-not-found'), 'npm was not found, so vulnerability fixes are estimated.');
  assert.equal(audit('timeout'), 'npm audit timed out, so vulnerability fixes are estimated.');
  assert.equal(audit('failed'), 'npm audit could not run, so vulnerability fixes are estimated.');
  assert.equal(audit(undefined), 'npm audit could not run, so vulnerability fixes are estimated.');
});

test('a missing npm lockfile replaces both the unknown-versions and the audit sentence', () => {
  const text = partialResultsText(
    data({
      availability: advisoriesPartial,
      auditUnavailable: true,
      auditUnavailableReason: 'no-lockfile',
      packageManager: 'npm',
      lockfileMissing: true,
    })
  );
  assert.equal(text, 'No package-lock.json found. Run npm install, then refresh.');
});

test('a missing lockfile also absorbs an audit failure recorded under another reason', () => {
  // A snapshot from before the reason existed, or npm failing first: the lockfile is still the cause.
  assert.equal(
    partialResultsText(data({ auditUnavailable: true, auditUnavailableReason: 'failed', packageManager: 'npm', lockfileMissing: true })),
    'No package-lock.json found. Run npm install, then refresh.'
  );
});

test('a no-lockfile reason alone is enough, even without the lockfile flag', () => {
  assert.equal(
    partialResultsText(data({ auditUnavailable: true, auditUnavailableReason: 'no-lockfile', packageManager: 'npm' })),
    'No package-lock.json found. Run npm install, then refresh.'
  );
});

test('pnpm without a lockfile names pnpm-lock.yaml, with no npm audit sentence', () => {
  assert.equal(
    partialResultsText(data({ availability: advisoriesPartial, packageManager: 'pnpm', lockfileMissing: true })),
    'No pnpm-lock.yaml found. Run pnpm install, then refresh.'
  );
});

test('an unknown package manager gets generic lockfile wording', () => {
  assert.equal(
    partialResultsText(data({ availability: advisoriesPartial, lockfileMissing: true })),
    'No lockfile found. Install dependencies, then refresh.'
  );
  assert.equal(
    partialResultsText(data({ availability: advisoriesPartial })),
    'Some packages are missing from the lockfile. Install dependencies, then refresh.'
  );
});

test('with a lockfile present, unknown versions point at the lockfile entries', () => {
  assert.equal(
    partialResultsText(data({ availability: advisoriesPartial, packageManager: 'npm' })),
    'Some packages are missing from package-lock.json. Run npm install, then refresh.'
  );
  assert.equal(
    partialResultsText(data({ availability: advisoriesPartial, packageManager: 'pnpm' })),
    'Some packages are missing from pnpm-lock.yaml. Run pnpm install, then refresh.'
  );
});

test('lockfile evidence alone, with nothing degraded, adds no banner', () => {
  assert.equal(partialResultsText(data({ packageManager: 'npm', lockfileMissing: true })), null);
});

test('the reported combination reads as distinct sentences in a fixed order', () => {
  const text = partialResultsText(
    data({
      availability: { updates: 'partial', advisories: 'partial', unavailableUpdatePackages: ['a', 'b'] },
      auditUnavailable: true,
      auditUnavailableReason: 'npm-not-found',
      packageManager: 'npm',
    })
  );
  assert.equal(
    text,
    '2 package update checks unavailable. See the Packageawy log for the reason. ' +
      'Some packages are missing from package-lock.json. Run npm install, then refresh. ' +
      'npm was not found, so vulnerability fixes are estimated.'
  );
});

test('no combination repeats a sentence', () => {
  const availabilities = [
    COMPLETE,
    advisoriesPartial,
    { updates: 'partial', advisories: 'partial', unavailableUpdatePackages: ['a'] },
    { updates: 'complete', advisories: 'unavailable', unavailableUpdatePackages: [] },
  ];
  for (const availability of availabilities) {
    for (const packageManager of [undefined, 'npm', 'pnpm']) {
      for (const lockfileMissing of [undefined, true]) {
        for (const reason of [undefined, 'no-lockfile', 'npm-not-found', 'timeout', 'failed']) {
          for (const auditUnavailable of [undefined, true]) {
            const text = partialResultsText(
              data({
                availability,
                packageManager,
                lockfileMissing,
                auditUnavailable,
                auditUnavailableReason: reason,
                ...(availability.advisories === 'unavailable' ? { advisoriesError: { code: 'TIMEOUT', message: 'x' } } : {}),
              })
            );
            if (text === null) continue;
            assertNoDuplicateSentences(text);
            assert.ok(text.endsWith('.'), text);
            assert.ok(!text.includes('..'), text);
          }
        }
      }
    }
  }
});
