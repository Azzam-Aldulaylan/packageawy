import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardController } from '../out/host/dashboardController.js';
import { UpdateAdvisories, offeredVersionPairs } from '../out/host/updateAdvisories.js';
import { sameUpdateAdvisoryContext } from '../out/host/updateAdvisoryState.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { computeSourceFingerprint } from '../out/core/cache/sourceFingerprint.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { RpcWebviewChannel } from '../out/host/platform/rpc/rpcWebviewChannel.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const json = value => ({ status: 200, headers: {}, body: JSON.stringify(value), wireBytes: 1 });
const raw = (range, id = 1) => ({ id, severity: 'high', title: 'Known vulnerability', url: 'https://example.com/advisory', vulnerable_versions: range });
const projectInfo = { id: 'fixture', label: 'fixture', manifestPath: 'package.json' };
const row = { name: 'app', current: '1.0.0', wanted: '1.1.0', latest: '2.0.0', upgradeTo: '2.0.0',
  upgradeReason: 'update', range: '^1.0.0', dev: false, optional: false, worstSeverity: null, advisories: [] };

function fixture({ rows = [row], cached = true, get, post = async () => json({}), enabled = () => true, manifest } = {}) {
  const dependencies = Object.fromEntries(rows.map(row => [row.name, row.range]));
  const manifestText = manifest ?? JSON.stringify({ dependencies });
  const lockfileText = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies },
    ...Object.fromEntries(rows.map(row => [`node_modules/${row.name}`, { version: row.current }])) } });
  const snapshot = { rows, generatedAt: new Date(Date.now() - 60_000).toISOString(), lockfilePath: null,
    sourceFingerprint: computeSourceFingerprint({ manifestText, lockfileText, lockfilePath: null }),
    availability: { updates: 'complete', advisories: enabled() ? 'complete' : 'off', unavailableUpdatePackages: [] } };
  const posted = [], requests = [], events = [], persisted = [];
  const client = { get: get ?? (async url => json(url.endsWith('/latest') ? { version: rows[0].latest } : {
    'dist-tags': { latest: rows[0].latest }, versions: Object.fromEntries([rows[0].current, rows[0].wanted, rows[0].latest].map(version => [version, { version }])) })),
    post: async (url, body, options) => { events.push('request'); requests.push(JSON.parse(body)); return post(url, body, options); } };
  const options = { root: '/fixture', manifestText, lockfileText, lockfilePath: null,
    registry: 'https://registry.npmjs.org', projectInfo, canChangeProject: false,
    httpClient: client, etagStore: new MemoryEtagStore(),
    buildInfo: { extensionVersion: 'test', builtAt: 'test' },
    projectCacheStore: { get: () => cached ? snapshot : undefined, set: (_, value) => persisted.push(value), delete() {} },
    cacheKey: 'fixture', ttlMinutesProvider: () => 30, publicAdvisoryCheckEnabled: enabled };
  const controller = new DashboardController(options);
  const sink = { postMessage(message) { events.push(message.status); posted.push(message); } };
  return { controller, sink, posted, requests, events, snapshot, persisted, options, client };
}
const updates = f => f.posted.filter(message => message.status === 'update-advisories');

for (const [name, current, latest, range] of [
  ['minimist', '0.2.4', '1.2.5', '>=1.0.0 <1.2.6'],
  ['lodash', '2.4.2', '4.17.20', '>=3.7.0 <4.17.21'],
]) {
  test(`${name}: an omitted installed version never implies a clean offered version`, async () => {
    const f = fixture({ cached: false, rows: [{ ...row, name, current, latest, wanted: current, range: `^${current}` }],
      post: async (_, body) => json(JSON.parse(body)[name]?.includes(latest) ? { [name]: [raw(range)] } : {}) });
    await f.controller.handleReady(f.sink);
    await tick();
    const dashboard = f.posted.find(message => 'data' in message);
    assert.equal(dashboard.data.rows[0].worstSeverity, null, 'the installed tree is clean');
    const result = updates(f).at(-1).results.find(result => result.version === latest);
    assert.deepEqual(result, { name, version: latest, status: 'checked', count: 1, highestSeverity: 'high' });
    assert.ok(f.events.indexOf(dashboard.status) < f.events.lastIndexOf('request'), 'rows precede enrichment dispatch');
    assert.equal(f.persisted.at(-1).updateAdvisories, undefined, 'exact-version results are memory only');
    f.controller.dispose();
  });
}

test('a blocked enrichment never holds the scan or its first rows', async () => {
  let finish;
  const f = fixture({ cached: false, post: async (_, body) => JSON.parse(body).app.includes('1.0.0') ? json({}) :
    new Promise(resolve => { finish = resolve; }) });
  await f.controller.handleReady(f.sink);
  assert.ok(f.posted.some(message => 'data' in message));
  assert.equal(typeof finish, 'function');
  assert.deepEqual(updates(f), []);
  assert.ok(f.events.findIndex(event => ['ready', 'partial-error'].includes(event)) < f.events.lastIndexOf('request'));
  finish(json({}));
  await tick();
  f.controller.dispose();
});

test('fresh-cache restart enriches after replay and keeps age and upgrade eligibility', async () => {
  const f = fixture();
  await f.controller.handleReady(f.sink);
  const replay = f.posted[0];
  assert.equal(replay.data.generatedAt, f.snapshot.generatedAt);
  assert.equal(f.controller.validateUpgradeRequest({ package: 'app', target: '2.0.0' }).ok, true);
  assert.ok(f.events.indexOf('ready') < f.events.indexOf('request'));
  await tick();
  assert.equal(updates(f).length, 1);
  assert.deepEqual(f.requests, [{ app: ['2.0.0'] }], 'only the offered upgrade is checked');
  const later = [];
  await f.controller.handleReady({ postMessage: message => later.push(message) });
  assert.deepEqual(later[0].data.updateAdvisories, updates(f)[0].results);
  assert.equal(later[0].data.generatedAt, replay.data.generatedAt);
  assert.equal(f.requests.length, 1);
  assert.equal(f.controller.validateUpgradeRequest({ package: 'app', target: '2.0.0' }).ok, true);
  f.controller.dispose();
});

for (const invalidate of ['file change', 'project switch', 'setting change', 'disposal', 'newer scan']) {
  test(`${invalidate} drops pending enrichment and its retained facts`, async () => {
    let finish;
    const f = fixture({ post: async () => new Promise(resolve => { finish = resolve; }) });
    await f.controller.handleReady(f.sink);
    await tick();
    const originalContext = f.posted[0].data.updateAdvisoryContext;
    if (invalidate === 'file change') f.controller.beginRevalidation();
    if (invalidate === 'setting change') f.controller.handleAdvisorySettingChanged(f.sink);
    if (invalidate === 'disposal') f.controller.dispose();
    if (invalidate === 'project switch') {
      const generation = f.controller.beginRevalidation();
      f.controller.updateProjectSnapshot({ ...f.options, projectInfo: { ...projectInfo, id: 'other' } }, generation);
    }
    if (invalidate === 'newer scan') {
      f.client.post = async () => json({});
      await f.controller.handleRefresh(f.sink);
    }
    finish(json({ app: [raw('*')] }));
    await tick();
    assert.ok(updates(f).filter(message => sameUpdateAdvisoryContext(message.context, originalContext))
      .every(message => message.results.length === 0), 'no old findings reach the view');
    if (invalidate === 'newer scan') {
      assert.ok(updates(f).some(message => message.context.scanId !== originalContext.scanId));
      assert.ok(updates(f).every(message => message.results.every(result => result.status !== 'checked' || result.count === 0)));
    }
    f.controller.dispose();
  });
}

test('Off dispatches nothing, including on-demand picker checks', async () => {
  const f = fixture({ enabled: () => false });
  await f.controller.handleReady(f.sink);
  await f.controller.enrichUpdateVersions([{ name: 'app', version: '9.0.0' }], f.sink);
  await tick();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(updates(f), []);
  f.controller.dispose();
});

for (const notify of [false, true]) {
  test(`turning Off mid-enrichment stops later chunks, with notification ${notify}`, async () => {
    let enabled = true;
    const pending = [], signals = [];
    const rows = Array.from({ length: 1001 }, (_, i) => ({ ...row, name: `pkg-${i}` }));
    const f = fixture({ rows, enabled: () => enabled, post: async (_, body, options) => {
      signals.push(options.signal);
      return new Promise(resolve => pending.push(resolve));
    } });
    await f.controller.handleReady(f.sink);
    await tick();
    assert.equal(pending.length, 2, 'bounded concurrency');
    enabled = false;
    if (notify) f.controller.handleAdvisorySettingChanged(f.sink);
    pending.forEach(resolve => resolve(json({})));
    await tick();
    assert.equal(f.requests.length, 2, 'the third chunk never dispatches');
    if (notify) assert.ok(signals.every(signal => signal.aborted));
    assert.ok(updates(f).every(message => message.results.length === 0));
    f.controller.dispose();
  });
}

for (const response of [[], null, { app: {} }, { app: [{}] }, { app: [raw('invalid range')] }, { app: [raw('')] }]) {
  test(`malformed advisory evidence is unavailable: ${JSON.stringify(response)}`, async () => {
    const f = fixture({ post: async () => json(response) });
    await f.controller.handleReady(f.sink);
    await tick();
    assert.ok(updates(f)[0].results.every(result => result.status === 'unavailable'));
    f.controller.dispose();
  });
}

test('exact versions, invalid versions, aliases and ranges stay separate', async () => {
  const requested = [];
  const memory = new UpdateAdvisories({ post: async (_, body) => {
    requested.push(JSON.parse(body)); return json({ real: [raw('>=2 <3')] });
  } }, () => true);
  let results;
  const pairs = offeredVersionPairs([{ ...row, name: 'alias', registryName: 'real', upgradeTo: '2.0.0' }]);
  await memory.enrich([...pairs, { name: 'real', version: '3.0.0' }, { name: 'real', version: '^2' }], () => true, value => { results = value; });
  assert.deepEqual(requested, [{ real: ['2.0.0', '3.0.0'] }]);
  assert.equal(results.find(result => result.version === '2.0.0').count, 1);
  assert.equal(results.find(result => result.version === '3.0.0').count, 0);
  assert.equal(results.find(result => result.version === '^2').status, 'unavailable');
  memory.clear();
});

test('picker-only releases are checked when the actual host version list loads and reused', async () => {
  const f = fixture();
  await f.controller.handleReady(f.sink);
  await tick();
  f.client.get = async () => json({ name: 'app', 'dist-tags': { latest: '2.0.0', lts: '1.9.0' },
    versions: Object.fromEntries(['1.0.0', '1.1.0', '1.9.0', '2.0.0', '3.0.0-beta.1'].map(version => [version, { version }])) });
  const coordinator = new UpgradeAssistantCoordinator({ platform: { getSetting: (_, fallback) => fallback }, sink: f.sink,
    httpClient: f.client, etagStore: new MemoryEtagStore(), ensureController: async () => f.controller,
    getSelectedProject: () => undefined, isDisposed: () => false, reloadFinalState: async () => {}, flushDeferredChanges: async () => {} });
  assert.equal(f.requests.flatMap(body => body.app).includes('1.9.0'), false);
  await coordinator.handleLoadUpgradeTargets({ type: 'load-upgrade-targets', package: 'app', requestId: 'picker' });
  await tick();
  const targets = f.posted.find(message => message.status === 'upgrade-targets');
  assert.ok(targets.targets.options.some(option => option.version === '1.9.0'));
  assert.ok(f.requests.flatMap(body => body.app).includes('1.9.0'));
  assert.ok(f.requests.flatMap(body => body.app).includes('3.0.0-beta.1'));
  assert.ok(f.events.indexOf('upgrade-targets') < f.events.lastIndexOf('request'));
  const count = f.requests.length;
  await coordinator.handleLoadUpgradeTargets({ type: 'load-upgrade-targets', package: 'app', requestId: 'again' });
  await tick();
  assert.equal(f.requests.length, count);
  f.controller.dispose();
});

test('protocol validates correlation and exact-version facts and the sidecar forwards them intact', () => {
  const message = { status: 'update-advisories', context: { scanId: 1, projectId: 'fixture', sourceGeneration: 2, settingsGeneration: 3 },
    results: [{ name: 'app', version: '2.0.0', status: 'checked', count: 1, highestSeverity: 'high' }] };
  assert.equal(isHostToWebviewMessage(message), true);
  for (const context of [{ ...message.context, scanId: -1 }, { ...message.context, sourceGeneration: undefined }, { ...message.context, settingsGeneration: 1.5 }]) {
    assert.equal(isHostToWebviewMessage({ ...message, context }), false);
    assert.equal(sameUpdateAdvisoryContext(context, message.context), false);
  }
  for (const result of [{ ...message.results[0], count: -1 }, { ...message.results[0], count: 0 }, { ...message.results[0], highestSeverity: null },
    { ...message.results[0], status: 'unavailable' }]) {
    assert.equal(isHostToWebviewMessage({ ...message, results: [result] }), false);
  }
  const forwarded = [];
  new RpcWebviewChannel({ sendNotification: (...args) => forwarded.push(args) }).postMessage(message);
  assert.deepEqual(forwarded, [['webview/postMessage', { message }]]);
});

test('older cached alias rows leave offered versions unchecked without a registry identity', async () => {
  const f = fixture({ rows: [{ ...row, name: 'alias', upgradeTo: null, upgradeReason: null, range: 'npm:real@^1' }],
    manifest: JSON.stringify({ dependencies: { alias: 'npm:real@^1' } }) });
  await f.controller.handleReady(f.sink);
  await tick();
  assert.equal(f.posted[0].data.rows[0].registryName, undefined);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(updates(f), []);
  f.controller.dispose();
});

for (const kind of ['file', 'setting']) {
  test(`${kind} changes also discard already-settled facts before replay`, async () => {
    const f = fixture({ post: async () => json({ app: [raw('*')] }) });
    await f.controller.handleReady(f.sink);
    await tick();
    assert.ok(updates(f).at(-1).results.some(result => result.count > 0));
    if (kind === 'file') f.controller.beginRevalidation();
    else f.controller.handleAdvisorySettingChanged(f.sink);
    f.controller.announceRevalidating(f.sink);
    assert.equal(f.posted.at(-1).data.updateAdvisories, undefined);
    await f.controller.enrichUpdateVersions([{ name: 'app', version: '9.0.0' }], f.sink);
    assert.equal(f.requests.length, 1, 'invalidated source never enriches until new rows are current');
    f.controller.dispose();
  });
}

for (const response of [{ status: 200, body: '{' }, { status: 503, body: '' }]) {
  test(`failed advisory evidence makes every offered pair unavailable: ${response.status} ${response.body}`, async () => {
    const f = fixture({ post: async () => response });
    await f.controller.handleReady(f.sink);
    await tick();
    assert.ok(updates(f)[0].results.every(result => result.status === 'unavailable'));
    f.controller.dispose();
  });
}

test('only the offered upgrade is checked, never the installed version', () => {
  assert.deepEqual(offeredVersionPairs([row]), [{ name: 'app', version: '2.0.0' }]);
  assert.deepEqual(offeredVersionPairs([{ ...row, upgradeTo: null, upgradeReason: null }]), [], 'no offer, no lookup');
  assert.deepEqual(offeredVersionPairs([{ ...row, current: '2.0.0', upgradeTo: 'v2.0.0' }]), [], 'installed version is skipped');
  assert.deepEqual(offeredVersionPairs([{ ...row, current: null }]), [{ name: 'app', version: '2.0.0' }]);
  assert.deepEqual(offeredVersionPairs([{ ...row, name: 'compat', range: 'npm:app@^2', unresolvable: 'alias' }]), [],
    'legacy alias rows without a registry identity stay unchecked');
  assert.deepEqual(offeredVersionPairs([{ ...row, name: 'compat', registryName: 'app' }]), [{ name: 'app', version: '2.0.0' }]);
});

test('installed version matching tolerates a leading v but keeps prereleases distinct', async () => {
  const { isInstalledVersion, updateAdvisoryTag } = await import('../out/host/updateAdvisoryState.js');
  assert.equal(isInstalledVersion('1.2.3', 'v1.2.3'), true);
  assert.equal(isInstalledVersion('1.2.3-beta.1', '1.2.3-beta.2'), false);
  assert.equal(isInstalledVersion('1.2.3', '1.2.4'), false);
  assert.equal(isInstalledVersion('not-a-version', 'not-a-version'), true);
  assert.equal(isInstalledVersion('not-a-version', '1.2.3'), false);
  assert.equal(isInstalledVersion(null, '1.2.3'), false);
  assert.equal(isInstalledVersion(undefined, '1.2.3'), false);
  assert.equal(updateAdvisoryTag({ name: 'a', version: '1.0.0', status: 'checked', count: 3, highestSeverity: 'high' }), '3 vulnerabilities (high)');
  assert.equal(updateAdvisoryTag({ name: 'a', version: '1.0.0', status: 'checked', count: 1, highestSeverity: 'critical' }), '1 vulnerability (critical)');
  assert.equal(updateAdvisoryTag({ name: 'a', version: '1.0.0', status: 'checked', count: 0, highestSeverity: null }), undefined);
  assert.equal(updateAdvisoryTag({ name: 'a', version: '1.0.0', status: 'unavailable' }), undefined);
});
