import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveUpgradeCandidate } from '../out/core/upgrade/candidate.js';
import { selectUpgradeTargets } from '../out/core/upgrade/targets.js';
import { isMajorUpgrade } from '../out/core/upgrade/plan.js';
import { classifyRowUpdate, classifyUpdate } from '../out/host/updateClassification.js';
import { summaryMetrics, updatesCardSubtitle } from '../out/host/summaryMetrics.js';
import { resolveActionState } from '../out/host/upgradeAction.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { buildUpgradeAnalysisPresentation } from '../out/host/upgradeAnalysisPresentation.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export { OverviewPanel } from './webview/src/components/OverviewPanel.tsx';
      export { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
      export { UpgradeReviewPanel } from './webview/src/components/UpgradeReviewPanel.tsx';
      export { UpgradeTargetSelector } from './webview/src/components/UpgradeTargetSelector.tsx';`,
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
const { OverviewPanel, ManageDependencyModal, UpgradeReviewPanel, UpgradeTargetSelector } = await import(
  `data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=upgrade-target-consistency.fixture.js`).toString('base64')}`
);
const noop = () => {};
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

function row(current = '0.21.1', target = '0.21.4', reason = 'security-fix') {
  return {
    name: 'axios', range: current, current, wanted: current, latest: '1.21.1',
    dev: false, advisories: [], worstSeverity: null, upgradeTo: target, upgradeReason: reason,
  };
}

function overview(dependency) {
  return render(OverviewPanel, {
    row: dependency, removalImpact: { phase: 'idle' },
    actionsDisabled: false, upgradeDisabled: false,
    updateResolutionAvailable: true, advisoriesAvailable: true,
    onStartUpgradeReview: noop, onStartRemovalReview: noop, onAnalyzeRemediation: noop,
    onReviewRemediation: noop, onApplyRemediation: noop, onCancelRemediation: noop,
    onRetryRemediation: noop, onOpenAdvisory: noop, onChangeTab: noop,
  });
}

for (const securityTarget of ['0.21.4', null]) {
  test(`card, table action and review start on the row target for ${securityTarget ? 'security fixes' : 'latest updates'}`, () => {
    const candidate = resolveUpgradeCandidate({
      current: '0.21.1', wanted: '0.21.1', latest: '1.21.1', securityTarget,
    });
    const dependency = row('0.21.1', candidate.target, candidate.reason);
    const targets = selectUpgradeTargets({
      versions: ['0.21.1', '0.21.2', '0.21.4', '1.21.1'], distTags: { latest: '1.21.1' },
    }, dependency.current, dependency.upgradeTo, dependency.upgradeReason);
    const targetState = { phase: 'ready', targets };
    const card = overview(dependency);
    assert.match(card, new RegExp(`version--target">${candidate.target.replaceAll('.', '\\.')}`));
    assert.equal(resolveActionState(dependency).target, candidate.target);

    // An unselected picker uses the same host-owned default even when the
    // publisher recommends a different release. Explicit choices still win.
    const picker = render(UpgradeTargetSelector, {
      state: targetState, selectedVersion: null, fallbackVersion: dependency.upgradeTo,
      disabled: false, onChange: noop,
    });
    assert.match(picker, new RegExp(`value="${candidate.target.replaceAll('.', '\\.')}" selected=""`));
    assert.match(picker, /1\.21\.1 · Recommended · Latest stable/);
    if (securityTarget !== null) assert.match(picker, /0\.21\.4 · Security fix/);
    assert.equal(isHostToWebviewMessage({ status: 'upgrade-targets', package: 'axios', requestId: '1', targets }), true);

    const review = render(UpgradeReviewPanel, {
      row: dependency, active: false, targetVersion: dependency.upgradeTo, targetState,
      busy: false, disabled: false, error: null, onTargetChange: noop,
    });
    assert.match(review, new RegExp(`value="${candidate.target.replaceAll('.', '\\.')}" selected=""`));
    const explicit = render(UpgradeTargetSelector, {
      state: targetState, selectedVersion: '0.21.2', fallbackVersion: dependency.upgradeTo,
      disabled: false, onChange: noop,
    });
    assert.match(explicit, /value="0\.21\.2" selected=""/);
  });
}

const changes = [
  ['0.21.1', '0.21.4', 'patch'],
  ['0.21.1', '0.22.0', 'minor'],
  ['0.21.1', '1.21.1', 'major'],
  ['1.2.3', '1.2.4', 'patch'],
  ['1.2.3', '1.3.0', 'minor'],
  ['1.2.3', '2.0.0', 'major'],
  ['1.0.0-beta.1', '1.0.0', 'major'],
];

for (const [current, target, kind] of changes) {
  test(`${current} to ${target} uses the same ${kind} classification for badges and summaries`, () => {
    const dependency = row(current, target);
    assert.equal(classifyUpdate(current, target), kind);
    assert.equal(classifyRowUpdate(dependency), kind);
    assert.equal(isMajorUpgrade(current, target), kind === 'major');
    const label = `${kind[0].toUpperCase()}${kind.slice(1)} update`;
    assert.match(overview(dependency), new RegExp(`>${label}</span>`));
    assert.equal(updatesCardSubtitle(summaryMetrics([dependency])), `1 ${kind}`);
    const analysis = buildUpgradeAnalysisPresentation({
      analysisId: 'review', analyzedAt: '2026-11-10T10:00:00Z', expiresAt: '2026-11-10T11:00:00Z',
      packageName: dependency.name, currentVersion: current, targetVersion: target, classification: 'prod',
      compatibility: { status: 'compatible', completeness: 'complete', findings: [] },
      projectCompatibility: {
        identity: { packageName: dependency.name, currentVersion: current, targetVersion: target, requestId: '1', sourceFingerprint: 'source' },
        analyzers: [], findings: [], startedAt: '2026-11-10T10:00:00Z', completedAt: '2026-11-10T10:00:00Z',
      },
      security: null, smartPlan: null, verificationScriptNames: [],
      manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json',
    });
    const review = render(UpgradeReviewPanel, {
      row: dependency, active: true, targetVersion: target, targetState: { phase: 'idle' },
      analysis, sections: {}, hardStale: false, now: Date.parse('2026-11-10T10:30:00Z'),
      busy: false, disabled: false, error: null, advisoriesAvailable: true,
    });
    assert.match(review, new RegExp(`>${label}</span>`));
    assert.equal(analysis.majorUpdate, kind === 'major');
  });
}

test('summary totals count the offered targets with the same classifier', () => {
  const metrics = summaryMetrics(changes.map(([current, target]) => row(current, target)));
  assert.equal(metrics.majorUpdates, 3);
  assert.equal(metrics.minorUpdates, 2);
  assert.equal(metrics.patchUpdates, 2);
  assert.equal(updatesCardSubtitle(metrics), '3 major · 2 minor · 2 patch');
});

test('host target listing carries the security label through to the review picker', async () => {
  const dependency = row();
  const messages = [];
  const body = JSON.stringify({
    versions: { '0.21.1': {}, '0.21.4': {}, '1.21.1': {} }, 'dist-tags': { latest: '1.21.1' },
  });
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage: message => messages.push(message) },
    httpClient: { get: async () => ({ status: 200, headers: {}, body, wireBytes: body.length }) },
    etagStore: { get: () => undefined, set: () => {} },
    ensureController: async () => ({
      lastResultRows: () => [dependency], validateUpgradeRequest: () => ({ ok: true }),
      upgradeSource: { resolvedRegistry: { url: 'https://registry.npmjs.org/', source: 'default', scoped: {} } },
    }),
    getSelectedProject: () => undefined, isDisposed: () => false,
    reloadFinalState: async () => {}, flushDeferredChanges: async () => {},
  });
  await coordinator.handleLoadUpgradeTargets({ type: 'load-upgrade-targets', package: 'axios', requestId: '1' });
  const loaded = messages.at(-1);
  assert.equal(loaded.status, 'upgrade-targets');
  assert.equal(isHostToWebviewMessage(loaded), true);
  assert.deepEqual(loaded.targets.options.find(option => option.version === '0.21.4').labels, ['security-fix']);
  assert.deepEqual(loaded.targets.options.find(option => option.version === '1.21.1').labels, ['recommended', 'latest']);
});

test('security target stays labeled when the version list cannot be loaded', () => {
  const html = render(UpgradeTargetSelector, {
    state: { phase: 'error', error: { code: 'NETWORK', message: 'Registry unavailable' } },
    selectedVersion: null, fallbackVersion: '0.21.4', fallbackReason: 'security-fix',
    disabled: false, onChange: noop,
  });
  assert.match(html, /value="0\.21\.4" selected="">0\.21\.4 \(Security fix\)/);
});

test('Review upgrade from Overview restores the card target after a different picker choice', () => {
  const events = [];
  let startReview;
  // Capture the real callback passed by the modal to its Overview panel.
  function capture(element) {
    if (Array.isArray(element)) return element.forEach(capture);
    if (element === null || typeof element !== 'object') return;
    if (element.type === OverviewPanel) startReview = element.props.onStartUpgradeReview;
    capture(element.props?.children);
  }
  function ModalProbe(props) {
    const element = ManageDependencyModal(props);
    capture(element);
    return element;
  }
  render(ModalProbe, {
    row: row(), allRows: [row()], activeTab: 'overview',
    removalImpact: { phase: 'idle' }, hygieneFindings: [],
    actionsDisabled: false, upgradeDisabled: false, updateResolutionAvailable: true,
    advisoriesAvailable: true, blockClose: false, upgradeResult: null, upgradeEnrichment: null,
    upgrade: {
      targetVersion: '1.21.1', active: false, analysis: null,
      onTargetChange: target => events.push(['target', target]),
    },
    removal: { error: null, active: false, analysis: null },
    onChangeTab: tab => events.push(['tab', tab]), onClose: noop,
  });
  startReview('axios', '0.21.4');
  assert.deepEqual(events, [['target', '0.21.4'], ['tab', 'upgrade']]);
});

for (const [target, reason] of [['3.0.0', 'update'], ['1.0.1', 'security-fix']]) {
  test(`publisher LTS is labelled in the picker while the dashboard ${reason} target stays selected`, () => {
    const targets = selectUpgradeTargets({
      versions: ['1.0.0', '1.0.1', '2.0.0', '3.0.0'],
      distTags: { lts: '2.0.0', latest: '3.0.0' },
    }, '1.0.0', target, reason);
    const html = render(UpgradeTargetSelector, {
      state: { phase: 'ready', targets }, selectedVersion: null,
      fallbackVersion: target, fallbackReason: reason, disabled: false, onChange: noop,
    });
    assert.match(html, new RegExp(`value="${target.replaceAll('.', '\\.')}" selected=""`));
    assert.match(html, /2\.0\.0 · Recommended · Publisher LTS/);
    assert.match(html, /3\.0\.0 · Latest stable/);
    const explicit = render(UpgradeTargetSelector, {
      state: { phase: 'ready', targets }, selectedVersion: '1.0.1',
      fallbackVersion: target, disabled: false, onChange: noop,
    });
    assert.match(explicit, /value="1\.0\.1" selected=""/);
    if (reason === 'security-fix') assert.match(html, /1\.0\.1 · Security fix/);
    assert.match(html, /Starts on the version shown on the dashboard/);
    assert.match(html, /Security fix, Publisher LTS and Latest stable versions are labelled in the list/);
  });
}
