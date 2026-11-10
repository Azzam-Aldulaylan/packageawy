// Decides when the dashboard has finished loading, from explicit signals
// instead of a quiet period. Used by startup-timing-suite.cjs inside VS Code
// and by the unit tests, so it has no VS Code dependency.
//
// Inputs:
//   messages  Dashboard messages from the integration test hook:
//             [{ at, message: { status, data? } }]
//   reports   Packageawy performance reports printed with
//             packageawy.debug.performance on: [{ at, text }]
//   openedAt  When the dashboard was opened (same clock as `at`).
//
// The scan is done when:
//   - the "Packageawy cache" report has been printed (handleReady always
//     prints one before it posts anything),
//   - if that report was not a fresh cache hit, a "Packageawy scan" report
//     has been printed after it (run() prints it when the scan has finished,
//     whatever the outcome),
//   - no scan message (loading, scan-progress, stale) arrived after the
//     latest scan report, which would mean another scan is running, and
//   - a result message (ready, partial-error, stale, empty) has arrived.
// Likely-unused analysis is done when a cleanup-result or cleanup-error
// message arrived, or its "Packageawy cleanup usage analysis" report was
// printed (it is printed even when the analysis returns early without a
// message), with no cleanup-analyzing message after it.

const DATA_STATUSES = new Set(['empty', 'ready', 'partial-error', 'stale']);
const SCAN_BUSY_STATUSES = new Set(['loading', 'scan-progress', 'stale']);

function operationOf(report) {
  return report.text.split(/\r?\n/, 1)[0];
}

/** Reads the "name=value  name=value" line at the end of a report. */
function reportMetadata(report) {
  const lines = report.text.split(/\r?\n/);
  const metadata = {};
  for (const line of lines.slice(1)) {
    if (/ ms$/.test(line) || !line.includes('=')) continue;
    for (const pair of line.trim().split(/\s{2,}/)) {
      const separator = pair.indexOf('=');
      if (separator > 0) metadata[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return metadata;
}

function completionState({ messages, reports, openedAt }) {
  const fatal = messages.find((event) => event.message.status === 'fatal-error');
  const dataEvents = messages.filter((event) => DATA_STATUSES.has(event.message.status));
  const firstRows = dataEvents.find((event) => (event.message.data?.rows?.length ?? 0) > 0);
  const lastData = dataEvents.at(-1);
  const state = {
    fatal,
    firstRows,
    lastData,
    scanDone: false,
    usageDone: false,
    complete: false,
    completeAt: undefined,
    waitingFor: undefined,
  };
  if (fatal) return state;

  const recent = reports.filter((report) => report.at >= openedAt);
  const cache = recent.find((report) => operationOf(report) === 'Packageawy cache');
  if (cache === undefined) {
    state.waitingFor = 'cache report';
    return state;
  }
  const metadata = reportMetadata(cache);
  const freshHit = metadata.hit === 'true' && metadata.freshness === 'fresh';
  const scanReports = recent.filter((report) => operationOf(report) === 'Packageawy scan' && report.at >= cache.at);
  if (!freshHit && scanReports.length === 0) {
    state.waitingFor = 'scan report';
    return state;
  }
  const latestScanAt = scanReports.at(-1)?.at ?? cache.at;
  if (messages.some((event) => SCAN_BUSY_STATUSES.has(event.message.status) && event.at > latestScanAt)) {
    state.waitingFor = 'scan in progress';
    return state;
  }
  if (lastData === undefined) {
    state.waitingFor = 'scan result';
    return state;
  }
  state.scanDone = true;

  const usageMessages = messages.filter(
    (event) => event.message.status === 'cleanup-result' || event.message.status === 'cleanup-error'
  );
  const usageReports = recent.filter((report) => operationOf(report) === 'Packageawy cleanup usage analysis');
  const usageDoneAt = [...usageMessages.map((event) => event.at), ...usageReports.map((report) => report.at)].sort(
    (a, b) => a - b
  )[0];
  if (usageDoneAt === undefined) {
    state.waitingFor = 'likely-unused analysis';
    return state;
  }
  const lastUsageSignal = Math.max(
    ...usageMessages.map((event) => event.at),
    ...usageReports.map((report) => report.at)
  );
  if (messages.some((event) => event.message.status === 'cleanup-analyzing' && event.at > lastUsageSignal)) {
    state.waitingFor = 'likely-unused analysis';
    return state;
  }
  state.usageDone = true;
  state.complete = true;
  state.completeAt = Math.max(lastData.at, usageDoneAt);
  return state;
}

module.exports = { completionState, reportMetadata };
