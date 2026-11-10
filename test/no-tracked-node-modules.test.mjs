/**
 * No tracked path may be named node_modules. A committed node_modules symlink
 * once made every fresh clone show it as deleted after `npm ci`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

test('git tracks nothing named node_modules', (t) => {
  if (git(['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
    t.skip('git is unavailable or this is not a checkout');
    return;
  }
  const tracked = git(['ls-files', '-s', '--', 'node_modules', ':(glob)**/node_modules', ':(glob)**/node_modules/**']);
  assert.equal(tracked?.trim(), '', `tracked node_modules entries:\n${tracked}`);
});
