import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { UsageAnalysisCoordinator } from '../out/host/usage/usageCoordinator.js';
import { usageWorkspace, folder } from './helpers/usage-coverage.mjs';

const bundle = await build({
  stdin: { contents: `
export { buildSmartCleanupPlan } from './webview/src/smartCleanupPlanAdapter.ts';
export { createSmartCleanupState, smartCleanupReducer } from './webview/src/smartCleanupState.ts';
export { SmartCleanupWorkspace } from './webview/src/components/SmartCleanupWorkspace.tsx';
export { RemovalReviewPanel } from './webview/src/components/RemovalReviewPanel.tsx';
export { UsageReferencesPanel } from './webview/src/components/UsageReferencesPanel.tsx';`,
  resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react/*'],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { buildSmartCleanupPlan, createSmartCleanupState, smartCleanupReducer,
  SmartCleanupWorkspace, RemovalReviewPanel, UsageReferencesPanel } = module.exports;
const noop = () => {};
const row = { name: 'only-here', range: '^1.0.0', current: '1.0.0', dev: false, advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null };

async function analyzed(entries) {
  const workspace = usageWorkspace(entries);
  const messages = [];
  const coordinator = new UsageAnalysisCoordinator({
    platform: workspace.platform, sink: { postMessage: message => messages.push(message) },
    ensureController: async () => ({ root: folder.path, lastResultRows: () => [row], upgradeSource: {
      manifestText: JSON.stringify({ dependencies: { 'only-here': '^1.0.0' } }), lockfileText: null, lockfilePath: null,
      packageManager: 'npm', importerId: '.',
    } }),
    getSelectedProject: () => ({ id: 'coverage', dir: '', folder }), isDisposed: () => false,
  });
  await coordinator.handleAnalyzeCleanup();
  await coordinator.handleAnalyzeRemovalImpact({ requestId: 'impact', packages: ['only-here'] });
  const impact = messages.findLast(message => message.status === 'removal-impact-result');
  const hygieneFindings = messages.findLast(message => message.status === 'cleanup-result').findings;
  const removalImpact = { ...impact, phase: 'done', assessments: new Map(impact.assessments.map(entry => [entry.packageName, entry])) };
  return { coordinator, workspace, messages, hygieneFindings, removalImpact };
}

for (const [name, entries, explanation] of [
  ['MDX', [['doc.mdx', `It's prose\nimport 'only-here';`]], '.mdx files'],
  ['interpolation', [['app.ts', 'const x = `${require("only-here")}`;']], 'template-literal interpolations'],
]) {
  test(`${name} host assessments prevent Smart Cleanup selection and explain the gap on all review screens`, async t => {
    const result = await analyzed(entries);
    t.after(() => result.coordinator.dispose());
    const { assessment } = result.removalImpact.assessments.get('only-here');
    assert.equal(assessment.status, 'unknown', 'coverage must reach the host assessment, not just finding confidence');
    const deprecated = { packageName: 'only-here', kind: 'deprecated', severity: 'warning', summary: 'Deprecated',
      evidence: { kind: 'deprecated', message: 'Maintainer message still visible' } };
    const securityRow = { ...row, advisories: [{ flaggedPackage: 'only-here', path: ['only-here'], flaggedVersion: '1.0.0',
      advisory: { id: 'GHSA-test', packageName: 'only-here', severity: 'high', title: 'Security finding still visible', vulnerableRange: '*', url: 'https://example.com' } }] };
    const plan = buildSmartCleanupPlan({ projectName: 'coverage', requestId: 'plan', rows: [securityRow],
      hygieneFindings: result.hygieneFindings, exactDeprecatedFindings: [deprecated], removalImpact: result.removalImpact,
      capability: { executionSupported: true } });
    const pendingPlan = buildSmartCleanupPlan({ projectName: 'coverage', requestId: 'pending', rows: [row],
      hygieneFindings: result.hygieneFindings, exactDeprecatedFindings: [], removalImpact: { phase: 'analyzing' },
      capability: { executionSupported: true } });
    assert.ok(pendingPlan.recommendations[0].rationale.includes(explanation), 'cleanup explains coverage while removal assessment is still pending');
    const starting = smartCleanupReducer(createSmartCleanupState('coverage'), { type: 'analysis-started', requestId: 'plan', projectName: 'coverage', steps: [] });
    const state = smartCleanupReducer(starting, { type: 'analysis-ready', requestId: 'plan', plan });
    assert.equal(state.selectedActionIds.size, 0);
    assert.equal(plan.deprecated.length, 1);
    assert.equal(plan.security.length, 1);
    const cleanup = renderToStaticMarkup(createElement(SmartCleanupWorkspace, {
      state: { ...state, expandedCategories: new Set(['unused', 'deprecated', 'security']) }, dispatch: noop,
      onClose: noop, onAnalyze: noop, onCancelAnalysis: noop, removalPreflight: null, preflightBusy: false,
      onPrepareRemoval: noop, onConfirmRemoval: noop, onKeepDependency: noop, onBackToReview: noop, onOpenDependencyReview: noop,
    }));
    assert.ok(cleanup.includes(explanation));
    assert.match(cleanup, /Removals are not recommended automatically/);
    assert.match(cleanup, /Maintainer message still visible/);
    assert.equal(plan.security[0].summary, 'Security finding still visible');
    assert.match(cleanup, /1 advisory finding/);
    assert.match(cleanup, /<input[^>]*disabled=""[^>]*aria-label="Remove only-here"/);
    const removal = renderToStaticMarkup(createElement(RemovalReviewPanel, {
      row, active: true, analysis: {
        analysisId: 'review', package: row.name, analyzedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z',
        changes: [{ packageName: row.name, classification: 'prod', stillRequiredBy: [] }],
        files: { manifestPath: '/workspace/package.json', lockfilePath: '/workspace/package-lock.json', rollbackAvailable: true },
        verification: { configured: false, suggestedScriptNames: [] },
      }, busy: false, error: null, removalImpact: result.removalImpact, usage: undefined,
      advisoriesAvailable: true, now: Date.now(), onAnalyzeRemoval: noop, onConfirm: noop, onViewReferences: noop, onConfigureVerification: noop,
    }));
    assert.ok(removal.includes(explanation));
    assert.match(removal, /Removals are not recommended automatically/);
    const usageResult = (await result.workspace.analyze()).get('only-here');
    const usage = renderToStaticMarkup(createElement(UsageReferencesPanel, {
      row, usage: { phase: 'done', usageId: 'usage', result: usageResult, fromCache: false, cacheExpiresAt: '2099-01-01' },
      hygieneFindings: result.hygieneFindings, now: Date.now(), onReanalyzeUsage: noop, onOpenUsageReference: noop, onChangeTab: noop,
    }));
    assert.ok(usage.includes(explanation));
  });
}
