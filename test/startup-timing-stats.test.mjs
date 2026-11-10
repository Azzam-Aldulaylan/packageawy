/**
 * Aggregation used by scripts/performance/startup-timing.mjs: medians, p90,
 * grouping, the printed table, and parsing of performance log reports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregate,
  formatTable,
  median,
  parsePerformanceReport,
  percentile,
  summarize,
} from '../scripts/performance/startup-timing-stats.mjs';

test('median handles odd and even counts and ignores missing values', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([undefined, 7, Number.NaN]), 7);
  assert.equal(median([]), undefined);
});

test('p90 uses the nearest rank, so it is always a real sample', () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(samples, 90), 90);
  assert.equal(percentile([300, 100, 200, 500, 400], 90), 500);
  assert.equal(percentile([42], 90), 42);
  assert.equal(percentile([], 90), undefined);
});

test('summarize reports count, median, p90, min, and max', () => {
  assert.deepEqual(summarize([120, 100, 110, 400, 105]), { count: 5, median: 110, p90: 400, min: 100, max: 400 });
});

test('aggregate groups by project and mode and leaves failed runs out of the numbers', () => {
  const samples = [
    { project: 'small', mode: 'cold', ok: true, activationMs: 12, openToFirstRowsMs: 1500, openToCompleteMs: 1600 },
    { project: 'small', mode: 'cold', ok: true, activationMs: 14, openToFirstRowsMs: 1700, openToCompleteMs: 1800 },
    { project: 'small', mode: 'cold', ok: false, error: 'timed out' },
    { project: 'small', mode: 'warm', ok: true, activationMs: 11, openToFirstRowsMs: 300, openToCompleteMs: 350 },
  ];
  const [cold, warm] = aggregate(samples);
  assert.equal(cold.project, 'small');
  assert.equal(cold.mode, 'cold');
  assert.equal(cold.runs, 3);
  assert.equal(cold.failed, 1);
  assert.deepEqual(cold.metrics.openToFirstRowsMs, { count: 2, median: 1600, p90: 1700, min: 1500, max: 1700 });
  assert.equal(cold.metrics.launchToActiveMs.count, 0);
  assert.equal(warm.mode, 'warm');
  assert.equal(warm.metrics.activationMs.median, 11);
});

test('formatTable prints one aligned row per metric with data, and marks failed runs', () => {
  const table = formatTable(
    aggregate([
      { project: 'small', mode: 'cold', ok: true, activationMs: 12.4, openToFirstRowsMs: 1500 },
      { project: 'small', mode: 'cold', ok: false },
    ])
  );
  const lines = table.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^project\s+mode\s+metric\s+median ms\s+p90 ms\s+min\s+max\s+runs$/);
  assert.match(lines[1], /^-+( +-+)+$/);
  assert.match(lines[2], /^small\s+cold\s+activation\s+12\s+12\s+12\s+12\s+1\/2$/);
  assert.match(lines[3], /^small\s+cold\s+open to first rows\s+1500\s+1500\s+1500\s+1500\s+1\/2$/);
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1, 'every line has the same width');
});

test('parsePerformanceReport reads the PerformanceSession text format', () => {
  const report = parsePerformanceReport(
    [
      'Packageawy scan',
      'lockfile parse                12.5 ms',
      'version metadata resolution 1108.0 ms',
      '------------------------------------',
      'Total                       1247.1 ms',
      'requests=12  cacheHits=3',
    ].join('\n')
  );
  assert.deepEqual(report, {
    operation: 'Packageawy scan',
    steps: [
      { operation: 'lockfile parse', durationMs: 12.5 },
      { operation: 'version metadata resolution', durationMs: 1108 },
    ],
    totalMs: 1247.1,
  });
});
