/**
 * CI runs scripts/integration/check-vsix-contents.mjs on the packaged VSIX.
 * These tests feed it fake entry lists, and a tiny hand-built zip for the
 * reader, so a broken check fails here instead of silently passing in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  checkVsixEntries,
  readZipDirectory,
  readZipEntry,
  REQUIRED_ENTRIES,
} from '../scripts/integration/check-vsix-contents.mjs';

const SHIPPED = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  ...REQUIRED_ENTRIES,
  'extension/dist/webview.css',
  'extension/media/icon.png',
  'extension/readme.md',
  'extension/LICENSE.txt',
];

test('a VSIX with exactly the runtime files passes', () => {
  assert.deepEqual(checkVsixEntries(SHIPPED), { ok: true, missing: [], forbidden: [] });
});

test('each required file is reported when missing', () => {
  for (const required of REQUIRED_ENTRIES) {
    const result = checkVsixEntries(SHIPPED.filter((name) => name !== required));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [required]);
  }
});

test('source maps, src, test and node_modules files are rejected', () => {
  const result = checkVsixEntries([
    ...SHIPPED,
    'extension/dist/extension.js.map',
    'extension/src/extension.ts',
    'extension/test/http.test.mjs',
    'extension/node_modules/semver/index.js',
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.forbidden.map((entry) => entry.reason),
    ['source map', 'source folder', 'test folder', 'node_modules folder']
  );
});

test('folder rules match whole path segments only', () => {
  const result = checkVsixEntries([
    ...SHIPPED,
    'extension/dist/srcset-helper.js',
    'extension/media/test.png',
    'extension/dist/testing/notes.txt',
  ]);
  assert.deepEqual(result.forbidden, []);
});

test('Windows separators are normalised before checking', () => {
  const result = checkVsixEntries([...SHIPPED, 'extension\\src\\extension.ts']);
  assert.deepEqual(result.forbidden, [{ name: 'extension/src/extension.ts', reason: 'source folder' }]);
});

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

test('the zip reader lists entries and reads stored and deflated files', () => {
  const manifest = Buffer.from(JSON.stringify({ name: 'packageawy', version: '1.2.3' }));
  const zip = buildZip([
    { name: 'extension/package.json', data: manifest, deflate: true },
    { name: 'extension/readme.md', data: Buffer.from('hello'), deflate: false },
  ]);
  const entries = readZipDirectory(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ['extension/package.json', 'extension/readme.md']);
  assert.deepEqual(JSON.parse(readZipEntry(zip, entries[0]).toString('utf8')), {
    name: 'packageawy',
    version: '1.2.3',
  });
  assert.equal(readZipEntry(zip, entries[1]).toString('utf8'), 'hello');
});

test('the zip reader rejects a file that is not a zip', () => {
  assert.throws(() => readZipDirectory(Buffer.alloc(64)), /Not a zip file/);
});
