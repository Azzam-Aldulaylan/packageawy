import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { versionListFailureText } from '../out/core/diagnostics.js';
import { FetchError } from '../out/core/registry/http.js';
import { MemoryEtagStore } from '../out/core/registry/versions.js';
import { loadUpgradeTargets } from '../out/core/upgrade/targets.js';
import { UpgradeAssistantCoordinator, versionListFetchFailure } from '../out/host/upgradeAssistantCoordinator.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export { UpgradeTargetSelector } from './webview/src/components/UpgradeTargetSelector.tsx';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'shared-react',
    setup(plugin) {
      plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({
        path: pathToFileURL(require.resolve(args.path)).href,
        external: true,
      }));
    },
  }],
});
const { UpgradeTargetSelector } = await import(
  `data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=version-list-errors.fixture.js`).toString('base64')}`
);

const noop = () => {};
const REGISTRY = 'https://npm.example.com/';
const picker = (props) => renderToStaticMarkup(createElement(UpgradeTargetSelector, {
  selectedVersion: null, fallbackVersion: '2.0.0', disabled: false, onChange: noop, ...props,
}));
const errorState = (code, message = versionListFailureText(code, REGISTRY)) => ({ phase: 'error', error: { code, message } });

// ---------------------------------------------------------------------------
// Picker copy
// ---------------------------------------------------------------------------

const FAILURES = [
  ['timeout', /Could not reach npm\.example\.com in time\./, 'Retry'],
  ['network', /Could not connect to npm\.example\.com\./, 'Retry'],
  ['registry-error', /npm\.example\.com returned an error\./, 'Retry'],
  ['sign-in', /npm\.example\.com needs you to sign in\./, 'Retry'],
  ['rate-limited', /npm\.example\.com is limiting requests\./, 'Retry'],
  ['not-found', /npm\.example\.com has no version list for this package\./, 'Retry'],
  ['bad-data', /npm\.example\.com sent a version list that could not be read\./, 'Retry'],
  ['insecure-registry', /npm\.example\.com uses http\./, 'Retry'],
  ['project-changed', /The project changed\. Refresh the dashboard, then try again\./, 'Refresh'],
  ['no-upgrade', /No upgrade is available for this package any more\./, 'Refresh'],
  ['unknown', /Published versions could not be loaded\./, 'Retry'],
];

for (const [code, text, button] of FAILURES) {
  test(`the picker explains a ${code} failure and offers ${button}`, () => {
    const html = picker({ state: errorState(code), onRetry: noop, onRefreshDashboard: noop });
    assert.match(html, text);
    assert.match(html, /The dashboard target is still available\./);
    assert.match(html, new RegExp(`<button[^>]*>${button}</button>`));
    assert.match(html, /value="2\.0\.0" selected="">2\.0\.0 \(dashboard target\)/);
  });
}

test('an unknown code from an older host shows the generic sentence, never its message', () => {
  const html = picker({ state: errorState('NETWORK', 'connect ECONNREFUSED https://user:secret@npm.example.com/x'), onRetry: noop });
  assert.match(html, /Published versions could not be loaded\. The dashboard target is still available\./);
  assert.doesNotMatch(html, /secret|ECONNREFUSED/);
});

test('without a dashboard target the fallback sentence is left out', () => {
  const html = picker({ state: errorState('timeout'), fallbackVersion: null, onRetry: noop });
  assert.match(html, /in time\./);
  assert.doesNotMatch(html, /still available/);
});

test('Retry is disabled while the review is busy and missing while loading', () => {
  assert.match(picker({ state: errorState('timeout'), disabled: true, onRetry: noop }), /<button[^>]*disabled=""[^>]*>Retry<\/button>/);
  assert.doesNotMatch(picker({ state: { phase: 'loading' }, onRetry: noop }), /Retry|Refresh<\/button>/);
  assert.doesNotMatch(picker({ state: errorState('timeout') }), /<button/);
});

test('the Retry and Refresh buttons call their own callbacks', () => {
  const calls = [];
  function capture(element, found = []) {
    if (Array.isArray(element)) element.forEach(child => capture(child, found));
    else if (element !== null && typeof element === 'object') {
      if (element.type === 'button') found.push(element);
      capture(element.props?.children, found);
    }
    return found;
  }
  const props = {
    selectedVersion: null, fallbackVersion: '2.0.0', disabled: false, onChange: noop,
    onRetry: () => calls.push('retry'), onRefreshDashboard: () => calls.push('refresh'),
  };
  // Hooks need a render context, so render through a probe and capture its tree.
  let tree;
  const Probe = (p) => { tree = UpgradeTargetSelector(p); return tree; };
  renderToStaticMarkup(createElement(Probe, { ...props, state: errorState('network') }));
  capture(tree)[0].props.onClick();
  renderToStaticMarkup(createElement(Probe, { ...props, state: errorState('project-changed') }));
  capture(tree)[0].props.onClick();
  assert.deepEqual(calls, ['retry', 'refresh']);
});

test('a tags-only list says the full version list could not be loaded', () => {
  const targets = {
    recommendedVersion: '2.0.0', truncated: true, tagsOnly: true,
    options: [{ version: '2.0.0', channel: 'stable', labels: ['recommended', 'latest'] }],
  };
  const html = picker({ state: { phase: 'ready', targets } });
  assert.match(html, /Showing tagged releases only\. The full version list could not be loaded\./);
  assert.doesNotMatch(html, /Showing recent and tagged releases/);
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-targets', package: 'pkg', requestId: '1', targets }), true);
});

// ---------------------------------------------------------------------------
// Dist-tags fallback
// ---------------------------------------------------------------------------

const PACKUMENT_URL = 'https://registry.npmjs.org/pkg';
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/pkg/dist-tags';
const ok = (value) => {
  const body = JSON.stringify(value);
  return { status: 200, headers: {}, body, wireBytes: body.length };
};

function fallbackClient(packumentCode, distTags = { latest: '2.0.0' }) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (url === PACKUMENT_URL) throw new FetchError(packumentCode, 'raw detail');
      if (distTags instanceof Error) throw distTags;
      return ok(distTags);
    },
  };
}

for (const code of ['TOO_LARGE', 'TIMEOUT', 'NETWORK', 'REGISTRY_5XX', 'PARSE_ERROR']) {
  test(`a ${code} packument falls back to the tagged releases once`, async () => {
    const client = fallbackClient(code);
    const result = await loadUpgradeTargets(client, new MemoryEtagStore(), 'https://registry.npmjs.org', 'pkg', '1.0.0', '2.0.0');
    assert.equal(result.tagsOnly, code === 'TOO_LARGE' ? undefined : true);
    assert.equal(result.recommendedVersion, '2.0.0');
    assert.deepEqual(client.calls, [PACKUMENT_URL, DIST_TAGS_URL]);
  });
}

for (const code of ['CANCELLED', 'REGISTRY_AUTH_REQUIRED', 'RATE_LIMITED', 'BAD_URL', 'REGISTRY_404']) {
  test(`a ${code} packument is reported without a fallback request`, async () => {
    const client = fallbackClient(code);
    await assert.rejects(
      loadUpgradeTargets(client, new MemoryEtagStore(), 'https://registry.npmjs.org', 'pkg', '1.0.0', '2.0.0'),
      (error) => error instanceof FetchError && error.code === code
    );
    assert.deepEqual(client.calls, [PACKUMENT_URL]);
  });
}

test('when the fallback fails too, the packument failure is reported', async () => {
  const client = fallbackClient('TIMEOUT', new FetchError('REGISTRY_404', 'missing'));
  await assert.rejects(
    loadUpgradeTargets(client, new MemoryEtagStore(), 'https://registry.npmjs.org', 'pkg', '1.0.0', '2.0.0'),
    (error) => error instanceof FetchError && error.code === 'TIMEOUT'
  );
  assert.deepEqual(client.calls, [PACKUMENT_URL, DIST_TAGS_URL]);
});

test('a normal packument load is one request and not tags-only', async () => {
  const calls = [];
  const client = { async get(url) {
    calls.push(url);
    return ok({ versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } });
  } };
  const result = await loadUpgradeTargets(client, new MemoryEtagStore(), 'https://registry.npmjs.org', 'pkg', '1.0.0', '2.0.0');
  assert.equal(result.tagsOnly, undefined);
  assert.deepEqual(calls, [PACKUMENT_URL]);
});

// ---------------------------------------------------------------------------
// Host: safe errors, cancellation, supersession, disposal
// ---------------------------------------------------------------------------

function row(name = 'pkg') {
  return {
    name, range: '^1.0.0', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0',
    dev: false, advisories: [], worstSeverity: null, upgradeTo: '2.0.0', upgradeReason: 'update',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** An HTTP client whose requests wait until the test answers or the signal aborts. */
function controllableClient() {
  const requests = [];
  return {
    requests,
    get(url, options = {}) {
      return new Promise((resolve, reject) => {
        const request = { url, signal: options.signal, resolve, reject };
        requests.push(request);
        options.signal?.addEventListener('abort', () => reject(new FetchError('CANCELLED', 'aborted')), { once: true });
      });
    },
  };
}

function harness({ client, ensureController, eligibility = () => ({ ok: true }), rows = [row()], registryUrl = REGISTRY } = {}) {
  const posted = [];
  const enriched = [];
  let disposed = false;
  const controller = {
    lastResultRows: () => rows,
    validateUpgradeRequest: eligibility,
    enrichUpdateVersions: async (pairs) => { enriched.push(pairs); },
    upgradeSource: { resolvedRegistry: { url: registryUrl, source: 'npmrc', scoped: {} } },
  };
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage: (message) => posted.push(message) },
    httpClient: client ?? controllableClient(),
    etagStore: new MemoryEtagStore(),
    ensureController: ensureController ?? (async () => controller),
    getSelectedProject: () => undefined,
    isDisposed: () => disposed,
    reloadFinalState: async () => {},
    flushDeferredChanges: async () => {},
  });
  return { coordinator, posted, enriched, controller, dispose: () => { disposed = true; coordinator.disposeWhenIdle(); } };
}

const load = (requestId, pkg = 'pkg') => ({ type: 'load-upgrade-targets', package: pkg, requestId });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const statuses = (posted, requestId) => posted.filter((message) => message.requestId === requestId).map((message) => message.status);

for (const [fetchCode, failure] of [['TIMEOUT', 'timeout'], ['REGISTRY_AUTH_REQUIRED', 'sign-in'], ['REGISTRY_404', 'not-found']]) {
  test(`a ${fetchCode} fetch failure posts the ${failure} reason without the raw message`, async () => {
    const client = { async get() { throw new FetchError(fetchCode, 'GET https://user:token@npm.example.com/pkg?auth=secret failed'); } };
    const h = harness({ client, registryUrl: 'https://user:token@npm.example.com/path?auth=secret' });
    await h.coordinator.handleLoadUpgradeTargets(load('1'));
    const error = h.posted.at(-1);
    assert.equal(error.status, 'upgrade-targets-error');
    assert.equal(error.error.code, failure);
    assert.equal(error.error.message, versionListFailureText(failure, REGISTRY));
    assert.doesNotMatch(JSON.stringify(h.posted), /token|secret|path/);
    assert.equal(isHostToWebviewMessage(error), true);
  });
}

test('the exported failure helper keeps the allowlisted fetch code for logging', () => {
  assert.deepEqual(versionListFetchFailure(new FetchError('TIMEOUT', 'x'), REGISTRY), {
    failure: 'timeout', fetchCode: 'TIMEOUT', error: { code: 'timeout', message: versionListFailureText('timeout', REGISTRY) },
  });
  assert.equal(versionListFetchFailure(new Error('boom'), REGISTRY).fetchCode, 'UNKNOWN');
  assert.equal(versionListFetchFailure(new FetchError('BAD_URL', 'x'), 'http://npm.example.com/').failure, 'insecure-registry');
});

for (const [reason, failure] of [['revalidating', 'project-changed'], ['stale-target', 'project-changed'], ['no-eligible-upgrade', 'no-upgrade']]) {
  test(`an eligibility rejection (${reason}) posts ${failure} before any network work`, async () => {
    const client = controllableClient();
    const h = harness({ client, eligibility: () => ({ ok: false, reason }) });
    await h.coordinator.handleLoadUpgradeTargets(load('1'));
    assert.deepEqual(h.posted.at(-1).error, { code: failure, message: versionListFailureText(failure) });
    assert.equal(client.requests.length, 0);
  });
}

test('a package that left the scan is reported as a project change', async () => {
  const h = harness({ rows: [] });
  await h.coordinator.handleLoadUpgradeTargets(load('1'));
  assert.equal(h.posted.at(-1).error.code, 'project-changed');
});

test('a cancel during ensureController posts nothing', async () => {
  const gate = deferred();
  const client = controllableClient();
  const h = harness({ client, ensureController: () => gate.promise });
  const pending = h.coordinator.handleLoadUpgradeTargets(load('1'));
  h.coordinator.handleCancelUpgradeTargets({ requestId: '1' });
  gate.resolve(h.controller);
  await pending;
  assert.deepEqual(h.posted, []);
  assert.equal(client.requests.length, 0);
});

test('a cancel during the packument fetch aborts it and posts nothing more', async () => {
  const client = controllableClient();
  const h = harness({ client });
  const pending = h.coordinator.handleLoadUpgradeTargets(load('1'));
  await tick();
  assert.equal(client.requests.length, 1);
  h.coordinator.handleCancelUpgradeTargets({ requestId: '1' });
  await pending;
  assert.equal(client.requests[0].signal.aborted, true);
  assert.deepEqual(statuses(h.posted, '1'), ['upgrade-targets-loading']);
  assert.deepEqual(h.enriched, []);
});

test('a cancel during the dist-tags fallback ends quietly', async () => {
  const client = controllableClient();
  const h = harness({ client });
  const pending = h.coordinator.handleLoadUpgradeTargets(load('1'));
  await tick();
  client.requests[0].reject(new FetchError('TIMEOUT', 'slow'));
  await tick();
  assert.equal(client.requests.length, 2);
  assert.match(client.requests[1].url, /dist-tags$/);
  h.coordinator.handleCancelUpgradeTargets({ requestId: '1' });
  await pending;
  assert.deepEqual(statuses(h.posted, '1'), ['upgrade-targets-loading']);
  assert.deepEqual(h.enriched, []);
});

test('a cancel after the fetch resolves drops the result and its enrichment', async () => {
  const client = controllableClient();
  const h = harness({ client });
  const pending = h.coordinator.handleLoadUpgradeTargets(load('1'));
  await tick();
  // Resolve, then cancel before the coordinator resumes.
  client.requests[0].resolve(ok({ versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } }));
  h.coordinator.handleCancelUpgradeTargets({ requestId: '1' });
  await pending;
  assert.deepEqual(statuses(h.posted, '1'), ['upgrade-targets-loading']);
  assert.deepEqual(h.enriched, []);
});

test('a cancel for another request id does not stop the current load', async () => {
  const client = controllableClient();
  const h = harness({ client });
  const pending = h.coordinator.handleLoadUpgradeTargets(load('2'));
  await tick();
  h.coordinator.handleCancelUpgradeTargets({ requestId: '1' });
  client.requests[0].resolve(ok({ versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } }));
  await pending;
  assert.deepEqual(statuses(h.posted, '2'), ['upgrade-targets-loading', 'upgrade-targets']);
  assert.equal(h.enriched.length, 1);
});

test('a newer load supersedes the one in flight', async () => {
  const client = controllableClient();
  const h = harness({ client, rows: [row('pkg'), row('other')] });
  const first = h.coordinator.handleLoadUpgradeTargets(load('1', 'pkg'));
  await tick();
  const second = h.coordinator.handleLoadUpgradeTargets(load('2', 'other'));
  await tick();
  assert.equal(client.requests[0].signal.aborted, true);
  client.requests[1].resolve(ok({ versions: { '1.0.0': {}, '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } }));
  await Promise.all([first, second]);
  assert.deepEqual(statuses(h.posted, '1'), ['upgrade-targets-loading']);
  assert.deepEqual(statuses(h.posted, '2'), ['upgrade-targets-loading', 'upgrade-targets']);
  assert.equal(h.enriched.length, 1);
});

test('closing the panel aborts the load and posts nothing more', async () => {
  const client = controllableClient();
  const h = harness({ client });
  const pending = h.coordinator.handleLoadUpgradeTargets(load('1'));
  await tick();
  h.dispose();
  await pending;
  assert.equal(client.requests[0].signal.aborted, true);
  assert.deepEqual(statuses(h.posted, '1'), ['upgrade-targets-loading']);
});

// ---------------------------------------------------------------------------
// Webview wiring (source contract: App.tsx has no render harness)
// ---------------------------------------------------------------------------

const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

test('Retry cancels the request it replaces, then reloads with a new request id', () => {
  const retry = app.slice(app.indexOf('const retryUpgradeTargets = useCallback'), app.indexOf('}, []);', app.indexOf('const retryUpgradeTargets = useCallback')));
  assert.match(retry, /pendingTargetRequestIdRef\.current !== null\) return;/);
  assert.match(retry, /setTargetReloadCount\(\(count\) => count \+ 1\)/, 'the effect does the cancel and reload');
  const effect = app.slice(app.indexOf('// A full packument is fetched only'), app.indexOf('const retryUpgradeTargets'));
  assert.match(effect, /requestId = `targets-\$\{\+\+nextTargetRequestIdRef\.current\}`/);
  assert.match(effect, /\[data\?\.generatedAt, manageRow, message\?\.status, targetReloadCount\]/);
});

test('closing Manage or switching package cancels the previous request, answered or not, before anything else', () => {
  const effect = app.slice(app.indexOf('// A full packument is fetched only'), app.indexOf('const retryUpgradeTargets'));
  const cancel = effect.indexOf("vscode.postMessage({ type: 'cancel-upgrade-targets', requestId: previous })");
  const branch = effect.indexOf('if (manageRow === null)');
  assert.ok(cancel > 0 && branch > 0 && cancel < branch);
  assert.match(effect, /const previous = activeTargetRequestIdRef\.current;/);
});

test('a review reset clears the whole target request lifecycle and reruns the effect', () => {
  const start = app.indexOf('// Reset the whole request lifecycle together');
  assert.ok(start > 0);
  const reset = app.slice(start, app.indexOf("} else if (reviewEffect === 'mark-stale')", start));
  assert.match(reset, /type: 'cancel-upgrade-targets', requestId: previousTargets/);
  assert.match(reset, /activeTargetRequestIdRef\.current = null;/);
  assert.match(reset, /pendingTargetRequestIdRef\.current = null;/);
  assert.match(reset, /setTargetReloadCount\(\(count\) => count \+ 1\)/);
});

test('Refresh uses the dashboard refresh, separate from re-analysing the upgrade', () => {
  assert.match(app, /onRetryTargets: retryUpgradeTargets,\s*onRefreshDashboard: refresh,/);
  assert.match(app, /const refresh = useCallback\(\(\) => \{\s*vscode\.postMessage\(\{ type: 'refresh' \}\);/);
});

// ---------------------------------------------------------------------------
// Behaviour added after review: cancellable version checks, fallback logging
// ---------------------------------------------------------------------------

test('a version check nobody wants any more is skipped and its versions are released', async () => {
  const { UpdateAdvisories } = await import('../out/host/updateAdvisories.js');
  let posts = 0;
  const memory = new UpdateAdvisories({ post: async () => { posts += 1; return { status: 200, headers: {}, body: '{}', wireBytes: 2 }; } }, () => true);
  let wanted = true;
  const published = [];
  const pending = memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => published.push(r), () => wanted);
  wanted = false;
  await pending;
  assert.equal(posts, 0, 'no request once the list was closed');
  assert.deepEqual(published, []);
  wanted = true;
  await memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => published.push(r), () => wanted);
  assert.equal(posts, 1, 'the released version is checked normally later');
  assert.equal(published.length, 1);
});

test('a version check closed while in flight keeps its result but does not publish it', async () => {
  const { UpdateAdvisories } = await import('../out/host/updateAdvisories.js');
  let release;
  const memory = new UpdateAdvisories({ post: () => new Promise((resolve) => { release = resolve; }) }, () => true);
  let wanted = true;
  const published = [];
  const pending = memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => published.push(r), () => wanted);
  await new Promise((resolve) => setImmediate(resolve));
  wanted = false;
  release({ status: 200, headers: {}, body: '{}', wireBytes: 2 });
  await pending;
  assert.deepEqual(published, []);
  assert.equal(memory.results().length, 1, 'already fetched, so kept for next time');
});

test('a real failure covered by the tags fallback is reported once; too-large histories stay quiet', async () => {
  for (const [code, expected] of [['TIMEOUT', ['TIMEOUT']], ['TOO_LARGE', []]]) {
    const client = fallbackClient(code);
    const seen = [];
    await loadUpgradeTargets(client, new MemoryEtagStore(), 'https://registry.npmjs.org', 'pkg', '1.0.0', '2.0.0',
      undefined, null, (c) => seen.push(c));
    assert.deepEqual(seen, expected);
  }
});

test('an http registry is named as such in the log, never as a bare BAD_URL', async () => {
  const { diagnosticLine } = await import('../out/core/diagnostics.js');
  assert.equal(diagnosticLine({ area: 'update-check', code: 'BAD_URL', packageName: 'pkg', registryUrl: 'http://npm.corp.example/' }),
    'update-check: pkg via npm.corp.example failed (insecure-registry (only https registries are used))');
});

test('a non-default upgrade target lookup failure sends a safe reason, not the raw URL', async () => {
  const { versionListFetchFailure } = await import('../out/host/upgradeAssistantCoordinator.js');
  const { FetchError } = await import('../out/core/registry/http.js');
  const { error } = versionListFetchFailure(new FetchError('REGISTRY_5XX', 'server error at https://u:SECRET@registry.example/private/TOKEN/pkg'));
  assert.equal(error.code, 'registry-error');
  assert.doesNotMatch(error.message, /SECRET|TOKEN|https?:/);
});

test('a reopened list gets results that a closed list was still checking', async () => {
  const { UpdateAdvisories } = await import('../out/host/updateAdvisories.js');
  // In flight when closed: the reopened caller is published to once the answer lands.
  let release;
  const memory = new UpdateAdvisories({ post: () => new Promise((resolve) => { release = resolve; }) }, () => true);
  let firstWanted = true;
  const first = [];
  const second = [];
  const one = memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => first.push(r), () => firstWanted);
  await new Promise((resolve) => setImmediate(resolve));
  firstWanted = false;
  const two = memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => second.push(r));
  release({ status: 200, headers: {}, body: '{}', wireBytes: 2 });
  await Promise.all([one, two]);
  assert.equal(first.length, 0);
  assert.equal(second.length, 1, 'the reopened list receives the result');

  // Queued when closed: the reopened caller claims and checks the released version itself.
  let posts = 0;
  const queued = new UpdateAdvisories({ post: async () => { posts += 1; return { status: 200, headers: {}, body: '{}', wireBytes: 2 }; } }, () => true);
  let wanted = true;
  const late = [];
  const a = queued.enrich([{ name: 'pkg', version: '3.0.0' }], () => true, () => {}, () => wanted);
  wanted = false;
  const b = queued.enrich([{ name: 'pkg', version: '3.0.0' }], () => true, (r) => late.push(r));
  await Promise.all([a, b]);
  assert.equal(posts, 1);
  assert.equal(late.length, 1);
  // A third open with everything settled and delivered publishes nothing new.
  const third = [];
  await queued.enrich([{ name: 'pkg', version: '3.0.0' }], () => true, (r) => third.push(r));
  assert.equal(third.length, 0);
});

test('a dashboard publish delivers what a closed list fetched, so reopening adds no repeat update', async () => {
  const { UpdateAdvisories } = await import('../out/host/updateAdvisories.js');
  let release;
  let posts = 0;
  const memory = new UpdateAdvisories({ post: () => { posts += 1; return posts === 1
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve({ status: 200, headers: {}, body: '{}', wireBytes: 2 }); } }, () => true);
  let pickerWanted = true;
  const picker = memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, () => {}, () => pickerWanted);
  await new Promise((resolve) => setImmediate(resolve));
  pickerWanted = false;
  const dashboard = [];
  const offered = memory.enrich([{ name: 'other', version: '1.0.0' }], () => true, (r) => dashboard.push(r));
  release({ status: 200, headers: {}, body: '{}', wireBytes: 2 });
  await Promise.all([picker, offered]);
  assert.equal(dashboard.length, 1);
  assert.deepEqual(dashboard[0].map((r) => r.name).sort(), ['other', 'pkg'], 'the dashboard snapshot carries both');
  const reopened = [];
  await memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => reopened.push(r));
  assert.equal(reopened.length, 0, 'already delivered');
  assert.equal(posts, 2, 'each version checked once');
});

test('reopening after a closed list finished still delivers its result once', async () => {
  const { UpdateAdvisories } = await import('../out/host/updateAdvisories.js');
  let release;
  const memory = new UpdateAdvisories({ post: () => new Promise((resolve) => { release = resolve; }) }, () => true);
  let wanted = true;
  const closed = memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, () => {}, () => wanted);
  await new Promise((resolve) => setImmediate(resolve));
  wanted = false;
  release({ status: 200, headers: {}, body: '{}', wireBytes: 2 });
  await closed;
  const reopened = [];
  await memory.enrich([{ name: 'pkg', version: '2.0.0' }], () => true, (r) => reopened.push(r));
  assert.equal(reopened.length, 1);
});
