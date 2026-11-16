// Aggregation and table formatting for startup-timing.mjs. Kept apart from the
// runner so the unit tests can load it without starting VS Code.

export const METRICS = [
  { key: 'activationMs', label: 'activation' },
  { key: 'launchToActiveMs', label: 'launch to active' },
  { key: 'openToPanelCreatedMs', label: 'open to panel created' },
  { key: 'openToFirstRowsMs', label: 'open to first rows' },
  { key: 'openToPaintedRowsMs', label: 'open to painted rows' },
  { key: 'openToScanResultMs', label: 'open to scan result' },
  { key: 'openToCompleteMs', label: 'open to complete' },
];

function finiteSorted(values) {
  return values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
}

/** Nearest-rank percentile, so every reported value is a real sample. */
export function percentile(values, p) {
  const sorted = finiteSorted(values);
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Middle value, or the mean of the two middle values for an even count. */
export function median(values) {
  const sorted = finiteSorted(values);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(values) {
  const sorted = finiteSorted(values);
  return {
    count: sorted.length,
    median: median(sorted),
    p90: percentile(sorted, 90),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

/**
 * Groups samples by project and mode and summarizes each metric.
 * A sample is { project, mode, ok, activationMs, launchToActiveMs, ... }.
 * Failed samples are counted but left out of the numbers.
 */
export function aggregate(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.project}\u0000${sample.mode}`;
    if (!groups.has(key)) groups.set(key, { project: sample.project, mode: sample.mode, runs: 0, failed: 0, ok: [] });
    const group = groups.get(key);
    group.runs += 1;
    if (sample.ok) group.ok.push(sample);
    else group.failed += 1;
  }
  return [...groups.values()].map((group) => {
    const metrics = {};
    for (const { key } of METRICS) metrics[key] = summarize(group.ok.map((sample) => sample[key]));
    return { project: group.project, mode: group.mode, runs: group.runs, failed: group.failed, metrics };
  });
}

function ms(value) {
  return value === undefined ? '-' : String(Math.round(value));
}

/** A compact fixed-width table: one row per project, mode and metric. */
export function formatTable(summaries) {
  const header = ['project', 'mode', 'metric', 'median ms', 'p90 ms', 'min', 'max', 'runs'];
  const rows = [];
  for (const summary of summaries) {
    for (const { key, label } of METRICS) {
      const stats = summary.metrics[key];
      if (stats === undefined || stats.count === 0) continue;
      rows.push([
        summary.project,
        summary.mode,
        label,
        ms(stats.median),
        ms(stats.p90),
        ms(stats.min),
        ms(stats.max),
        summary.failed > 0 ? `${stats.count}/${summary.runs}` : String(stats.count),
      ]);
    }
  }
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const numeric = new Set([3, 4, 5, 6, 7]);
  const line = (cells) =>
    cells.map((cell, column) => (numeric.has(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ');
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

/**
 * Splits a PerformanceSession report ("Name\nstep   12.3 ms\n...") into
 * { operation, steps: [{ operation, durationMs }], totalMs }.
 */
export function parsePerformanceReport(text) {
  const lines = text.split(/\r?\n/);
  const result = { operation: lines[0] ?? '', steps: [], totalMs: undefined };
  for (const line of lines.slice(1)) {
    const match = /^(.*\S)\s+(-?\d+(?:\.\d+)?) ms$/.exec(line);
    if (!match) continue;
    const durationMs = Number(match[2]);
    if (match[1] === 'Total') result.totalMs = durationMs;
    else result.steps.push({ operation: match[1], durationMs });
  }
  return result;
}
