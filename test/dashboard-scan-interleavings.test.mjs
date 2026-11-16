import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { panel, deferred, json, lockfile, until } from './helpers/dashboard-startup.mjs';

const kinds = ['full', 'structural', 'time', 'local-mutation', 'startup', 'ready'];
const turn = () => new Promise(resolve => setImmediate(resolve));
const version = n => `1.0.${n}`;

// Run the real panel, coordinator, controller and row pipeline. In particular,
// watcher reloads use production's unchanged panel generation, and switches
// retain the old selection/watchers until their disk read has been accepted.
test('seeded multi-project disk/scan/watcher/switch interleavings converge using only production-queued work', async t => {
  const covered = new Set();
  for (let seed = 1; seed <= 32; seed++) {
    let rng = seed, automatic = true;
    const choose = count => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % count; };
    const trace = [], reads = [], gates = new Map(), tasks = [], publications = [], writes = [];
    const disk = new Map([['a', 0], ['b', 100]]);
    const detail = () => `seed ${seed}: ${trace.join(' > ')}`;
    const s = await panel(t, { projects: ['a', 'b'], early: false, ttl: 0 });
    s.gate.resolve();
    s.current.requestAutomaticUsageRefresh = () => {};
    const check = (rows, name, destination) => {
      assert.equal(rows[0].current, version(disk.get(name)), `${destination}, ${detail()}`);
    };
    const sink = s.current.sink;
    const post = sink.postMessage.bind(sink);
    sink.postMessage = message => {
      if ('data' in message && message.status !== 'stale') {
        check(message.data.rows, message.data.project.manifestPath.split('/')[0], 'publication');
        publications.push(message);
      }
      post(message);
    };
    const cache = s.current.projectCacheStore;
    const set = cache.set.bind(cache);
    cache.set = (key, entry) => {
      check(entry.rows, path.basename(path.dirname(entry.lockfilePath)), 'cache write');
      writes.push(entry);
      set(key, entry);
    };
    const holdNetwork = async signal => {
      if (automatic) return;
      if (!gates.has(signal)) gates.set(signal, deferred());
      await gates.get(signal).promise;
    };
    s.current.httpClient.get = async (_url, { signal }) => {
      await holdNetwork(signal); return json({ name: 'clean-pkg', version: '1.9.0' });
    };
    s.current.httpClient.post = async (_url, _body, { signal }) => { await holdNetwork(signal); return json({}); };
    s.current.auditRunner.run = async ({ signal }) => {
      await holdNetwork(signal); return { stdout: '{"vulnerabilities":{}}', exitCode: 0 };
    };
    const load = s.current.loadProjectMeasured.bind(s.current);
    s.current.loadProjectMeasured = async (...args) => {
      const name = args[0].dir, n = disk.get(name);
      const read = { name, n, gate: deferred(), failed: false, released: automatic };
      reads.push(read); covered.add('read:start'); trace.push(`read:${name}:${n}`);
      if (!automatic) await read.gate.promise;
      if (read.failed) throw Object.assign(new Error('held EACCES'), { code: 'EACCES' });
      const result = await load(...args);
      covered.add('read:succeed');
      return { ...result, lockfileText: lockfile.replaceAll('"1.0.0"', `"${version(n)}"`) };
    };
    const track = promise => {
      const task = { done: false, error: undefined };
      task.promise = Promise.resolve(promise).catch(error => { task.error = error; }).finally(() => { task.done = true; });
      tasks.push(task);
      return task.promise;
    };
    const releaseRead = read => { read.released = true; read.gate.resolve(); };
    const pendingReads = () => reads.filter(read => !read.released);
    const startScan = kind => {
      covered.add(kind); trace.push(`scan:${kind}`);
      const c = s.current.controller;
      if (kind === 'full') track(c.handleRefresh(sink));
      else if (kind === 'ready') track(s.ready());
      else if (kind === 'startup') { c.startStartup(sink); track(c.startupTask.promise); }
      else track(c.refreshInBackground(sink, kind));
    };
    const watcher = () => {
      covered.add('watcher');
      const name = s.current.selectedProject.dir;
      disk.set(name, disk.get(name) + 1); trace.push(`watcher:${name}`);
      const live = s.watchers.find(w => !w.disposed && w.base === path.join(s.root, name) && w.glob.includes('package-lock.json'));
      assert.ok(live, detail());
      live.listener(path.join(s.root, name, 'package-lock.json'));
    };
    const switchTo = name => {
      covered.add('switch'); trace.push(`switch:${name}`);
      return track(s.current.openManifest(path.join(s.root, name, 'package.json')));
    };
    const drain = async () => {
      // Release only already-running work. flush() is the existing watcher's
      // debounce callback, not an invented recovery read or final ready.
      automatic = true;
      for (const read of pendingReads()) releaseRead(read);
      for (const gate of gates.values()) gate.resolve();
      await Promise.all(tasks.map(task => task.promise));
      await s.current.fileChangeCoordinator.flush();
      await s.current.fileChangeCoordinator.reloadChain;
      for (const task of tasks) if (task.error) throw task.error;
    };
    const converged = () => {
      const name = s.current.selectedProject.dir, c = s.current.controller;
      assert.equal(c.root, path.join(s.root, name), detail());
      assert.equal(s.current.fileChangeCoordinator.hasPending, false, detail());
      assert.equal(s.current.fileChangeCoordinator.hasDeferred, false, detail());
      assert.equal(s.current.shownDashboardStatus, 'ready', detail());
      assert.equal(c.isEligible(), true, detail());
      check(publications.at(-1).data.rows, name, 'quiescent rows');
      assert.equal(publications.at(-1).data.project.manifestPath, `${name}/package.json`, detail());
      check(cache.get(c.options.cacheKey).rows, name, 'quiescent cache');
    };
    try {
      await s.ready();
      // The exact review-2 schedule must converge without an extra event.
      automatic = false;
      const switching = switchTo('b');
      await until(() => pendingReads().some(read => read.name === 'b'));
      watcher();
      releaseRead(pendingReads().find(read => read.name === 'b'));
      await drain(); await switching; converged();
      assert.equal(reads.filter(read => read.name === 'b').length, 1, detail());

      // A failing watcher read with another event during it already has a
      // mandatory retry queued by the production coordinator's drain loop.
      automatic = false;
      watcher(); track(s.current.fileChangeCoordinator.flush());
      await until(() => pendingReads().length > 0);
      const failing = pendingReads()[0];
      failing.failed = true; covered.add('read:fail');
      watcher(); releaseRead(failing);
      await drain(); converged();

      automatic = false;
      for (let step = 0; step < 48; step++) {
        const event = choose(7);
        if (event === 0) switchTo(choose(2) ? 'a' : 'b');
        else if (event === 1) watcher();
        else if (event === 2) track(s.current.fileChangeCoordinator.flush());
        else if (event === 3 && pendingReads().length) {
          const read = pendingReads()[choose(pendingReads().length)];
          trace.push(`release:${read.name}:${read.n}`); releaseRead(read);
        } else if (event === 4 && gates.size) {
          const gate = [...gates.values()][choose(gates.size)];
          trace.push('network:release'); gate.resolve();
        } else startScan(kinds[choose(kinds.length)]);
        await turn();
      }
      await drain(); converged();
      assert.ok(writes.length > 0, detail());
    } finally {
      s.close();
      await drain();
    }
  }
  for (const event of [...kinds, 'read:start', 'read:succeed', 'read:fail', 'watcher', 'switch']) {
    assert.ok(covered.has(event), `scheduler exercised ${event}`);
  }
});
