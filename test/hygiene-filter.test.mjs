import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hygieneFilterCounts,
  hygieneFilterPredicate,
  rowMatchesHygieneFilter,
} from '../out/host/hygieneFilter.js';

function row(name) {
  return { name, dev: false };
}

const findings = [
  {
    packageName: 'unused-direct',
    kind: 'likely-unused',
    confidence: 'high',
    severity: 'warning',
    summary: 'unused-direct appears unused',
    evidence: { kind: 'likely-unused', reason: 'No references.', scannedFileCount: 10, truncated: false },
  },
];

test('likely-unused matches only the direct dependency named by the usage finding', () => {
  assert.equal(rowMatchesHygieneFilter(row('unused-direct'), 'likely-unused', findings), true);
  assert.equal(rowMatchesHygieneFilter(row('root-a'), 'likely-unused', findings), false);
});

test('all matches without findings and counts are per direct row', () => {
  const rows = [row('unused-direct'), row('root-a'), row('clean')];
  assert.equal(hygieneFilterPredicate('all', [])(row('clean')), true);
  assert.deepEqual(hygieneFilterCounts(rows, findings), {
    'likely-unused': 1,
  });
});
