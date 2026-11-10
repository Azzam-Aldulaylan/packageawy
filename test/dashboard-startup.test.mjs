import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardController } from '../out/host/dashboardController.js';
import { PersistentProjectCacheStore } from '../out/core/cache/projectCacheStore.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { panel, deferred, until, network, seed, store, manifest, lockfile } from './helpers/dashboard-startup.mjs';

const statuses = messages => messages.filter(m => m.status !== 'scan-progress' && m.status !== 'update-advisories' && !m.status.startsWith('cleanup')).map(m => m.status);
const controller = (client, overrides = {}) => new DashboardController({
  root: '/tmp/startup', manifestText: manifest, lockfileText: lockfile, lockfilePath: null,
  registry: 'https://registry.npmjs.org', httpClient: client, auditRunner: client,
  etagStore: new MemoryEtagStore(), projectInfo: { id: 'a', label: 'a', manifestPath: 'package.json' },
  canChangeProject: false, buildInfo: { extensionVersion: 'test', builtAt: 'test' },
  projectCacheStore: new PersistentProjectCacheStore(store()), cacheKey: 'a', ttlMinutesProvider: () => 30, ...overrides,
});

for (const [name, saved, ttl, expected] of [
  ['expired complete', { age: 3600000 }, 30, ['ready', 'ready']],
  ['TTL zero', {}, 0, ['ready', 'ready']],
  ['core incomplete', { incomplete: true }, 30, ['stale', 'ready']],
  ['no cache', undefined, 30, ['loading', 'ready']],
  ['fresh complete', {}, 30, ['ready']],
]) {
  test(`startup replay matches ordinary ready with all network held: ${name}`, async t => {
    const s = await panel(t, { saved, ttl });
    await s.prepared();
    const pending = s.ready();
    await until(() => statuses(s.posted).length > 0);
    assert.deepEqual(statuses(s.posted), [expected[0]], 'cached rows are delivered before any network finishes');
    const replay = s.snapshots()[0];
    if (saved) {
      assert.equal(replay.status === 'stale', !!saved.incomplete);
      assert.equal(s.current.controller.isEligible(), !saved.incomplete);
    }
    if (name === 'fresh complete') {
      const pipelineRequests = s.client.requests.filter(r => r.kind !== 'advisory' || JSON.parse(r.body)['clean-pkg']?.includes('1.0.0'));
      assert.equal(pipelineRequests.length, 0, 'offered-version enrichment is separate from the pipeline');
    }
    const before = s.current.controller.scanId;
    s.gate.resolve();
    await pending;
    assert.equal(s.current.controller.scanId, before, 'first ready never restarts startup');
    assert.deepEqual(statuses(s.posted), expected);

    const baselineGate = deferred();
    const client = network(baselineGate);
    const ordinary = controller(client, { ttlMinutesProvider: () => ttl });
    t.after(() => ordinary.dispose());
    if (saved) seed(ordinary, saved);
    const baseline = [];
    const ready = ordinary.handleReady({ postMessage: m => baseline.push(m) });
    assert.deepEqual(statuses(baseline), [expected[0]]);
    baselineGate.resolve();
    await ready;
    assert.deepEqual(statuses(s.posted), statuses(baseline));
  });
}

test('ready waits for delayed discovery and project load then joins the one startup scan', async t => {
  const discovery = deferred(), disk = deferred();
  const s = await panel(t, { discover: () => discovery.promise, load: () => disk.promise });
  const ready = s.ready();
  assert.deepEqual(s.posted, []);
  discovery.resolve();
  await until(() => s.searches.some(search => search.include.includes('package-lock.json')));
  assert.deepEqual(s.posted, []);
  disk.resolve();
  await until(() => statuses(s.posted).includes('loading'));
  assert.deepEqual(statuses(s.posted), ['loading']);
  assert.equal(s.current.controller.scanId, 1);
  s.gate.resolve();
  await ready;
  assert.deepEqual(statuses(s.posted), ['loading', 'ready']);
});

test('finished startup replays without another scan and a webview reload uses ordinary ready', async t => {
  const s = await panel(t);
  s.gate.resolve();
  await s.finished();
  assert.deepEqual(s.posted, []);
  await s.ready();
  assert.deepEqual(statuses(s.posted), ['ready']);
  assert.equal(s.current.controller.scanId, 1);
  await s.ready();
  assert.deepEqual(statuses(s.posted), ['ready', 'ready']);
  assert.equal(s.current.controller.scanId, 1);
});

test('freshness is classified again when ready arrives after a finished startup', async t => {
  const s = await panel(t, { saved: {} });
  await s.finished();
  s.current.controller.lastGeneratedAt = new Date(Date.now() - 3600000).toISOString();
  const ready = s.ready();
  await until(() => s.snapshots().length > 0);
  assert.deepEqual(statuses(s.posted), ['ready']);
  assert.equal(s.snapshots()[0].status, 'ready');
  await until(() => s.client.requests.length > 0);
  s.gate.resolve();
  await ready;
  assert.deepEqual(statuses(s.posted), ['ready', 'ready']);
});

for (const phase of ['discovery', 'load', 'scan', 'finished', 'warm', 'failed']) {
  test(`a second pre-ready target wins during ${phase}`, async t => {
    const held = deferred();
    let heldOnce = false;
    const once = async () => { if (!heldOnce) { heldOnce = true; await held.promise; } };
    const s = await panel(t, { projects: ['a', 'b'],
      discover: phase === 'discovery' ? once : undefined,
      load: phase === 'load' ? once : undefined,
      saved: phase === 'warm' ? {} : undefined, invalid: phase === 'failed' ? 'a' : undefined });
    if (phase === 'load') await until(() => heldOnce);
    if (phase === 'scan') await s.prepared();
    if (['finished', 'warm', 'failed'].includes(phase)) {
      s.gate.resolve();
      await s.finished();
    }
    const old = s.current.controller;
    const oldSignal = old?.inFlight?.signal;
    s.open('b');
    assert.equal(s.current.selectedProject, undefined, 'selection changes before new discovery');
    held.resolve();
    await s.prepared();
    s.gate.resolve();
    await s.finished();
    assert.deepEqual(s.posted, []);
    await s.ready();
    assert.equal(s.snapshots().at(-1).data.project.manifestPath, 'b/package.json');
    assert.equal(s.current.selectedProject.dir, 'b');
    if (old) assert.equal(old.disposed, true);
    if (oldSignal) assert.equal(oldSignal.aborted, true);
  });
}

for (const invalid of ['bad manifest', 'bad lockfile']) {
  test(`startup keeps a fatal ${invalid} error until ready and refresh rereads disk`, async t => {
    const { writeFile } = await import('node:fs/promises');
    const discovery = deferred();
    const s = await panel(t, { invalid: invalid === 'bad manifest' ? 'a' : undefined,
      discover: () => discovery.promise });
    if (invalid === 'bad lockfile') await writeFile(`${s.root}/a/package-lock.json`, '{"lockfileVersion":999}');
    discovery.resolve();
    s.gate.resolve();
    await s.finished();
    assert.deepEqual(s.posted, []);
    await s.ready();
    assert.deepEqual(statuses(s.posted), ['fatal-error']);
    await writeFile(`${s.root}/a/package.json`, manifest);
    await writeFile(`${s.root}/a/package-lock.json`, lockfile);
    await s.current.handle({ type: 'refresh' });
    assert.equal(s.snapshots().at(-1).status, 'ready');
  });
}

for (const target of ['missing', null]) {
  test(`ambiguous startup has no messages or picker before ready: ${target}`, async t => {
    const s = await panel(t, { projects: ['a', 'b'], target });
    await s.prepared();
    assert.equal(s.current.controller, undefined);
    assert.equal(s.client.requests.length, 0);
    assert.deepEqual(s.posted, []);
    assert.deepEqual(s.picks, []);
    assert.deepEqual(s.notices, []);
    s.gate.resolve();
    await s.ready();
    assert.equal(s.picks.length, 1);
    assert.equal(s.snapshots().at(-1).data.project.manifestPath, 'a/package.json');
  });
}

test('one project without a target starts early', async t => {
  const s = await panel(t, { target: null });
  await s.prepared();
  assert.ok(s.current.controller);
  assert.ok(s.client.requests.length > 0);
  assert.deepEqual(s.picks, []);
});

test('dispose before ready aborts startup and discards its late result', async t => {
  const s = await panel(t);
  await s.prepared();
  const old = s.current.controller;
  const signal = old.inFlight.signal;
  s.close();
  assert.equal(signal.aborted, true);
  s.gate.resolve();
  await old.startupTask.promise;
  assert.deepEqual(s.posted, []);
  assert.equal(old.lastResult, undefined);
});

for (const boundary of ['discovery', 'load']) {
  test(`dispose during startup ${boundary} never creates a controller`, async t => {
    const held = deferred();
    const s = await panel(t, { discover: boundary === 'discovery' ? () => held.promise : undefined,
      load: boundary === 'load' ? () => held.promise : undefined });
    if (boundary === 'load') await until(() => s.searches.some(search => search.include.includes('package-lock.json')));
    s.close(); held.resolve(); await s.prepared();
    assert.equal(s.current.controller, undefined);
    assert.equal(s.client.requests.length, 0);
    assert.deepEqual(s.posted, []);
  });
}

test('watcher reload held on A is superseded before discovery for pre-ready B', async t => {
  const s = await panel(t, { projects: ['a', 'b'] });
  s.gate.resolve(); await s.finished();
  const old = s.current.controller;
  const scanId = old.scanId;
  const disk = deferred();
  const load = s.current.reloadSource.loadProject;
  s.current.reloadSource.loadProject = async candidate => { await disk.promise; return load(candidate); };
  const reload = s.current.reloadAfterFileChange(new Set(['manifest']), s.current.reloadGeneration);
  s.open('b');
  assert.equal(s.current.selectedProject, undefined);
  disk.resolve();
  await reload;
  await s.finished();
  assert.equal(old.scanId, scanId, 'A never gets a new scan after its held disk read');
  assert.deepEqual(s.posted, [], 'even panel revalidation announcements are gated');
  await s.ready();
  assert.ok(s.snapshots().every(m => m.data.project.manifestPath === 'b/package.json'));
});

test('watcher and source usage requests wait for a delivered snapshot and run once', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished();
  let requests = 0;
  const original = s.current.usageCoordinator.requestBackgroundUsageRefresh.bind(s.current.usageCoordinator);
  s.current.usageCoordinator.requestBackgroundUsageRefresh = async options => { requests++; return original(options); };
  await s.current.reloadAfterFileChange(new Set(['manifest']), s.current.reloadGeneration);
  const source = s.watchers.findLast(w => w.glob.includes('**/*.{js'));
  source.listener(`${s.root}/a/index.ts`);
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.equal(requests, 0);
  assert.equal(s.searches.some(search => search.include === '**/*.{js,jsx,ts,tsx,mjs,cjs}'), false);
  assert.deepEqual(s.posted, []);
  await s.ready();
  await until(() => s.posted.some(m => m.status === 'cleanup-result' && m.findings.length > 0));
  assert.equal(requests, 1);
  assert.ok(s.posted.findIndex(m => 'data' in m) < s.posted.findIndex(m => m.status === 'cleanup-result'));
});

test('sidecar-style panels skip startup and wait for openManifest and ready', async t => {
  const s = await panel(t, { early: false, projects: ['a', 'b'] });
  assert.equal(s.searches.length, 0);
  s.open('b');
  assert.equal(s.searches.length, 0);
  s.gate.resolve(); await s.ready();
  assert.equal(s.snapshots().at(-1).data.project.manifestPath, 'b/package.json');
});

for (const settle of ['before ready', 'after ready', 'during webview reload']) {
  test(`offered-version advisory enrichment is delivered when it settles ${settle}`, async t => {
    const s = await panel(t);
    const advisory = deferred();
    const post = s.current.httpClient.post;
    let enriching = false;
    s.current.httpClient.post = async (url, body, options) => {
      if (JSON.parse(body)['clean-pkg']?.includes('1.0.1')) {
        enriching = true;
        await advisory.promise;
      }
      return post(url, body, options);
    };
    t.after(() => advisory.resolve());
    s.gate.resolve(); await s.finished();
    await until(() => enriching);
    if (settle === 'before ready') {
      advisory.resolve();
      await until(() => s.current.controller.updateAdvisories.results().length > 0);
      assert.deepEqual(s.posted, []);
    }
    await s.ready();
    const replay = s.snapshots()[0];
    assert.ok(replay.data.updateAdvisoryContext);
    if (settle === 'before ready') {
      assert.equal(replay.data.updateAdvisories[0].status, 'checked');
      assert.equal(s.posted.some(m => m.status === 'update-advisories'), false);
    } else {
      assert.deepEqual(replay.data.updateAdvisories, []);
      if (settle === 'during webview reload') await s.ready();
      advisory.resolve();
      await until(() => s.posted.some(m => m.status === 'update-advisories'));
      const update = s.posted.findLast(m => m.status === 'update-advisories');
      assert.deepEqual(update.context, s.snapshots().at(-1).data.updateAdvisoryContext);
      assert.equal(update.results[0].status, 'checked');
    }
    assert.equal(s.current.controller.scanId, 1);
  });
}

test('a second ready during startup retains ordinary abort and restart behaviour', async t => {
  const s = await panel(t);
  await s.prepared();
  const first = s.ready();
  await until(() => statuses(s.posted).includes('loading'));
  const signal = s.current.controller.inFlight.signal;
  const second = s.ready();
  await until(() => s.current.controller.scanId === 2);
  assert.equal(signal.aborted, true);
  s.gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(statuses(s.posted), ['loading', 'loading', 'ready']);
});

test('ready restarts a watcher run that replaced startup instead of joining it', async t => {
  const s = await panel(t);
  await s.prepared();
  const c = s.current.controller;
  const startupSignal = c.inFlight.signal;
  const watcher = c.refreshInBackground(s.current.sink);
  const watcherSignal = c.inFlight.signal;
  assert.equal(startupSignal.aborted, true);
  const ready = s.ready();
  await until(() => c.scanId === 3);
  assert.equal(watcherSignal.aborted, true);
  s.gate.resolve(); await Promise.all([ready, watcher]);
  assert.deepEqual(statuses(s.posted), ['loading', 'ready']);
});

test('closing during a mutation and reopening preserves the shared lock and ready exception', async t => {
  const s = await panel(t);
  s.gate.resolve(); await s.finished(); await s.ready();
  const owner = s.current.upgradeCoordinator;
  assert.equal(owner.reserve('clean-pkg'), true);
  assert.equal(owner.reservation.beginMutation('clean-pkg'), true);
  await s.ready();
  assert.equal(owner.isMutationBusy(), true, 'webview reload never releases an ongoing install');
  s.close();
  assert.equal(owner.isMutationBusy(), true, 'closing leaves the transaction owner alive');
  const reopened = await panel(t, { workspace: s.root });
  reopened.gate.resolve(); await reopened.finished();
  assert.equal(reopened.current.upgradeCoordinator.isMutationBusy(), true);
  await reopened.ready();
  assert.equal(reopened.current.upgradeCoordinator.isMutationBusy(), true);
  assert.equal(owner.isMutationBusy(), true);
  await owner.reservation.release('clean-pkg');
  assert.equal(reopened.current.upgradeCoordinator.isMutationBusy(), false);
});

test('fatal startup state is available before its task completion continuation', async t => {
  const c = controller(network(), { manifestText: '{' });
  t.after(() => c.dispose());
  const delivered = [];
  let ready;
  c.startStartup({ postMessage: message => {
    // Ready races the gated fatal message before run() has returned its outcome.
    if (message.status === 'fatal-error') ready = c.handleStartupReady({ postMessage: m => delivered.push(m) });
  } });
  await until(() => ready !== undefined);
  await ready;
  assert.deepEqual(statuses(delivered), ['fatal-error']);
});

test('a superseded startup cannot post progress or results after B is presented', async t => {
  const s = await panel(t, { projects: ['a', 'b'] });
  await s.prepared();
  const old = s.current.controller;
  const oldTask = old.startupTask;
  const replacement = network();
  s.current.httpClient.get = replacement.get;
  s.current.httpClient.post = replacement.post;
  s.current.auditRunner.run = replacement.run;
  s.open('b');
  await s.finished();
  await s.ready();
  await new Promise(resolve => setImmediate(resolve));
  const before = s.posted.filter(m => m.status === 'scan-progress' || 'data' in m);
  s.gate.resolve(); await oldTask.promise;
  assert.deepEqual(s.posted.filter(m => m.status === 'scan-progress' || 'data' in m), before);
  assert.equal(old.lastResult, undefined);
  assert.ok(s.snapshots().every(m => m.data.project.manifestPath === 'b/package.json'));
});

test('ready replay preserves a watcher eligibility revocation while its disk reload is pending', async t => {
  const s = await panel(t, { saved: { age: 3600000 } });
  await s.prepared();
  s.current.controller.beginRevalidation();
  s.current.controller.announceRevalidating(s.current.sink);
  const ready = s.ready();
  await until(() => s.snapshots().length > 0);
  assert.equal(s.snapshots()[0].status, 'ready', 'time-expired complete rows replay immediately');
  assert.equal(s.current.controller.isEligible(), false, 'ready cannot authorize data a watcher revoked');
  s.gate.resolve(); await ready;
});

test('a startup HEAD event holds branch selection until ready', async t => {
  const s = await panel(t, { projects: ['a', 'b', 'c'] });
  s.gate.resolve(); await s.finished();
  const find = s.platform.findFiles;
  s.platform.findFiles = search => search.include === '**/package.json'
    ? Promise.resolve([`${s.root}/b/package.json`, `${s.root}/c/package.json`]) : find(search);
  s.current.onGitHeadChanged();
  await new Promise(resolve => setTimeout(resolve, 330));
  assert.deepEqual(s.picks, []);
  assert.deepEqual(s.posted, []);
  await s.ready();
  await until(() => s.snapshots().at(-1)?.data.project.manifestPath === 'b/package.json');
  assert.equal(s.picks.length, 1);
});
