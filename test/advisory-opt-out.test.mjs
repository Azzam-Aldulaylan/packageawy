/**
 * `packageawy.security.publicAdvisoryCheck`: when a project turns it off, no
 * package names go to npm's bulk advisory endpoint or GitHub, npm audit does
 * not run, availability reports 'off', and nothing reads as Safe. When it is
 * on, scans behave exactly as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPackageRows } from '../out/core/pipeline.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { isScanDataAvailability } from '../out/core/validation.js';
import { DashboardController, PUBLIC_ADVISORY_CHECK_SETTING } from '../out/host/dashboardController.js';
import { toHostToWebviewMessage } from '../out/host/dashboardData.js';
import { severityDisplay } from '../out/host/severityDisplay.js';
import { attentionCardValue, summaryMetrics, vulnerabilitiesCardValue } from '../out/host/summaryMetrics.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { isWebviewToHostMessage } from '../out/host/webviewProtocol.js';
import { RpcPlatform } from '../out/host/platform/rpc/rpcPlatform.js';

const REGISTRY = 'https://registry.npmjs.org';
const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const ROOT = '/tmp/advisory-opt-out';

const MANIFEST = JSON.stringify({
  name: 'app',
  version: '1.0.0',
  dependencies: { 'clean-pkg': '^1.0.0', minimatch: '^3.0.0' },
});
const LOCKFILE = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { 'clean-pkg': '^1.0.0', minimatch: '^3.0.0' } },
    'node_modules/clean-pkg': { version: '1.0.0' },
    'node_modules/minimatch': { version: '3.0.4' },
  },
});

const json = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body), wireBytes: JSON.stringify(body).length });

const BULK_RESPONSE = json({
  minimatch: [{
    id: 1096549,
    severity: 'high',
    title: 'minimatch ReDoS vulnerability',
    url: 'https://github.com/advisories/GHSA-f8q6-p94x-37v3',
    vulnerable_versions: '<=3.1.3',
  }],
});

function recordingClient() {
  const gets = [];
  const posts = [];
  return {
    gets,
    posts,
    async get(url) {
      gets.push(url);
      if (url === `${REGISTRY}/clean-pkg/latest`) return json({ version: '1.0.1' });
      if (url === `${REGISTRY}/minimatch/latest`) return json({ version: '3.1.5' });
      if (url === `${REGISTRY}/minimatch`) {
        return json({ 'dist-tags': { latest: '3.1.5' }, versions: { '3.0.4': {}, '3.1.5': {} } });
      }
      return { status: 404, headers: {}, body: '', wireBytes: 0 };
    },
    async post(url) {
      posts.push(url);
      return BULK_RESPONSE;
    },
  };
}

function recordingAuditRunner() {
  return {
    calls: [],
    async run(cwd) {
      this.calls.push(cwd);
      return { stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }), exitCode: 0 };
    },
  };
}

function scanOptions(client, auditRunner, extra = {}) {
  return {
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    registry: REGISTRY,
    httpClient: client,
    etagStore: new MemoryEtagStore(),
    auditRunner,
    ...extra,
  };
}

const isGitHub = (url) => url.startsWith('https://api.github.com/');

// ------------------------------------------------------------- pipeline

test('with the check off, a scan sends nothing to the advisory endpoint, GitHub, or npm audit', async () => {
  const client = recordingClient();
  const audit = recordingAuditRunner();
  const progress = [];

  const result = await buildPackageRows(scanOptions(client, audit, {
    publicAdvisoryCheck: false,
    onProgress: (event) => progress.push(event.stage),
  }));

  assert.deepEqual(client.posts, [], 'no POST to the bulk advisory endpoint');
  assert.equal(client.gets.some(isGitHub), false, 'no GitHub advisory lookups');
  assert.deepEqual(audit.calls, [], 'npm audit does not run');
  assert.equal(progress.includes('advisories'), false);
  assert.equal(progress.includes('npm-audit'), false);

  assert.deepEqual(result.availability, { updates: 'complete', advisories: 'off', unavailableUpdatePackages: [] });
  assert.equal(result.advisoriesError, undefined);
  assert.equal(result.auditUnavailable, undefined, 'a skipped audit is not reported as a failure');
  for (const row of result.rows) {
    assert.deepEqual(row.advisories, []);
    assert.equal(row.worstSeverity, null);
  }
  // Version metadata still works.
  assert.equal(result.rows.find((row) => row.name === 'clean-pkg').latest, '1.0.1');
});

test('with the check on, or left unset, the scan posts the inventory and runs npm audit as before', async () => {
  for (const extra of [{}, { publicAdvisoryCheck: true }]) {
    const client = recordingClient();
    const audit = recordingAuditRunner();

    const result = await buildPackageRows(scanOptions(client, audit, extra));

    assert.deepEqual(client.posts, [BULK]);
    assert.deepEqual(audit.calls, [ROOT]);
    assert.equal(result.availability.advisories, 'complete');
    assert.equal(result.rows.find((row) => row.name === 'minimatch').worstSeverity, 'high');
  }
});

// ------------------------------------------------------- display and wire

test('severity cells read Off, never Safe, when the check is off', () => {
  for (const severity of [null, 'high']) {
    for (const checked of [true, false]) {
      const display = severityDisplay(severity, false, checked, true);
      assert.equal(display.label, 'Off');
      assert.notEqual(display.label, 'Safe');
      assert.equal(display.className, 'info');
      assert.equal(display.reason, 'Security checks are turned off for this project');
    }
  }
  // Unchanged when the check is on.
  assert.equal(severityDisplay(null).label, 'Safe');
  assert.equal(severityDisplay(null, false).label, 'Unavailable');
});

test('summary cards say the check is off instead of reporting missing data', () => {
  const availability = { updates: 'complete', advisories: 'off', unavailableUpdatePackages: [] };
  const metrics = summaryMetrics([]);
  assert.deepEqual(vulnerabilitiesCardValue(metrics, availability), { count: 'Off', subtitle: 'Security checks are turned off' });
  assert.equal(attentionCardValue(metrics, availability).count, 0);
  assert.equal(attentionCardValue(metrics, availability).subtitle, 'Nothing needs attention');
});

test('availability accepts off, and an off scan is a ready dashboard, not a partial one', () => {
  const availability = { updates: 'complete', advisories: 'off', unavailableUpdatePackages: [] };
  assert.equal(isScanDataAvailability(availability), true);
  assert.equal(isScanDataAvailability({ ...availability, advisories: 'disabled' }), false);

  const message = toHostToWebviewMessage(
    { rows: [], availability, hygieneFindings: [] },
    { isEmpty: false, isStale: false },
    { id: 'id:app', label: 'app', manifestPath: 'package.json' },
    false,
    { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' }
  );
  assert.equal(message.status, 'ready');
  assert.equal(message.data.availability.advisories, 'off');
});

test('the webview can ask to open the advisory setting, with nothing else attached', () => {
  assert.equal(isWebviewToHostMessage({ type: 'configure-advisory-check' }), true);
  assert.equal(isWebviewToHostMessage({ type: 'configure-advisory-check', key: 'debug.performance' }), false);
});

// ------------------------------------------------------------ controller

function memoryStore() {
  const data = new Map();
  return { get: (key) => data.get(key), update: async (key, value) => void data.set(key, value) };
}

function controllerFor(client, enabled, extra = {}) {
  return new DashboardController({
    root: ROOT,
    manifestText: MANIFEST,
    lockfileText: LOCKFILE,
    lockfilePath: null,
    registry: REGISTRY,
    httpClient: client,
    etagStore: new MemoryEtagStore(),
    auditRunner: recordingAuditRunner(),
    projectInfo: { id: 'id:app', label: 'app', manifestPath: 'package.json' },
    canChangeProject: false,
    buildInfo: { extensionVersion: '0.0.1', builtAt: '2026-08-01T09:00:00.000Z' },
    projectCacheStore: new PersistentProjectCacheStore(memoryStore()),
    cacheKey: 'advisory-opt-out',
    ttlMinutesProvider: () => 30,
    publicAdvisoryCheckEnabled: (root) => {
      assert.equal(root, ROOT, 'the setting is read for the project folder');
      return enabled();
    },
    ...extra,
  });
}

function sink() {
  const posted = [];
  return { posted, postMessage: (message) => posted.push(message) };
}

test('the controller reads the setting for each scan and skips the advisory request when off', async () => {
  let enabled = false;
  const client = recordingClient();
  const controller = controllerFor(client, () => enabled);
  const first = sink();

  await controller.handleReady(first);
  const offData = first.posted.at(-1);
  assert.equal(offData.status, 'ready');
  assert.equal(offData.data.availability.advisories, 'off');
  assert.deepEqual(client.posts, []);

  enabled = true;
  const second = sink();
  await controller.handleRefresh(second);
  assert.equal(second.posted.at(-1).data.availability.advisories, 'complete');
  assert.deepEqual(client.posts, [BULK, BULK], 'installed inventory and offered versions are checked separately');
});

test('a cached scan from the other setting is not shown', async () => {
  const store = new PersistentProjectCacheStore(memoryStore());
  const entry = {
    generatedAt: new Date().toISOString(),
    lockfilePath: null,
    sourceFingerprint: computeSourceFingerprint({ manifestText: MANIFEST, lockfileText: LOCKFILE, lockfilePath: null }),
    rows: [],
    availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  };
  store.set('advisory-opt-out', entry);

  const client = recordingClient();
  const controller = controllerFor(client, () => false, { projectCacheStore: store });
  const out = sink();
  await controller.handleReady(out);

  assert.equal(out.posted[0].status, 'loading', 'the on-scan cache entry is discarded');
  assert.equal(out.posted.at(-1).data.availability.advisories, 'off');
  assert.deepEqual(client.posts, []);
});

// ---------------------------------------------------- transitive remediation

const TRANSITIVE_ROW = {
  name: 'parent',
  current: '1.0.0',
  wanted: '1.0.0',
  latest: '1.0.0',
  dev: false,
  range: '^1.0.0',
  advisories: [{
    advisory: { id: 1, severity: 'high', title: 'child issue', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', vulnerableVersions: '<2.0.0' },
    flaggedPackage: 'child',
    path: ['parent', 'child'],
    patchedVersion: { kind: 'unknown' },
  }],
  worstSeverity: 'high',
  upgradeTo: null,
  upgradeReason: null,
};

function remediationCoordinator(enabled, duringLoad = () => {}) {
  const messages = [];
  const posts = [];
  const settingReads = [];
  const coordinator = new UpgradeAssistantCoordinator({
    platform: {
      getSetting: (key, fallback, resourcePath) => {
        if (key !== PUBLIC_ADVISORY_CHECK_SETTING) return fallback;
        settingReads.push(resourcePath);
        return enabled;
      },
      isWorkspaceTrusted: () => true,
      withProgress: async (_title, task) => task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    },
    sink: { postMessage: (message) => messages.push(message) },
    httpClient: {
      async get() { throw new Error('no GET expected'); },
      async post(url) { posts.push(url); throw new Error('no POST expected'); },
    },
    etagStore: new MemoryEtagStore(),
    ensureController: async () => ({
      root: ROOT,
      upgradeSource: { manifestText: MANIFEST, lockfileText: LOCKFILE, lockfilePath: null, packageManager: 'npm', importerId: '.', lockfileName: 'package-lock.json', otherPackageManager: null },
      lastResultRows: () => [TRANSITIVE_ROW],
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', manifestPath: 'package.json', folder: { id: 'folder', name: 'app', path: ROOT } }),
    isDisposed: () => false,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
    loadProject: async () => {
      await duringLoad(coordinator);
      throw Object.assign(new Error('project read stopped here by the test'), { name: 'TEST_STOP' });
    },
  });
  return { coordinator, messages, posts, settingReads };
}

test('with the check off, a transitive fix review stops before anything is submitted', async () => {
  const { coordinator, messages, posts, settingReads } = remediationCoordinator(false);

  await coordinator.handleAnalyzeRemediation({ package: 'parent' });

  assert.deepEqual(posts, []);
  assert.deepEqual(settingReads, [ROOT]);
  assert.deepEqual(messages.map((message) => message.status), ['remediation-error']);
  assert.equal(messages[0].error.code, 'ADVISORY_CHECK_OFF');
  assert.equal(messages[0].error.message, 'Security checks are turned off for this project. Turn them on to check a fix.');
});

test('with the check on, a transitive fix review proceeds as before', async () => {
  const { coordinator, messages } = remediationCoordinator(true);

  await coordinator.handleAnalyzeRemediation({ package: 'parent' });

  assert.equal(messages[0].status, 'remediation-analyzing');
  assert.notEqual(messages.at(-1).error?.code, 'ADVISORY_CHECK_OFF');
});

for (const bulk of [false, true]) {
  test(`a setting change ends ${bulk ? 'bulk' : 'single'} transitive fix analysis with a retry message`, async () => {
    const { coordinator, messages } = remediationCoordinator(true, async coordinator => {
      assert.equal(coordinator.isRemediationBusy(), true);
      coordinator.handleAdvisorySettingChanged();
      coordinator.handleAdvisorySettingChanged(); // A burst produces one terminal state per active package.
    });
    await (bulk ? coordinator.handleAnalyzeRemediations({ packages: ['parent', 'other'] })
      : coordinator.handleAnalyzeRemediation({ package: 'parent' }));
    assert.equal(coordinator.isRemediationBusy(), false);
    assert.deepEqual(messages.filter(message => message.status === 'remediation-error'), [{
      status: 'remediation-error', package: 'parent',
      error: { code: 'ADVISORY_CHECK_CHANGED', message: 'Security checks changed. Review the fix again.' },
    }]);
    assert.equal(messages.some(message => message.status === 'remediation-plan'), false);
    if (bulk) assert.equal(messages.at(-1).status, 'remediation-batch-complete');
  });
}

// -------------------------------------------------------- settings change

test('the sidecar platform reports a change to the advisory setting, and only that one', () => {
  const listeners = new Map();
  const connection = {
    sendRequest: async () => null,
    sendNotification: () => undefined,
    onNotification: (method, handler) => listeners.set(method, handler),
  };
  const platform = new RpcPlatform(connection, {
    workspaceFolders: [],
    isWorkspaceTrusted: true,
    settings: { [PUBLIC_ADVISORY_CHECK_SETTING]: true, cacheTtlMinutes: 30 },
    workspaceState: {},
    globalState: {},
  });
  let fired = 0;
  const subscription = platform.onDidChangeSetting(PUBLIC_ADVISORY_CHECK_SETTING, () => { fired += 1; });
  const change = (settings) => listeners.get('settings/didChange')({ settings });

  change({ [PUBLIC_ADVISORY_CHECK_SETTING]: true, cacheTtlMinutes: 5 });
  assert.equal(fired, 0);
  change({ [PUBLIC_ADVISORY_CHECK_SETTING]: false, cacheTtlMinutes: 5 });
  assert.equal(fired, 1);
  assert.equal(platform.getSetting(PUBLIC_ADVISORY_CHECK_SETTING, true, ROOT), false);

  subscription.dispose();
  change({ [PUBLIC_ADVISORY_CHECK_SETTING]: true, cacheTtlMinutes: 5 });
  assert.equal(fired, 1);
});
