import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasJetBrainsVersion } from '../scripts/release/check-jetbrains-version.mjs';

const update = { pluginId: 35704, version: '0.9.7', channel: '', approve: true };
const fetchJson = (body) => async () => new Response(JSON.stringify(body));

test('the exact plugin version is found using the official cross-channel endpoint', async () => {
  let calls = 0;
  const exists = await hasJetBrainsVersion('0.9.7', async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://plugins.jetbrains.com/api/plugins/io.github.azzamaldulaylan.packageawy/updates?version=0.9.7&family=intellij');
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify([update]));
  });
  assert.equal(exists, true);
  assert.equal(calls, 1);
});

test('pending review and hidden versions in other channels also prevent a duplicate upload', async () => {
  assert.equal(await hasJetBrainsVersion('0.9.7', fetchJson([
    { ...update, channel: 'beta', approve: false, hidden: true, listed: false },
  ])), true);
});

test('an absent version allows publication and version matching is exact', async () => {
  assert.equal(await hasJetBrainsVersion('0.9.7', fetchJson([])), false);
  assert.equal(await hasJetBrainsVersion('0.9.7', fetchJson([{ ...update, version: '0.9.70' }])), false);
});

test('all HTTP failures stop publication, including not found and rate limits', async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await assert.rejects(
      hasJetBrainsVersion('0.9.7', async () => new Response('Lookup failed', { status })),
      new RegExp(`HTTP ${status}`)
    );
  }
});

test('network failures and timeouts stop publication', async () => {
  for (const error of [new Error('Connection lost'), new DOMException('Timed out', 'TimeoutError')]) {
    await assert.rejects(hasJetBrainsVersion('0.9.7', async () => { throw error; }), error);
  }
});

test('malformed JSON, invalid lists and a different plugin ID stop publication', async () => {
  await assert.rejects(hasJetBrainsVersion('0.9.7', async () => new Response('<html>Unavailable</html>')), SyntaxError);
  for (const body of [null, {}, { updates: [] }, [null], [{}], [{ ...update, version: null }], [{ ...update, pluginId: 123 }]]) {
    await assert.rejects(hasJetBrainsVersion('0.9.7', fetchJson(body)), /invalid updates list/);
  }
});

test('an invalid version fails before the API request', async () => {
  for (const version of [undefined, '', '0.9.7\n', '0.9.7-beta', 'latest']) {
    await assert.rejects(hasJetBrainsVersion(version, () => assert.fail('Unexpected request')), /plain x.y.z/);
  }
});
