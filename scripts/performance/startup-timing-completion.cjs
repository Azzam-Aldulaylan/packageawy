// Decides when the dashboard has finished loading, from explicit signals
// instead of a quiet period. Used by startup-timing-suite.cjs inside VS Code
// and by the unit tests, so it has no VS Code dependency.
//
// Inputs:
//   messages  Dashboard messages from the integration test hook:
//             [{ at, direction, message: { status, data? } | { type, generatedAt } }]
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
// Likely-unused analysis is done when, after the most recent
// cleanup-analyzing message (if any), a cleanup-result or cleanup-error
// message arrived, or its "Packageawy cleanup usage analysis" report was
// printed (it is printed even when the analysis returns early without a
// message). The completion time is the last such signal in that cycle.
// Completion also waits for a rendered acknowledgement of the last snapshot posted
// after the command. generatedAt is an identity, including for warm replays.

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
  messages = messages.filter((event) => event.at >= openedAt);
  const fatal = messages.find((event) => event.message.status === 'fatal-error');
  const dataEvents = messages.filter((event) => event.direction === 'outbound' && DATA_STATUSES.has(event.message.status));
  const firstRows = dataEvents.find((event) => (event.message.data?.rows?.length ?? 0) > 0);
  const lastData = dataEvents.at(-1);
  const matchingPaint = (event, snapshots) => event.direction === 'inbound' && event.message.type === 'rendered' &&
    snapshots.some((snapshot) => snapshot.at <= event.at &&
      messages.indexOf(snapshot) < messages.indexOf(event) &&
      snapshot.message.data?.generatedAt === event.message.generatedAt);
  const lastPainted = lastData === undefined ? undefined : messages.find((event) => matchingPaint(event, [lastData]));
  const firstPaintedRows = messages.find((event) => matchingPaint(event,
    dataEvents.filter((snapshot) => (snapshot.message.data?.rows?.length ?? 0) > 0)));
  const state = {
    fatal,
    firstRows,
    firstPaintedRows,
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
  // Only the latest analysis cycle counts: the signals after the most recent
  // cleanup-analyzing start. Within it, the last result message is the end
  // (or the last report, when the analysis returned without a message).
  const latestStart = Math.max(
    -Infinity,
    ...messages.filter((event) => event.message.status === 'cleanup-analyzing').map((event) => event.at)
  );
  const cycleMessages = usageMessages.filter((event) => event.at > latestStart);
  const cycleReports = usageReports.filter((report) => report.at > latestStart);
  if (cycleMessages.length === 0 && cycleReports.length === 0) {
    state.waitingFor = 'likely-unused analysis';
    return state;
  }
  const usageDoneAt = cycleMessages.length > 0 ? cycleMessages.at(-1).at : cycleReports.at(-1).at;
  state.usageDone = true;
  if (lastPainted === undefined || (firstRows !== undefined && firstPaintedRows === undefined)) {
    state.waitingFor = 'painted rows acknowledgement';
    return state;
  }
  state.complete = true;
  state.completeAt = Math.max(lastData.at, usageDoneAt, lastPainted.at);
  return state;
}

module.exports = { completionState, reportMetadata };
