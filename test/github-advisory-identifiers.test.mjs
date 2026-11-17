import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_ADVISORIES_API,
  GITHUB_API_VERSION,
  enrichAdvisoriesWithGitHubIdentifiers,
  ghsaIdentifierFromAdvisoryUrl,
} from '../out/core/advisories/githubIdentifiers.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';

const GHSA = 'GHSA-2V37-7H3G-55P8';

function githubBody({ cve = 'CVE-2026-67213', ghsa = GHSA } = {}) {
  return JSON.stringify({
    ghsa_id: ghsa,
    cve_id: cve,
    identifiers: [
      { type: 'GHSA', value: ghsa.toLowerCase() },
      ...(cve === null ? [] : [{ type: 'CVE', value: cve.toLowerCase() }]),
      { type: 'OTHER', value: 'ignored' },
    ],
  });
}

function advisory(overrides = {}) {
  return {
    id: 1139427,
    severity: 'high',
    title: 'nanoid has a predictable-results vulnerability',
    url: 'https://github.com/advisories/GHSA-2v37-7h3g-55p8',
    vulnerableVersions: '<3.3.8',
    ...overrides,
  };
}

test('only an exact public GitHub advisory URL can produce a GHSA lookup key', () => {
  assert.equal(ghsaIdentifierFromAdvisoryUrl(advisory().url), GHSA);
  assert.equal(ghsaIdentifierFromAdvisoryUrl(`${advisory().url}/`), GHSA);
  assert.equal(ghsaIdentifierFromAdvisoryUrl(`https://github.com.evil.invalid/advisories/${GHSA}`), null);
  assert.equal(ghsaIdentifierFromAdvisoryUrl(`https://user@github.com/advisories/${GHSA}`), null);
  assert.equal(ghsaIdentifierFromAdvisoryUrl(`http://github.com/advisories/${GHSA}`), null);
  assert.equal(ghsaIdentifierFromAdvisoryUrl(`https://github.com/issues/${GHSA}`), null);
});

test('enrichment batches package filters, deduplicates GHSA aliases, and preserves unmatched npm findings', async () => {
  let calls = 0;
  let requestedUrl = '';
  let requestedOptions;
  const client = {
    async get(url, options) {
      calls += 1;
      requestedUrl = url;
      requestedOptions = options;
      return { status: 200, headers: {}, body: `[${githubBody()}]`, wireBytes: 200 };
    },
  };
  const unavailable = advisory({
    id: 2,
    severity: 'moderate',
    url: 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC',
  });
  const input = new Map([
    ['nanoid', [advisory(), advisory({ id: 3 })]],
    ['other', [unavailable]],
  ]);

  const result = await enrichAdvisoriesWithGitHubIdentifiers(client, new MemoryEtagStore(), input);
  const parsed = new globalThis.URL(requestedUrl);
  assert.equal(`${parsed.origin}${parsed.pathname}`, GITHUB_ADVISORIES_API);
  assert.equal(parsed.searchParams.get('ecosystem'), 'npm');
  assert.equal(parsed.searchParams.get('affects'), 'nanoid,other');
  assert.equal(parsed.searchParams.get('per_page'), '100');
  assert.equal(requestedOptions.headers['x-github-api-version'], GITHUB_API_VERSION);
  assert.deepEqual(result.get('nanoid')[0].identifiers, [
    { type: 'CVE', value: 'CVE-2026-67213' },
    { type: 'GHSA', value: GHSA },
  ]);
  assert.deepEqual(result.get('nanoid')[1].identifiers, result.get('nanoid')[0].identifiers);
  assert.equal(result.get('other')[0].id, 2);
  assert.equal(result.get('other')[0].identifiers, undefined);
  assert.equal(calls, 1, 'all missing aliases are queried through one documented affects batch');
});

test('a later batch page failure preserves identifiers verified on an earlier page', async () => {
  let calls = 0;
  const client = {
    async get() {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          headers: {
            link: '<https://api.github.com/advisories?ecosystem=npm&affects=nanoid%2Cother&per_page=100&after=cursor>; rel="next"',
          },
          body: `[${githubBody()}]`,
          wireBytes: 200,
        };
      }
      throw new Error('later page timed out');
    },
  };
  const input = new Map([
    ['nanoid', [advisory()]],
    ['other', [advisory({ id: 2, url: 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC' })]],
  ]);

  const result = await enrichAdvisoriesWithGitHubIdentifiers(client, new MemoryEtagStore(), input);

  assert.equal(calls, 2);
  assert.deepEqual(result.get('nanoid')[0].identifiers, [
    { type: 'CVE', value: 'CVE-2026-67213' },
    { type: 'GHSA', value: GHSA },
  ]);
  assert.equal(result.get('other')[0].identifiers, undefined);
});
