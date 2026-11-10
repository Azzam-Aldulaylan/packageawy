// Runs inside the Extension Host started by run-vsix-smoke.mjs. Packageawy is
// loaded from the extensions folder the VSIX was installed into, not from the
// repository, so every check here is about the shipped archive.
const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');

const vscode = require('vscode');

const VIEW_TYPE = 'packageawy';
const TERMINAL_STATUSES = new Set(['empty', 'ready', 'partial-error']);
const POLL_MS = 100;
const TIMEOUT_MS = 90_000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await wait(POLL_MS);
  }
  throw new Error(`${message}. Last observed value: ${JSON.stringify(last)}`);
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The webview tab's viewType carries a VS Code prefix (for example
// "mainThreadWebview-packageawy"), so match on the suffix.
function dashboardTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        (tab.input.viewType === VIEW_TYPE || tab.input.viewType.endsWith(`-${VIEW_TYPE}`))
    );
}

async function run() {
  const extensionId = process.env['PACKAGEAWY_SMOKE_EXTENSION_ID'];
  const expectedVersion = process.env['PACKAGEAWY_SMOKE_EXPECTED_VERSION'];
  const extensionsDir = process.env['PACKAGEAWY_SMOKE_EXTENSIONS_DIR'];
  const fixtureRoot = process.env['PACKAGEAWY_SMOKE_FIXTURE_ROOT'];
  const reportPath = process.env['PACKAGEAWY_SMOKE_REPORT'];
  const checks = [];
  const report = { ok: false, vscodeVersion: vscode.version, extensionId, checks, error: undefined };

  try {
    assert.ok(extensionId && expectedVersion && extensionsDir && fixtureRoot && reportPath, 'Smoke environment is incomplete.');

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `${extensionId} is not installed in the test host.`);
    checks.push(`extension ${extensionId} is installed`);

    assert.ok(
      isInside(extension.extensionPath, extensionsDir),
      `${extensionId} was loaded from ${extension.extensionPath}, not from the VSIX install folder ${extensionsDir}.`
    );
    report.extensionPath = extension.extensionPath;
    checks.push('extension runs from the VSIX install folder');

    assert.equal(extension.packageJSON.version, expectedVersion, 'Installed version differs from the VSIX version.');
    checks.push(`version is ${expectedVersion}`);

    const api = await extension.activate();
    assert.equal(extension.isActive, true, 'Extension did not become active.');
    checks.push('extension activates');

    const commands = await vscode.commands.getCommands(true);
    for (const command of ['packageawy.open', 'packageawy.refresh']) {
      assert.ok(commands.includes(command), `${command} is not registered.`);
    }
    checks.push('packageawy.open and packageawy.refresh are registered');

    const started = Date.now();
    await vscode.commands.executeCommand('packageawy.open');
    await waitFor(() => dashboardTabs().length === 1, 'The Packageawy dashboard tab did not open');
    checks.push('packageawy.open shows the dashboard tab');

    // The dashboard test hooks are compiled into the shipped bundle and turn on
    // only when PACKAGEAWY_EXTENSION_TEST is set, which the runner does.
    assert.ok(api && api.dashboard, 'The packaged extension did not return its test hooks.');
    const terminal = await waitFor(() => {
      const snapshot = api.dashboard.snapshot();
      const fatal = snapshot.messages.find((event) => event.message.status === 'fatal-error');
      if (fatal) throw new Error(`Dashboard reported a fatal error: ${JSON.stringify(fatal.message.error ?? fatal.message)}`);
      return snapshot.messages.findLast((event) => TERMINAL_STATUSES.has(event.message.status));
    }, 'Dashboard did not reach a terminal state');
    report.firstScanMs = Date.now() - started;
    report.finalStatus = terminal.message.status;
    const rows = terminal.message.data?.rows ?? [];
    report.rows = rows.length;
    assert.ok(
      rows.some((row) => row.name === 'is-number'),
      'The fixture dependency is missing from the dashboard rows.'
    );
    checks.push(`dashboard reached "${terminal.message.status}" with ${rows.length} rows`);

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

module.exports = { run };
