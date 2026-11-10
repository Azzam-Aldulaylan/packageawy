// Times Packageawy's startup and first scan in a real VS Code.
//
//   node scripts/performance/startup-timing.mjs --project small=/path/to/app \
//     [--project big=/path/to/other] [--vsix packageawy.vsix] [--runs 5] \
//     [--manifest big=apps/web/package.json] [--modes cold,warm] \
//     [--out timing.json] [--tmp /short/dir] [--label name] [--verbose]
//
// Without --vsix it runs `npm run package` into a temporary folder first. The
// VSIX is installed once into an empty extensions folder, the same way
// run-vsix-smoke.mjs does it, and VS Code (stable by default, cached in
// .vscode-test) is started once per run with the project folder open and
// packageawy.debug.performance turned on in a throwaway profile. Your own VS
// Code profile and extensions are never used.
//
// Each run records:
//   activation          Load Code + Call Activate + Finish Activate for
//                       Packageawy, read from VS Code's "Startup Performance"
//                       document.
//   launch to active    From starting VS Code to the suite seeing the
//                       extension active. VS Code usually activates it before
//                       the suite loads, so this is an upper bound that also
//                       includes VS Code's own startup.
//   open to first rows  From "Open in Packageawy" on the project's root
//                       package.json (or --manifest) to the first dashboard
//                       message with rows (ready, partial-error, stale, empty).
//   open to scan result To the last scan result (a warm start with an
//                       expired cache posts the cached rows, then fresh ones).
//   open to complete    To the last dashboard message, including background
//                       analyses that follow the scan (likely-unused
//                       packages), once nothing has been busy for
//                       PACKAGEAWY_TIMING_QUIET_MS (3000 by default). The quiet
//                       wait itself is not counted.
// Modes:
//   cold   A fresh user-data-dir per run: no cached scan, no ETags.
//   warm   One user-data-dir per project, primed by one unrecorded run, so the
//          scan cache and ETags from earlier runs are in place.
//
// The scan talks to the real npm registry and advisory services, as it does
// for users, so network latency shows up in the scan numbers. Compare medians
// over several runs and repeat a suspicious result. For a deterministic,
// network-free comparison use `npm run benchmark:performance`.
//
// Results: a JSON file (default .vscode-test/startup-timing.json) with every
// sample, the summaries, and the slowest steps from Packageawy's own
// performance logging, plus a table on stdout.
//
// On macOS the VS Code IPC socket path must stay under 103 characters, so
// --tmp (default: the OS temp folder) should be short, for example
// /private/tmp/<you>.
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

import { readVsix } from '../integration/check-vsix-contents.mjs';
import { aggregate, formatTable, median, parsePerformanceReport } from './startup-timing-stats.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suitePath = path.join(repositoryRoot, 'scripts', 'performance', 'startup-timing-suite.cjs');

const { values: options } = parseArgs({
  options: {
    vsix: { type: 'string' },
    project: { type: 'string', multiple: true },
    manifest: { type: 'string', multiple: true },
    runs: { type: 'string', default: '5' },
    modes: { type: 'string', default: 'cold,warm' },
    out: { type: 'string', default: path.join(repositoryRoot, '.vscode-test', 'startup-timing.json') },
    tmp: { type: 'string', default: tmpdir() },
    'vscode-version': { type: 'string', default: process.env['VSCODE_TEST_VERSION'] ?? 'stable' },
    'vscode-cache': { type: 'string', default: path.join(repositoryRoot, '.vscode-test') },
    label: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const runs = Number.parseInt(options.runs, 10);
const modes = options.modes.split(',').map((mode) => mode.trim()).filter(Boolean);
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive whole number.');
for (const mode of modes) if (mode !== 'cold' && mode !== 'warm') throw new Error(`Unknown mode "${mode}".`);
const projects = (options.project ?? []).map((value) => {
  const separator = value.indexOf('=');
  const root = path.resolve(separator === -1 ? value : value.slice(separator + 1));
  return { name: separator === -1 ? path.basename(root) : value.slice(0, separator), root };
});
if (projects.length === 0) throw new Error('Pass at least one --project name=/path/to/project.');
// A folder with more than one package.json (a monorepo, or test fixtures)
// makes packageawy.open ask which project to show. So every run opens one
// manifest with "Open in Packageawy" instead, which shows the same dashboard
// without the picker: the root package.json, or the one --manifest names.
for (const value of options.manifest ?? []) {
  const separator = value.indexOf('=');
  const project = projects.find((entry) => entry.name === value.slice(0, separator));
  if (separator === -1 || project === undefined) throw new Error(`--manifest ${value} does not match a --project name.`);
  project.manifest = path.resolve(project.root, value.slice(separator + 1));
}
for (const project of projects) {
  project.manifest ??= path.join(project.root, 'package.json');
  if (!existsSync(project.manifest)) throw new Error(`${project.manifest} does not exist.`);
}

const tempRoots = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(options.tmp, prefix));
  tempRoots.push(dir);
  return dir;
}

function run(command, args, cwd) {
  const shell = process.platform === 'win32';
  const result = spawnSync(shell ? `"${command}"` : command, shell ? args.map((arg) => `"${arg}"`) : args, {
    cwd,
    encoding: 'utf8',
    shell,
    windowsHide: true,
    timeout: 600_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}).\n${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

async function packageVsix() {
  const out = path.join(await tempDir('pkt-v-'), 'packageawy.vsix');
  console.log('[timing] packaging the extension (npm run package)');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'package', '--', '--out', out], repositoryRoot);
  return out;
}

// The runner is loaded with --extensionDevelopmentPath. It activates at
// startup, runs the timing suite, and quits VS Code through the normal
// command. That shutdown writes workspace and global state to disk, which a
// warm run needs. (runTests is not used here: in extension test mode VS Code
// keeps workspace state in memory only and also passes --no-cached-data.)
async function createRunnerExtension(root) {
  await mkdir(root, { recursive: true });
  const manifest = {
    name: 'packageawy-startup-timing-runner',
    publisher: 'packageawy-ci',
    version: '0.0.0',
    private: true,
    engines: { vscode: '^1.90.0' },
    main: './extension.js',
    activationEvents: ['*'],
  };
  const source = `const vscode = require('vscode');
exports.activate = () => {
  const suite = require('./suite.js');
  suite.run().catch(() => undefined).finally(() => vscode.commands.executeCommand('workbench.action.quit'));
};
exports.deactivate = () => {};
`;
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, 'extension.js'), source, 'utf8');
  // A copy inside the runner, so require('vscode') resolves for it.
  await copyFile(suitePath, path.join(root, 'suite.js'));
}

async function writeProfileSettings(userDataDir) {
  const settings = {
    'packageawy.debug.performance': true,
    'telemetry.telemetryLevel': 'off',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'git.enabled': false,
  };
  await mkdir(path.join(userDataDir, 'User'), { recursive: true });
  await writeFile(path.join(userDataDir, 'User', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

// VS Code prints a lot on stdout and stderr. Keep it in a log file next to
// the results (or show it with --verbose) so the summary stays readable.
const logLines = [];
function hostOutput(chunk) {
  if (options.verbose) process.stdout.write(chunk);
  else logLines.push(String(chunk));
}

const LAUNCH_TIMEOUT_MS = 300_000;

// Starts VS Code, waits for it to quit, and kills the process group it
// started if it hangs. Only processes started here are ever killed.
function startVsCode(executable, args, env) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env, detached: process.platform !== 'win32', windowsHide: true });
    child.stdout.on('data', hostOutput);
    child.stderr.on('data', hostOutput);
    const timer = setTimeout(() => {
      hostOutput(`[timing] VS Code did not quit within ${LAUNCH_TIMEOUT_MS} ms, killing it\n`);
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, LAUNCH_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: undefined, error: error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? signal });
    });
  });
}

async function launchOnce({ vscodeExecutablePath, runnerDir, extensionsDir, userDataDir, extensionId, project }) {
  const reportPath = path.join(await tempDir('pkt-s-'), 'report.json');
  logLines.push(`\n===== ${project.name} ${new Date().toISOString()} =====\n`);
  const env = {
    ...process.env,
    // Electron rejects several Node-only flags inherited from developer shells.
    NODE_OPTIONS: '',
    // Turns on the dashboard test hooks that ship in the bundle, as in the
    // VSIX smoke test. They are off for users because nothing else sets it.
    PACKAGEAWY_EXTENSION_TEST: '1',
    PACKAGEAWY_TIMING_EXTENSION_ID: extensionId,
    PACKAGEAWY_TIMING_REPORT: reportPath,
    PACKAGEAWY_TIMING_MANIFEST: project.manifest,
  };
  const args = [
    project.root,
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`,
    `--extensionDevelopmentPath=${runnerDir}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--new-window',
  ];
  const launchStartedAt = Date.now();
  const exit = await startVsCode(vscodeExecutablePath, args, env);
  const failure = exit.error ?? (exit.code === 0 ? undefined : `VS Code exited with ${exit.code}`);
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    report = { ok: false, error: failure ?? 'The timing suite wrote no report.' };
  }
  const vscodeActivation = report.activation?.vscode;
  return {
    ok: report.ok === true && failure === undefined,
    error: report.error ?? failure,
    activationMs: vscodeActivation?.totalMs,
    activation: vscodeActivation,
    launchToActiveMs:
      report.activation?.seenActiveAt === undefined ? undefined : report.activation.seenActiveAt - launchStartedAt,
    activeBeforeSuiteLoaded: report.activation?.alreadyActive,
    openToFirstRowsMs: report.scan?.openToFirstRowsMs,
    openToScanResultMs: report.scan?.openToScanResultMs,
    openToCompleteMs: report.scan?.openToCompleteMs,
    firstRowsStatus: report.scan?.firstRowsStatus,
    finalStatus: report.scan?.finalStatus,
    rows: report.scan?.rows,
    statuses: report.scan?.statuses,
    vscodeVersion: report.vscodeVersion,
    performanceLogging: report.performanceLogging,
    consoleCaptured: report.consoleCaptured,
    performanceReports: (report.performanceReports ?? []).map((entry) => parsePerformanceReport(entry.text)),
  };
}

/** Median duration per "operation > step" across all recorded runs, slowest first. */
function slowestSteps(samples) {
  const durations = new Map();
  for (const sample of samples) {
    for (const report of sample.performanceReports ?? []) {
      if (report.operation === 'Packageawy webview message') continue;
      const entries = [...report.steps, ...(report.totalMs === undefined ? [] : [{ operation: 'Total', durationMs: report.totalMs }])];
      for (const step of entries) {
        const key = `${sample.project}\u0000${sample.mode}\u0000${report.operation} > ${step.operation}`;
        if (!durations.has(key)) durations.set(key, []);
        durations.get(key).push(step.durationMs);
      }
    }
  }
  return [...durations.entries()]
    .map(([key, values]) => {
      const [project, mode, step] = key.split('\u0000');
      return { project, mode, step, medianMs: median(values), samples: values.length };
    })
    .sort((a, b) => b.medianMs - a.medianMs);
}

function gitCommit() {
  try {
    return run('git', ['rev-parse', '--short', 'HEAD'], repositoryRoot).trim();
  } catch {
    return undefined;
  }
}

const result = {
  label: options.label,
  commit: gitCommit(),
  startedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  vscodeVersion: options['vscode-version'],
  runsPerMode: runs,
  modes,
  quietMs: Number(process.env['PACKAGEAWY_TIMING_QUIET_MS'] ?? 3000),
  network: 'real registry and advisory services; expect run-to-run variance in scan times',
  projects,
  samples: [],
  summaries: [],
  slowestSteps: [],
};

try {
  const vsixPath = options.vsix ? path.resolve(options.vsix) : await packageVsix();
  const { manifest } = await readVsix(vsixPath);
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  result.vsix = { file: path.basename(vsixPath), extensionId, version: manifest.version };

  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: options['vscode-version'],
    cachePath: options['vscode-cache'],
  });
  const extensionsDir = await tempDir('pkt-e-');
  const installProfile = await tempDir('pkt-i-');
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
  run(cli, [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${installProfile}`, '--install-extension', vsixPath, '--force']);
  const installed = (await readdir(extensionsDir)).filter((name) => name.toLowerCase().startsWith(extensionId.toLowerCase()));
  if (installed.length !== 1) throw new Error(`Expected one installed ${extensionId} folder, found ${installed.length}.`);
  console.log(`[timing] installed ${extensionId}@${manifest.version} from ${path.basename(vsixPath)}`);

  const runnerDir = path.join(await tempDir('pkt-r-'), 'runner');
  await createRunnerExtension(runnerDir);
  const launch = (project, userDataDir) =>
    launchOnce({ vscodeExecutablePath, runnerDir, extensionsDir, userDataDir, extensionId, project });

  // One unrecorded start so the first recorded run does not also pay for
  // loading VS Code itself from disk.
  {
    const userDataDir = await tempDir('pkt-u');
    await writeProfileSettings(userDataDir);
    console.log('[timing] warm-up start (not recorded)');
    await launch(projects[0], userDataDir);
    await rm(userDataDir, { recursive: true, force: true });
  }

  for (const project of projects) {
    for (const mode of modes) {
      let warmProfile;
      if (mode === 'warm') {
        warmProfile = await tempDir('pkt-u');
        await writeProfileSettings(warmProfile);
        console.log(`[timing] ${project.name} warm: priming the cache (not recorded)`);
        const primed = await launch(project, warmProfile);
        if (!primed.ok) console.log(`[timing] priming run failed: ${primed.error}`);
      }
      for (let index = 1; index <= runs; index += 1) {
        let userDataDir = warmProfile;
        if (mode === 'cold') {
          userDataDir = await tempDir('pkt-u');
          await writeProfileSettings(userDataDir);
        }
        const sample = { project: project.name, mode, run: index, ...(await launch(project, userDataDir)) };
        result.samples.push(sample);
        console.log(
          `[timing] ${project.name} ${mode} ${index}/${runs}: ` +
            (sample.ok
              ? `activation ${Math.round(sample.activationMs ?? NaN)} ms, first rows ${sample.openToFirstRowsMs} ms, ` +
                `complete ${sample.openToCompleteMs} ms (${sample.finalStatus}, ${sample.rows} rows)`
              : `failed: ${sample.error}`)
        );
        if (mode === 'cold') await rm(userDataDir, { recursive: true, force: true });
      }
      if (warmProfile) await rm(warmProfile, { recursive: true, force: true });
    }
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  result.summaries = aggregate(result.samples);
  result.slowestSteps = slowestSteps(result.samples.filter((sample) => sample.ok));
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await writeFile(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (logLines.length > 0) await writeFile(`${path.resolve(options.out)}.log`, logLines.join(''), 'utf8');
}

console.log(`\nStartup timing${result.commit ? ` at ${result.commit}` : ''} (${result.vsix?.extensionId ?? 'unknown'} ${result.vsix?.version ?? ''})`);
console.log(formatTable(result.summaries));
if (result.slowestSteps.length > 0) {
  console.log('\nSlowest steps from packageawy.debug.performance (median per project and mode)');
  for (const step of result.slowestSteps.filter((entry) => !entry.step.endsWith('> Total')).slice(0, 8)) {
    console.log(`  ${String(Math.round(step.medianMs)).padStart(7)} ms  ${step.project} ${step.mode}  ${step.step}`);
  }
}
if (result.error) console.error(`Error: ${result.error}`);
console.log(`Results: ${path.resolve(options.out)}`);
