/** The sidecar's Node.js floor, from a bundled package's engines range (ini: ^18.17.0 || >=20.5.0). */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unsupportedNodeMessage } from '../out/sidecar/nodeVersion.js';

const REQUIREMENT = 'Packageawy requires a stable Node.js release: 18.17.x through 18.x, or 20.5.0 or newer.';

test('the sidecar accepts only stable Node.js 18.17.x through 18.x, or 20.5.0 or newer', () => {
  for (const version of ['18.17.0', '18.20.4', '20.5.0', '20.9.0', '22.12.0', 'v24.1.0']) {
    assert.equal(unsupportedNodeMessage(version), null, version);
  }
  for (const version of [
    '18.16.1', '16.20.2', '19.9.0', '20.4.0', 'v14.21.3',
    // Prereleases and nightlies are outside the declared range.
    'v18.17.0-pre', '20.5.0-nightly20230101abcdef', '22.0.0-rc.1',
    // Anything that is not a plain vX.Y.Z is not read at all.
    'x20.5.0y', '20.5', '020.5.0', '99999999999999999999.0.0', '',
  ]) {
    assert.equal(unsupportedNodeMessage(version), `${REQUIREMENT} Found ${version}.`, version);
  }
});

test('dist/sidecar.js stops at once on an unsupported Node.js and says why', () => {
  const sidecar = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'sidecar.js');
  const pretendOld = `data:text/javascript,${encodeURIComponent(
    "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '18.16.0' } });"
  )}`;
  const result = spawnSync(process.execPath, ['--import', pretendOld, sidecar], { input: '', encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`[packageawy] ${REQUIREMENT} Found 18.16.0.`), result.stderr);
  assert.equal(result.stdout, '', 'nothing reaches the protocol stream');
});
