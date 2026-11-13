/**
 * The real removal and Smart Cleanup path against a temporary npm project,
 * with only the package manager faked. Shared by the coordinator tests for
 * the internal error gate and for owner handles.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { UpgradeAssistantCoordinator } = await import('../../out/host/upgradeAssistantCoordinator.js');
const { isHostToWebviewMessage } = await import('../../out/host/webviewProtocol.js');
import { resolvedTarget } from './mutation-target.mjs';

export const MANIFEST = `${JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.3.0', react: '^18.0.0' } }, null, 2)}\n`;

export function lockfile(includeReact) {
  const dependencies = includeReact ? { 'left-pad': '^1.3.0', react: '^18.0.0' } : { 'left-pad': '^1.3.0' };
  return `${JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture', dependencies },
      'node_modules/left-pad': { version: '1.3.0' },
      ...(includeReact ? { 'node_modules/react': { version: '18.2.0' } } : {}),
    },
  }, null, 2)}\n`;
}

export async function makeProject(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-runtime-gate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'package.json');
  const lockfilePath = path.join(root, 'package-lock.json');
  await writeFile(manifestPath, MANIFEST);
  await writeFile(lockfilePath, lockfile(true));
  return { root, manifestPath, lockfilePath };
}

/** The real Smart Cleanup removal path against a temporary npm project, with only the package manager faked. */
export function makeCoordinator(project, hooks = {}) {
  const messages = [];
  const commands = [];
  const logs = [];
  const state = { paused: false, holdRead: undefined, holdInstall: undefined };
  const read = async () => {
    if (state.holdRead !== undefined) await state.holdRead();
    return {
      root: project.root,
      manifestText: await readFile(project.manifestPath, 'utf8'),
      lockfileText: await readFile(project.lockfilePath, 'utf8'),
      lockfilePath: project.lockfilePath,
      lockfileName: 'package-lock.json',
      registry: 'https://registry.npmjs.org/',
      resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
      packageManager: 'npm',
      importerId: '.',
      mutationTarget: resolvedTarget(project.root),
    };
  };
  const platform = {
    getSetting: (_key, fallback) => fallback,
    isWorkspaceTrusted: () => true,
    async updateWorkspaceSetting() {},
    showWarningMessage() {},
    showInformationMessage() {},
    showErrorMessage() {},
    log: (line) => logs.push(line),
    async runProcess(request) {
      const command = request.args.find((arg) => arg === 'install' || arg === 'ci');
      commands.push(command);
      if (command === 'install') {
        if (state.holdInstall !== undefined) await state.holdInstall();
        await writeFile(project.lockfilePath, lockfile(false));
      }
      return { onDidExit: (listener) => { setImmediate(() => listener(0)); return { dispose() {} }; } };
    },
  };
  const coordinator = new UpgradeAssistantCoordinator({
    platform,
    sink: { postMessage: (message) => {
      assert.ok(isHostToWebviewMessage(message), `invalid host message ${JSON.stringify(message)}`);
      messages.push(message);
    } },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root: project.root,
      upgradeSource: await read(),
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
    getSelectedProject: () => ({
      id: 'project',
      dir: '',
      folder: { id: `file://${project.root}`, name: 'fixture', path: project.root },
    }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    smartCleanupRemovalEvidence: () => ({ isCurrent: () => true }),
    loadProject: read,
    changesPaused: () => state.paused,
    ...hooks,
  });
  return { coordinator, messages, commands, logs, state, read };
}

export async function review(fixture) {
  await fixture.coordinator.handleAnalyzeSmartCleanupRemove({ requestId: 'cleanup', removalRequestId: 'impact', packages: ['react'] });
  const posted = fixture.messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(posted, 'the removal review was posted');
  return posted.analysis.analysisId;
}

export function blocker() {
  let release;
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return { wait: async () => { reached(); await gate; }, arrived, release };
}
