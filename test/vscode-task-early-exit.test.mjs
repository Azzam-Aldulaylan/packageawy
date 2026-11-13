/**
 * VS Code task exits are never lost: an exit that lands before executeTask
 * resolves, or before the caller subscribes, is still reported once, only to
 * the run it belongs to, and platform disposal settles undelivered results as unknown exactly once.
 */

import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { makeProject, makeCoordinator, review } from './helpers/removal-project.mjs';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { resolvedTarget } from './helpers/mutation-target.mjs';

/** The fake for the current test. The vscode module below delegates to it. */
let current;

function fakeTasks() {
  const native = new Set();
  const fake = {
    native,
    starts: [],
    /** Each executeTask call waits here until the test resolves or rejects it. */
    executeTask(task) {
      return new Promise((resolve, reject) => {
        fake.starts.push({ task, resolve, reject });
      });
    },
    end(execution, exitCode) {
      for (const entry of [...native]) entry.handler({ execution, exitCode });
    },
  };
  return fake;
}

const vscode = {
  RelativePattern: class {},
  workspace: {},
  ProcessExecution: class {
    constructor(process, args, options) {
      Object.assign(this, { process, args, options });
    }
  },
  Task: class {
    constructor(definition, scope, name, source, execution) {
      Object.assign(this, { definition, scope, name, source, execution });
    }
  },
  TaskScope: { Workspace: 2 },
  TaskRevealKind: { Always: 1 },
  TaskPanelKind: { Dedicated: 2 },
  // A folder that cannot be created keeps the cache in global state, off disk.
  Uri: { joinPath: (...parts) => ({ fsPath: path.join('/dev/null', 'packageawy-test', ...parts.slice(1)) }) },
  tasks: {
    onDidEndTaskProcess(handler) {
      const native = current.native;
      const entry = { handler };
      native.add(entry);
      return { dispose: () => native.delete(entry) };
    },
    executeTask: (task) => current.executeTask(task),
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
const require = createRequire(import.meta.url);
const { VsCodePlatform } = require('../out/host/platform/vscode/vsCodePlatform.js');
const { UpgradeAssistantCoordinator } = require('../out/host/upgradeAssistantCoordinator.js');

function memoryStore() {
  const values = new Map();
  return { get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); } };
}

function setup() {
  current = fakeTasks();
  const platform = new VsCodePlatform({ workspaceState: memoryStore(), globalState: memoryStore(), globalStorageUri: {} });
  return { tasks: current, platform };
}

const REQUEST = { executable: '/usr/bin/npm', args: ['install'], cwd: '/project', title: 'Packageawy: Upgrade react', scope: 'react' };

/** Lets microtasks and zero-delay timers run. */
async function settle() {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function record(running) {
  const calls = [];
  const subscription = running.onDidExit((exitCode) => calls.push(exitCode));
  return { calls, subscription };
}

/** Counts zero-delay timers that are scheduled and neither fired nor cleared. */
function trackTimers(t) {
  const pending = new Set();
  const { setTimeout: originalSet, clearTimeout: originalClear } = globalThis;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = originalSet(() => {
      pending.delete(handle);
      callback(...args);
    }, delay);
    pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle);
    originalClear(handle);
  };
  t.after(() => {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  });
  return pending;
}

test('an exit before executeTask resolves is reported to a later subscriber, never synchronously', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.end(execution, 0);
  tasks.starts[0].resolve(execution);
  const running = await starting;
  const { calls } = record(running);
  assert.deepEqual(calls, [], 'not called during subscription');
  await settle();
  assert.deepEqual(calls, [0]);
  assert.equal(tasks.native.size, 0, 'the native listener was removed');
});

test('an exit between startup and subscription is reported', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  tasks.end(execution, 0);
  await settle();
  const { calls } = record(running);
  await settle();
  assert.deepEqual(calls, [0]);
  assert.equal(tasks.native.size, 0);
});

test('an exit after subscription is reported once', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const { calls } = record(await starting);
  tasks.end(execution, 0);
  assert.deepEqual(calls, [0]);
  assert.equal(tasks.native.size, 0);
});

test('another task ending while startup is pending is ignored', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.end({}, 1);
  tasks.end(execution, 0);
  tasks.end({}, 2);
  tasks.starts[0].resolve(execution);
  const { calls } = record(await starting);
  await settle();
  tasks.end({}, 3);
  assert.deepEqual(calls, [0], 'only this task exit was taken as ours');
});

test('two runs with identical definitions each get only their own exit', async () => {
  const { tasks, platform } = setup();
  const firstStarting = platform.runProcess(REQUEST);
  const secondStarting = platform.runProcess(REQUEST);
  const firstExecution = {};
  const secondExecution = {};
  tasks.end(secondExecution, 7);
  tasks.end(firstExecution, 3);
  tasks.starts[0].resolve(firstExecution);
  tasks.starts[1].resolve(secondExecution);
  const first = record(await firstStarting);
  const second = record(await secondStarting);
  await settle();
  assert.deepEqual(first.calls, [3]);
  assert.deepEqual(second.calls, [7]);
  assert.equal(tasks.native.size, 0);
});

test('duplicate end events notify once, and the first one wins', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.end(execution, 1);
  tasks.end(execution, 0);
  tasks.starts[0].resolve(execution);
  const { calls } = record(await starting);
  await settle();
  tasks.end(execution, 0);
  await settle();
  assert.deepEqual(calls, [1]);

  const laterStarting = platform.runProcess(REQUEST);
  const later = {};
  current.starts[1].resolve(later);
  const live = record(await laterStarting);
  tasks.end(later, 0);
  tasks.end(later, 2);
  assert.deepEqual(live.calls, [0]);
});

test('an exit without a code and a non-zero code are both reported as they are', async () => {
  const { tasks, platform } = setup();
  const firstStarting = platform.runProcess(REQUEST);
  const withoutCode = {};
  tasks.end(withoutCode, undefined);
  tasks.starts[0].resolve(withoutCode);
  const first = record(await firstStarting);
  await settle();
  assert.deepEqual(first.calls, [undefined]);

  const secondStarting = platform.runProcess(REQUEST);
  const failed = {};
  tasks.starts[1].resolve(failed);
  const second = record(await secondStarting);
  tasks.end(failed, 1);
  assert.deepEqual(second.calls, [1]);
});

test('several subscribers, before and after the exit, are each told once', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  const calls = [];
  const listener = (exitCode) => calls.push(['shared', exitCode]);
  running.onDidExit(listener);
  running.onDidExit(listener);
  running.onDidExit((exitCode) => calls.push(['other', exitCode]));
  tasks.end(execution, 0);
  running.onDidExit((exitCode) => calls.push(['late', exitCode]));
  await settle();
  assert.deepEqual(calls, [['shared', 0], ['shared', 0], ['other', 0], ['late', 0]]);
});

test('a subscriber disposed before its exit or replay is not called', async (t) => {
  const timers = trackTimers(t);
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  const live = record(running);
  live.subscription.dispose();
  tasks.end(execution, 0);
  const late = record(running);
  const kept = record(running);
  late.subscription.dispose();
  assert.equal(timers.size, 1, 'only the kept replay is still scheduled');
  await settle();
  assert.deepEqual(live.calls, []);
  assert.deepEqual(late.calls, []);
  assert.deepEqual(kept.calls, [0]);
});

test('a startup that throws or rejects removes the listener and passes the error on', async () => {
  const { tasks, platform } = setup();
  const listening = [];
  tasks.executeTask = () => {
    listening.push(tasks.native.size);
    throw new Error('no task support');
  };
  await assert.rejects(platform.runProcess(REQUEST), /no task support/);
  assert.equal(tasks.native.size, 0);

  tasks.executeTask = async () => {
    listening.push(tasks.native.size);
    throw new Error('task refused');
  };
  await assert.rejects(platform.runProcess(REQUEST), /task refused/);
  assert.equal(tasks.native.size, 0);
  assert.deepEqual(listening, [1, 1], 'exits were observed while each start was pending');
});

test('disposing the platform during startup reports an unknown result after startup resolves', async (t) => {
  const timers = trackTimers(t);
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.end(execution, 0);
  platform.dispose();
  assert.equal(tasks.native.size, 0, 'the native listener was removed at disposal');
  tasks.starts[0].resolve(execution);
  const { calls } = record(await starting);
  tasks.end(execution, 0);
  await settle();
  assert.deepEqual(calls, [undefined]);
  assert.equal(tasks.native.size, 0);
  assert.equal(timers.size, 0);
});

test('disposing the platform after startup reports a lost result to attached listeners', async (t) => {
  const timers = trackTimers(t);
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  const { calls } = record(running);
  platform.dispose();
  assert.equal(tasks.native.size, 0);
  tasks.end(execution, 0);
  const late = record(running);
  await settle();
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(late.calls, [undefined]);
  assert.equal(timers.size, 0);
});

test('disposing the platform settles a queued replay as unknown', async (t) => {
  const timers = trackTimers(t);
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  tasks.end(execution, 0);
  const { calls } = record(running);
  assert.equal(timers.size, 1, 'a replay is scheduled');
  platform.dispose();
  assert.equal(timers.size, 0, 'the replay was cancelled');
  await settle();
  assert.deepEqual(calls, [undefined]);
  assert.equal(tasks.native.size, 0);
});

test('a subscriber that disposes the platform settles the remaining ones as unknown', async () => {
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  const calls = [];
  running.onDidExit((exitCode) => {
    calls.push(['first', exitCode]);
    platform.dispose();
  });
  running.onDidExit((exitCode) => calls.push(['second', exitCode]));
  tasks.end(execution, 0);
  await settle();
  assert.deepEqual(calls, [['first', 0], ['second', undefined]]);
});

test('a fresh subscription after disposal reports loss of observation', async (t) => {
  const timers = trackTimers(t);
  const { tasks, platform } = setup();
  const starting = platform.runProcess(REQUEST);
  const execution = {};
  tasks.starts[0].resolve(execution);
  const running = await starting;
  tasks.end(execution, 0);
  const first = record(running);
  const second = record(running);
  first.subscription.dispose();
  second.subscription.dispose();
  assert.equal(timers.size, 0);
  platform.dispose();
  const after = record(running);
  await settle();
  assert.deepEqual([first.calls, second.calls, after.calls], [[], [], [undefined]]);
  assert.equal(timers.size, 0, 'nothing is scheduled');
  assert.equal(tasks.native.size, 0, 'nothing is observed');
});

const MANIFEST = `${JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.3.0', react: '^18.0.0' } }, null, 2)}\n`;

function lockfile(includeReact) {
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

test('an install that exits before VS Code says it started still settles the change and frees the project', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packageawy-early-exit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'package.json');
  const lockfilePath = path.join(root, 'package-lock.json');
  await writeFile(manifestPath, MANIFEST);
  await writeFile(lockfilePath, lockfile(true));

  const { tasks, platform } = setup();
  // The package manager does its work and exits before executeTask resolves.
  tasks.executeTask = async () => {
    await writeFile(lockfilePath, lockfile(false));
    const execution = {};
    tasks.end(execution, 0);
    return execution;
  };
  const vsCodeRunProcess = platform.runProcess.bind(platform);
  const read = async () => ({
    root,
    manifestText: await readFile(manifestPath, 'utf8'),
    lockfileText: await readFile(lockfilePath, 'utf8'),
    lockfilePath,
    lockfileName: 'package-lock.json',
    registry: 'https://registry.npmjs.org/',
    resolvedRegistry: { defaultRegistry: 'https://registry.npmjs.org/', scopes: {} },
    packageManager: 'npm',
    importerId: '.',
    mutationTarget: resolvedTarget(root),
  });
  const messages = [];
  const coordinator = new UpgradeAssistantCoordinator({
    platform: {
      getSetting: (_key, fallback) => fallback,
      isWorkspaceTrusted: () => true,
      async updateWorkspaceSetting() {},
      showWarningMessage() {},
      showInformationMessage() {},
      showErrorMessage() {},
      runProcess: vsCodeRunProcess,
    },
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {},
    etagStore: {},
    ensureController: async () => ({
      root,
      upgradeSource: await read(),
      validateBulkRemoveRequest: () => ({ ok: true, removals: [{ packageName: 'react', classification: 'prod' }] }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: `file://${root}`, name: 'fixture', path: root } }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    smartCleanupRemovalEvidence: () => ({ isCurrent: () => true }),
    loadProject: read,
    changesPaused: () => false,
  });
  await coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const analysis = messages.findLast((message) => message.status === 'remove-analysis');
  assert.ok(analysis, 'the removal review was posted');

  let timer;
  const confirmed = coordinator.handleConfirmRemove({ analysisId: analysis.analysis.analysisId }).then(() => 'settled');
  const outcome = await Promise.race([
    confirmed,
    new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 5_000); }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'settled', 'the change finished instead of waiting for the install forever');
  const result = messages.findLast((message) => message.status === 'remove-result');
  assert.ok(result, `the removal finished: ${JSON.stringify(messages.at(-1))}`);
  assert.equal(result.result.outcome, 'verified');
  assert.equal(coordinator.isBusy(), false, 'the project lock was released');
  assert.equal(coordinator.isMutationBusy(), false);
  assert.equal(tasks.native.size, 0);
  platform.dispose();
});

test('VS Code drops recovery watcher events before invoking invalidation callbacks', () => {
  const callbacks = [];
  vscode.RelativePattern = class {};
  vscode.Uri.file = fsPath => ({ fsPath });
  vscode.workspace.createFileSystemWatcher = () => ({
    onDidChange: listener => callbacks.push(listener), onDidCreate: listener => callbacks.push(listener), onDidDelete: listener => callbacks.push(listener), dispose() {},
  });
  const { platform } = setup();
  const changed = [];
  platform.watchFiles('/work', '**/*', file => changed.push(file));
  for (const listener of callbacks) {
    listener({ fsPath: '/work/.packageawy-recovery/backups/package.json' });
    listener({ fsPath: '/work/package.json' });
  }
  assert.deepEqual(changed, ['/work/package.json', '/work/package.json', '/work/package.json']);
  platform.dispose();
});


test('disposal with an early-exit replay pending settles the real execution and owner as unknown', async t => {
  const project = await makeProject(t);
  const { tasks, platform } = setup();
  const locks = new ProjectMutationLocks();
  tasks.executeTask = async () => { const execution = {}; tasks.end(execution, 0); return execution; };
  const f = makeCoordinator(project, { mutationLocks: locks, mutationRoot: () => project.root,
    platform: { getSetting: (_key, fallback) => fallback, isWorkspaceTrusted: () => true, showWarningMessage() {},
      runProcess: async request => {
        const run = await platform.runProcess(request);
        return { onDidExit(listener) { const subscription = run.onDidExit(listener); platform.dispose(); return subscription; } };
      } },
  });
  f.coordinator.session.invocationResolver = () => ({ executable: 'node', prefixArgs: ['npm.js'], version: '10.0.0' });
  const analysisId = await review(f);
  let timeout;
  const result = await Promise.race([f.coordinator.handleConfirmRemove({ analysisId }).then(() => 'settled'),
    new Promise(resolve => { timeout = setTimeout(() => resolve('pending'), 2000); })]);
  clearTimeout(timeout);
  assert.equal(result, 'settled');
  const owner = locks.holderOf(canonicalProjectRoot(project.root));
  assert.equal(owner.state, 'unknown');
  assert.equal(owner.journal.data.outcome, 'unknown');
  await settle();
  assert.equal(owner.state, 'unknown');
});
