import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { auditInstalledPeer } from './helpers/installed-peer-security.mjs';

const require = createRequire(import.meta.url);
const reactUrl = pathToFileURL(require.resolve('react')).href;
// Preserve state between server renders so the real review callbacks and gates
// can be exercised without a browser. All other React behavior stays real.
const state = { values: [], cursor: 0, useState(initial) {
  const index = this.cursor++;
  if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial;
  return [this.values[index], value => { this.values[index] = typeof value === 'function' ? value(this.values[index]) : value; }];
} };
globalThis.__securityReviewState = state;
const bundle = await build({ stdin: { contents: `
  export { UpgradeReviewPanel } from './webview/src/components/UpgradeReviewPanel.tsx';
  export { UpgradeAnalysisModal } from './webview/src/components/UpgradeAnalysisModal.tsx';
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'persistent-react-state', setup(plugin) {
    plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'react-proxy', namespace: 'test' }));
    plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export * from '${reactUrl}';
      export const useState = initial => globalThis.__securityReviewState.useState(initial);`, loader: 'js' }));
    plugin.onResolve({ filter: /^react\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    plugin.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
  } }] });
const { UpgradeReviewPanel, UpgradeAnalysisModal } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const now = Date.now();
const change = { packageName: 'app', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'prod', majorUpdate: true };
function finding(severity = 'high', transitive = false) {
  return { advisory: { id: 100, severity, title: 'Target vulnerability', url: 'https://example.com/advisory', vulnerableVersions: '>=2' },
    flaggedPackage: transitive ? 'child' : 'app', path: transitive ? ['app', 'child'] : ['app'],
    resolvedVersion: '2.0.0', patchedVersion: { status: 'unknown' }, status: 'remains' };
}
function review(coordinated = false, security = { status: 'remains', checkState: 'complete', resolvedAdvisories: [], remaining: [], introduced: [finding()] }) {
  return { analysisId: 'review', analyzedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    package: 'app', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'prod', majorUpdate: true, changes: [change],
    compatibility: { status: coordinated ? 'conflict' : 'compatible', completeness: 'complete', findings: [] },
    projectCompatibility: { identity: { packageName: 'app', currentVersion: '1.0.0', targetVersion: '2.0.0' }, analyzers: [], findings: [] },
    smartPlan: coordinated ? { changes: [change, { ...change, packageName: 'added' }], reasonFindingIds: [] } : null,
    security, verification: { configured: false, suggestedScriptNames: [] },
    files: { manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json', rollbackAvailable: true } };
}
const noop = () => {};
function inspect(Component, analysis) {
  let consent;
  let action;
  const events = [];
  const label = analysis.compatibility.status === 'conflict' ? 'Use coordinated upgrade' : 'Upgrade to 2.0.0';
  function capture(element) {
    if (Array.isArray(element)) return element.forEach(capture);
    if (!element || typeof element !== 'object') return;
    if (element.props?.consent) consent = element.props.consent;
    if (element.type === 'button' && element.props.children === label) action = element.props;
    capture(element.props?.children);
  }
  const props = { analysis, packageName: 'app', targetVersion: '2.0.0', analyzingPhase: null, busy: false,
    hardStale: false, now, onConfirm: ack => events.push(['single', ack]), onUseSmartPlan: ack => events.push(['coordinated', ack]),
    onCancel: noop, onRefresh: noop, onConfigureVerification: noop, onOpenAdvisory: noop,
    row: { name: 'app', current: '1.0.0', range: '^1', upgradeTo: '2.0.0', advisories: [] },
    targetState: { phase: 'idle' }, active: true, sections: {}, error: null, disabled: false, advisoriesAvailable: true,
    onAnalyzeUpgrade: noop, onTargetChange: noop, onChangeTab: noop };
  function Probe() { const tree = Component(props); capture(tree); return tree; }
  state.cursor = 0;
  const html = renderToStaticMarkup(createElement(Probe));
  return { consent, action, html, events };
}

for (const [name, Component] of [['embedded', UpgradeReviewPanel], ['standalone', UpgradeAnalysisModal]]) {
  for (const coordinated of [false, true]) {
    test(`${name} ${coordinated ? 'coordinated' : 'single'} review displays auto-installed peer findings and requires consent`, async () => {
      state.values = [];
      const result = inspect(Component, review(coordinated, await auditInstalledPeer()));
      assert.match(result.html, /peer@3\.0\.0/);
      assert.match(result.html, /child@4\.0\.0/);
      assert.match(result.html, /Transitive dependency/);
      assert.equal(result.action.disabled, true);
      assert.equal(result.consent.required, true);
    });
  }
  for (const coordinated of [false, true]) {
    test(`${name} ${coordinated ? 'coordinated' : 'single'} review requires consent and resets it when the proposal changes`, () => {
      state.values = [];
      const analysis = review(coordinated);
      let result = inspect(Component, analysis);
      assert.match(result.html, /I understand this upgrade adds known vulnerabilities/);
      assert.match(result.html, /Vulnerabilities added by this upgrade/);
      assert.match(result.html, /app@2\.0\.0/);
      assert.match(result.html, /Direct dependency/);
      assert.equal(result.action.disabled, true);
      result.consent.setAcknowledged(true);
      result = inspect(Component, analysis);
      assert.equal(result.action.disabled, false);
      result.action.onClick();
      assert.deepEqual(result.events, [[coordinated ? 'coordinated' : 'single', true]]);
      const changed = structuredClone(analysis);
      if (coordinated) changed.smartPlan.changes[1].targetVersion = '3.0.0';
      else changed.changes[0].targetVersion = '3.0.0';
      result = inspect(Component, changed);
      assert.equal(result.action.disabled, true);
      assert.equal(result.consent.acknowledged, false);
      assert.equal(inspect(Component, analysis).action.disabled, true, 'returning to the previous proposal requires fresh consent');
    });
  }
  for (const severity of ['critical', 'moderate', 'low']) {
    test(`${name} introduced ${severity} finding has the expected acknowledgement gate`, () => {
      state.values = [];
      const security = { status: 'remains', checkState: 'complete', resolvedAdvisories: [], remaining: [], introduced: [finding(severity, true)] };
      const result = inspect(Component, review(false, security));
      assert.match(result.html, /Transitive dependency/);
      assert.equal(result.action.disabled, severity === 'critical');
      assert.equal(result.consent.required, severity === 'critical');
    });
  }
  test(`${name} unchanged findings, unavailable checks and Off stay visible without acknowledgement`, () => {
    for (const checkState of ['complete', 'unavailable', 'off']) {
      state.values = [];
      const security = { status: checkState === 'complete' ? 'remains' : 'unknown', checkState,
        resolvedAdvisories: [], remaining: checkState === 'complete' ? [finding()] : [], introduced: [] };
      const result = inspect(Component, review(false, security));
      assert.equal(result.action.disabled, false);
      assert.doesNotMatch(result.html, /I understand this upgrade adds known vulnerabilities/);
      if (checkState !== 'complete') assert.match(result.html, checkState === 'off' ? /Off/ : /Security check unavailable/);
    }
  });
}
