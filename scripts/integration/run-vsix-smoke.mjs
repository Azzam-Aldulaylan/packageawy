// Installs the packaged VSIX into a clean VS Code and checks that it starts.
//
//   node scripts/integration/run-vsix-smoke.mjs [path-to.vsix]
//
// The Extension Host tests load the repository with extensionDevelopmentPath,
// so they never see the archive users install. This script installs the .vsix
// with the VS Code CLI into an empty extensions folder, then starts VS Code
// with only a throwaway runner extension under development. The runner exists
// because runTests requires an extensionDevelopmentPath; the suite it runs
// checks the installed Packageawy copy, not the repository.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

import { checkVsixEntries, readVsix } from './check-vsix-contents.mjs';
import { createRealProjectFixture, FIXTURE_BASELINE_VERSION } from './real-project-fixtures.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionTestsPath = path.join(repositoryRoot, 'scripts', 'integration', 'vsix-smoke-suite.cjs');
const vscodeVersion = process.env['VSCODE_TEST_VERSION'] ?? 'stable';
const reportOutPath =
  process.env['VSIX_SMOKE_REPORT'] ?? path.join(repositoryRoot, '.vscode-test', 'vsix-smoke-report.json');

async function findVsix() {
  const fromArgs = process.argv[2];
  if (fromArgs) return path.resolve(fromArgs);
  const candidates = (await readdir(repositoryRoot)).filter((name) => name.endsWith('.vsix'));
  if (candidates.length !== 1) {
    throw new Error(
      `Pass the .vsix path as an argument. Found ${candidates.length} .vsix files in the repository root.`
    );
  }
  return path.join(repositoryRoot, candidates[0]);
}

// code.cmd on Windows only runs through a shell, so quote every argument the
// same way @vscode/test-electron does for runTests. All arguments are paths
// and flags this script created.
function runCli(cli, args) {
  const shell = process.platform === 'win32';
  const result = spawnSync(shell ? `"${cli}"` : cli, shell ? args.map((arg) => `"${arg}"`) : args, {
    encoding: 'utf8',
    shell,
    windowsHide: true,
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

async function findInstalledExtension(extensionsDir, extensionId) {
  for (const entry of await readdir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(extensionsDir, entry.name, 'package.json'), 'utf8'));
      if (`${manifest.publisher}.${manifest.name}`.toLowerCase() === extensionId.toLowerCase()) {
        return { path: path.join(extensionsDir, entry.name), version: manifest.version };
      }
    } catch {
      // Not an extension folder (for example extensions.json bookkeeping).
    }
  }
  return undefined;
}

async function createRunnerExtension(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'packageawy-vsix-smoke-runner',
        publisher: 'packageawy-ci',
        version: '0.0.0',
        private: true,
        engines: { vscode: '^1.90.0' },
        main: './extension.js',
        activationEvents: [],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    path.join(root, 'extension.js'),
    'exports.activate = () => {};\nexports.deactivate = () => {};\n',
    'utf8'
  );
}

const report = {
  vscodeVersion,
  platform: `${process.platform}-${process.arch}`,
  vsix: undefined,
  extensionId: undefined,
  expectedVersion: undefined,
  steps: [],
  suite: undefined,
  ok: false,
  error: undefined,
};

function step(name, detail) {
  report.steps.push({ name, ...detail });
  console.log(`[vsix-smoke] ${name}${detail?.info ? `: ${detail.info}` : ''}`);
}

// macOS limits Unix-domain socket paths to 103 characters, so keep the VS Code
// profile folders short, as the Extension Host runner does.
const tempRoots = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

let fixture;
try {
  const vsixPath = await findVsix();
  report.vsix = path.basename(vsixPath);
  const { entries, manifest } = await readVsix(vsixPath);
  const contents = checkVsixEntries(entries);
  if (!contents.ok) {
    throw new Error(`VSIX contents check failed: ${JSON.stringify({ missing: contents.missing, forbidden: contents.forbidden })}`);
  }
  report.extensionId = `${manifest.publisher}.${manifest.name}`;
  report.expectedVersion = manifest.version;
  step('read vsix', { info: `${report.extensionId}@${manifest.version}, ${entries.length} entries` });

  const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  step('download vscode', { info: vscodeExecutablePath });

  const extensionsDir = await tempDir('pa-vsix-e-');
  const userDataDir = await tempDir('pa-vsix-u-');
  // reuseMachineInstall keeps the helper from adding its shared profile
  // folders, so the CLI writes only to the fresh folders below.
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
  const profileArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`];
  const install = runCli(cli, [...profileArgs, '--install-extension', vsixPath, '--force']);
  if (install.error || install.status !== 0) {
    throw new Error(
      `VS Code CLI could not install the VSIX (exit ${install.status}).\n${install.error ?? ''}\n${install.stderr}\n${install.stdout}`
    );
  }
  const listed = runCli(cli, [...profileArgs, '--list-extensions', '--show-versions']);
  const expectedListing = `${report.extensionId}@${report.expectedVersion}`.toLowerCase();
  if (!listed.stdout.toLowerCase().split(/\r?\n/).includes(expectedListing)) {
    throw new Error(`VS Code CLI does not list ${expectedListing} after install. Output:\n${listed.stdout}${listed.stderr}`);
  }
  const installed = await findInstalledExtension(extensionsDir, report.extensionId);
  if (!installed) throw new Error(`No installed extension folder for ${report.extensionId} in ${extensionsDir}.`);
  if (installed.version !== report.expectedVersion) {
    throw new Error(`Installed version ${installed.version} does not match the VSIX version ${report.expectedVersion}.`);
  }
  step('install vsix', { info: path.basename(installed.path) });

  const runnerDir = path.join(await tempDir('pa-vsix-r-'), 'runner');
  await createRunnerExtension(runnerDir);

  // The dashboard scan reads the lockfile and contacts the registry, as in the
  // Extension Host job. The fixture installs one small package with npm.
  fixture = await createRealProjectFixture('npm', { dependencyVersion: FIXTURE_BASELINE_VERSION });
  step('create fixture', { info: fixture.root });

  const suiteReportPath = path.join(await tempDir('pa-vsix-s-'), 'suite-report.json');
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: runnerDir,
      extensionTestsPath,
      extensionTestsEnv: {
        // Electron rejects several Node-only flags inherited from developer
        // shells (notably --openssl-legacy-provider on VS Code 1.90).
        NODE_OPTIONS: '',
        // Turns on the dashboard test hooks that ship in the bundle. They are
        // off for users because nothing else sets this variable.
        PACKAGEAWY_EXTENSION_TEST: '1',
        PACKAGEAWY_SMOKE_EXTENSION_ID: report.extensionId,
        PACKAGEAWY_SMOKE_EXPECTED_VERSION: report.expectedVersion,
        PACKAGEAWY_SMOKE_EXTENSIONS_DIR: extensionsDir,
        PACKAGEAWY_SMOKE_FIXTURE_ROOT: fixture.root,
        PACKAGEAWY_SMOKE_REPORT: suiteReportPath,
      },
      // No --disable-extensions here: it would also disable the installed VSIX.
      launchArgs: [fixture.root, ...profileArgs],
    });
  } finally {
    try {
      report.suite = JSON.parse(await readFile(suiteReportPath, 'utf8'));
    } catch {
      // The suite did not get far enough to write a report.
    }
  }
  if (!report.suite?.ok) throw new Error(`Smoke suite failed: ${report.suite?.error ?? 'no suite report'}`);
  step('smoke suite', { info: 'passed' });
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (report.suite?.error && !report.error.includes(report.suite.error)) {
    report.error = `${report.error}\nSuite: ${report.suite.error}`;
  }
  process.exitCode = 1;
} finally {
  await fixture?.cleanup().catch(() => {});
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(path.dirname(reportOutPath), { recursive: true });
  await writeFile(reportOutPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log('\nVSIX smoke results');
console.log(`  VSIX:     ${report.vsix ?? 'unknown'}`);
console.log(`  VS Code:  ${vscodeVersion} on ${report.platform}`);
console.log(`  Result:   ${report.ok ? 'passed' : 'FAILED'}`);
if (report.suite?.checks) {
  for (const check of report.suite.checks) console.log(`  ok  ${check}`);
}
if (report.error) console.error(`  Error:    ${report.error}`);
console.log(`  Report:   ${reportOutPath}`);
