/**
 * The VSIX and the JetBrains plugin ship bundled copies of runtime packages,
 * so they also ship those packages' license notices. `npm run pretest` runs
 * the build, which writes dist/ThirdPartyNotices.txt from the esbuild
 * metafiles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPackageDirs, NOTICES_FILENAME } from '../scripts/third-party-notices.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const licenseText = (pkg) => readFileSync(join(root, 'node_modules', pkg, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim();

test('the generated notices name every bundled runtime package with its full license text', () => {
  const notices = readFileSync(join(root, 'dist', NOTICES_FILENAME), 'utf8');
  for (const pkg of ['semver', 'js-yaml', 'ini', 'react', 'react-dom']) {
    const { version, license } = JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    assert.ok(notices.includes(`\n${pkg} ${version} (${license})\n`), `${pkg} has a heading`);
    assert.ok(notices.includes(licenseText(pkg)), `${pkg} license text is included`);
  }
});

test('the VSIX allowlist keeps the notices file', () => {
  const allowlist = readFileSync(join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.ok(allowlist.includes(`!dist/${NOTICES_FILENAME}`));
});

test('the JetBrains build requires and packages the notices file', () => {
  const gradle = readFileSync(join(root, 'jetbrains', 'build.gradle.kts'), 'utf8');
  assert.match(gradle, /val required = listOf\([^)]*"ThirdPartyNotices\.txt"/);
  assert.match(gradle, /include\([^)]*"ThirdPartyNotices\.txt"\)/);
  assert.match(gradle, /rootDist\.file\("ThirdPartyNotices\.txt"\)/);
});

test('only packages that contributed code count, by their innermost node_modules directory', () => {
  const dirs = bundledPackageDirs([
    {
      outputs: {
        'dist/a.js': {
          inputs: {
            'src/extension.ts': { bytesInOutput: 10 },
            'node_modules/semver/index.js': { bytesInOutput: 10 },
            'node_modules/semver/functions/gt.js': { bytesInOutput: 10 },
            'node_modules/@scope/pkg/lib/x.js': { bytesInOutput: 10 },
            'node_modules/outer/node_modules/inner/index.js': { bytesInOutput: 10 },
            'node_modules/tree-shaken/index.js': { bytesInOutput: 0 },
          },
        },
      },
    },
  ]);
  assert.deepEqual(dirs.sort(), [
    'node_modules/@scope/pkg',
    'node_modules/outer/node_modules/inner',
    'node_modules/semver',
  ]);
});
