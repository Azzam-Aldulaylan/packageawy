// Copied into the runner extension that startup-timing.mjs starts VS Code
// with. Packageawy is loaded from the extensions folder the VSIX was
// installed into. The suite times one cold or warm start and writes the
// samples to a JSON file. It does not check dashboard content beyond "the
// scan reached a result".
const { writeFile } = require('node:fs/promises');

const vscode = require('vscode');

const DATA_STATUSES = new Set(['empty', 'ready', 'partial-error', 'stale']);
// Messages that mean more work is still on its way: the scan itself and the
// background analyses that start after it (likely-unused packages, Smart
// Cleanup metadata).
function isBusy(status) {
  return status === 'loading' || status.endsWith('-progress') || status.endsWith('-analyzing') || status.endsWith('-loading');
}
const POLL_MS = 10;
const TIMEOUT_MS = 180_000;
// The dashboard is complete once the last message is a result (not a busy
// message) and nothing else has arrived for this long. A warm start that
// finds an age-expired cache posts a cached result first and a revalidated
// one later, so the first result alone is not enough. The quiet time itself
// is not counted.
const QUIET_MS = Number(process.env['PACKAGEAWY_TIMING_QUIET_MS'] ?? 3000);

// Captured as early as possible, before anything else in this file waits.
const suiteLoadedAt = Date.now();
const hostUptimeAtLoadMs = Math.round(process.uptime() * 1000);

// PerformanceSession prints its reports with console.debug when
// packageawy.debug.performance is on. VS Code replaces the console methods
// with locked accessors and drops debug output in test runs, so the suite
// swaps the global console for an object that records Packageawy reports and
// passes every call on. Extension code looks up the global console at call
// time, so reports printed after this file loads are captured.
const performanceReports = [];
const hostConsole = globalThis.console;
const recordingConsole = Object.create(hostConsole);
for (const level of ['debug', 'log', 'info']) {
  Object.defineProperty(recordingConsole, level, {
    configurable: true,
    writable: true,
    value: (...args) => {
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('Packageawy ')) {
        performanceReports.push({ at: Date.now(), text: first });
      }
      return hostConsole[level](...args);
    },
  });
}
let consoleCaptured = false;
try {
  Object.defineProperty(globalThis, 'console', { configurable: true, writable: true, value: recordingConsole });
  consoleCaptured = globalThis.console === recordingConsole;
} catch {
  // Left as is: the timings still work, only the step breakdown is missing.
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(POLL_MS);
  }
  throw new Error(message);
}

// "Developer: Startup Performance" is a text document the workbench serves on
// the perf: scheme. Its extension table has the time VS Code spent loading the
// extension code and running activate(). Older or newer layouts that this
// parser does not recognise leave the field empty instead of failing the run.
async function readStartupPerformance(extensionId) {
  try {
    // The perf: provider is registered lazily, on first use of the command.
    await vscode.commands.executeCommand('perfview.show');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'perf', path: 'Startup Performance' }));
    // The document says "Loading..." until the workbench has collected the
    // numbers, then it is replaced in place.
    const deadline = Date.now() + 15_000;
    while (document.getText().trim().startsWith('Loading') && Date.now() < deadline) await wait(100);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const header = lines.find((line) => /\|\s*Extension\s*\|/.test(line) && /Activate/i.test(line));
    const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
    const row = lines.find((line) => line.startsWith('|') && cells(line)[0]?.toLowerCase() === extensionId.toLowerCase());
    if (header === undefined || row === undefined) return { available: false };
    const names = cells(header);
    const values = cells(row);
    const entry = {};
    names.forEach((name, index) => {
      entry[name] = values[index];
    });
    const number = (name) => {
      const value = Number(entry[name]);
      return Number.isFinite(value) ? value : undefined;
    };
    const loadCodeMs = number('Load Code');
    const callActivateMs = number('Call Activate');
    const finishActivateMs = number('Finish Activate');
    return {
      available: true,
      loadCodeMs,
      callActivateMs,
      finishActivateMs,
      totalMs:
        loadCodeMs === undefined || callActivateMs === undefined || finishActivateMs === undefined
          ? undefined
          : loadCodeMs + callActivateMs + finishActivateMs,
      event: entry['Event'],
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let lastSnapshot;

async function run() {
  const extensionId = process.env['PACKAGEAWY_TIMING_EXTENSION_ID'];
  const reportPath = process.env['PACKAGEAWY_TIMING_REPORT'];
  const report = {
    ok: false,
    vscodeVersion: vscode.version,
    suiteLoadedAt,
    hostUptimeAtLoadMs,
    activation: {},
    scan: {},
    consoleCaptured,
    performanceReports,
    error: undefined,
  };

  try {
    if (!extensionId || !reportPath) throw new Error('Timing environment is incomplete.');
    const extension = vscode.extensions.getExtension(extensionId);
    if (!extension) throw new Error(`${extensionId} is not installed in the test host.`);

    // workspaceContains:**/package.json usually activates the extension before
    // this suite loads. Then the time it was first seen active is the suite
    // load time, and alreadyActive says so.
    report.activation.alreadyActive = extension.isActive;
    report.performanceLogging = vscode.workspace.getConfiguration('packageawy').get('debug.performance');
    if (!extension.isActive) {
      await waitFor(() => extension.isActive, 'Packageawy did not activate on its own');
    }
    report.activation.seenActiveAt = Date.now();
    const api = await extension.activate();
    if (!api || !api.dashboard) throw new Error('The packaged extension did not return its test hooks.');
    report.activation.vscode = await readStartupPerformance(extensionId);

    const openedAt = Date.now();
    report.scan.openedAt = openedAt;
    // "Open in Packageawy" on one manifest, so a folder with several
    // package.json files does not stop at the project picker.
    const manifest = process.env['PACKAGEAWY_TIMING_MANIFEST'];
    if (manifest) await vscode.commands.executeCommand('packageawy.openPackageJson', vscode.Uri.file(manifest));
    else await vscode.commands.executeCommand('packageawy.open');
    lastSnapshot = () => api.dashboard.snapshot();

    let firstData;
    const settled = await waitFor(() => {
      const { messages } = api.dashboard.snapshot();
      const fatal = messages.find((event) => event.message.status === 'fatal-error');
      if (fatal) throw new Error(`Dashboard reported a fatal error: ${JSON.stringify(fatal.message.error ?? fatal.message)}`);
      const dataEvents = messages.filter((event) => DATA_STATUSES.has(event.message.status));
      if (firstData === undefined) {
        firstData = dataEvents.find((event) => (event.message.data?.rows?.length ?? 0) > 0) ?? undefined;
      }
      const lastEvent = messages.at(-1);
      const lastData = dataEvents.at(-1);
      if (lastEvent === undefined || lastData === undefined || isBusy(lastEvent.message.status)) return undefined;
      if (Date.now() - lastEvent.at < QUIET_MS) return undefined;
      return { lastEvent, lastData, messages };
    }, 'Dashboard did not settle on a scan result');

    const statuses = settled.messages
      .map((event) => event.message.status)
      .filter((status) => status !== 'scan-progress');
    report.scan.statuses = statuses;
    report.scan.progressMessages = settled.messages.filter((event) => event.message.status === 'scan-progress').length;
    report.scan.finalStatus = settled.lastData.message.status;
    report.scan.rows = settled.lastData.message.data?.rows?.length ?? 0;
    report.scan.openToFirstRowsMs = firstData === undefined ? undefined : firstData.at - openedAt;
    report.scan.firstRowsStatus = firstData?.message.status;
    report.scan.openToScanResultMs = settled.lastData.at - openedAt;
    report.scan.openToCompleteMs = settled.lastEvent.at - openedAt;

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    try {
      // Which messages arrived helps explain a run that did not settle.
      report.scan.statuses = lastSnapshot?.().messages.map((event) => event.message.status);
    } catch {
      // No dashboard to read.
    }
    throw error;
  } finally {
    if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

}

module.exports = { run };
