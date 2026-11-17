/** Smart Cleanup results offer the host-kept restore point and report its outcome. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { makeCoordinator, makeProject, review } from './helpers/removal-project.mjs';
import { manualReinstallNote } from '../out/host/manualReinstallCopy.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { rollbackFixture } from './helpers/optional-reinstall.mjs';

const require = createRequire(import.meta.url);
const app = await readFile(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

const bundle = await build({
  stdin: {
    contents: [
      'export { TransitiveFixReview } from "./webview/src/components/TransitiveFixReview.tsx";',
      'export { RemovalResultPanel } from "./webview/src/components/RemovalProgressPanels.tsx";',
      'export { SmartCleanupWorkspace } from "./webview/src/components/SmartCleanupWorkspace.tsx";',
      'export { createSmartCleanupState, smartCleanupReducer, canCloseSmartCleanup } from "./webview/src/smartCleanupState.ts";',
    ].join('\n'),
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
      plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
        path: pathToFileURL(require.resolve(args.path)).href,
        external: true,
      }));
    },
  }],
});
const { TransitiveFixReview, RemovalResultPanel, SmartCleanupWorkspace, createSmartCleanupState, smartCleanupReducer, canCloseSmartCleanup } = await import(
  `data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=smart-cleanup-restore.fixture.js`).toString('base64')}`
);

const result = {
  metrics: [],
  completedActionIds: ['remove-direct:react'],
  skippedActionIds: [],
  failedActionIds: [],
  resolvedAdvisories: [],
  introducedAdvisories: [],
  verification: 'passed',
  rollback: 'not-needed',
};

function completed() {
  return smartCleanupReducer(createSmartCleanupState('fixture'), { type: 'execution-complete', result });
}

function render(state, onRestoreFiles = () => {}) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(SmartCleanupWorkspace, {
    state,
    dispatch: noop,
    onClose: noop,
    onAnalyze: noop,
    onCancelAnalysis: noop,
    removalPreflight: null,
    preflightBusy: false,
    onPrepareRemoval: noop,
    onConfirmRemoval: noop,
    onKeepDependency: noop,
    onBackToReview: noop,
    onOpenDependencyReview: noop,
    onRestoreFiles,
  }));
}

test('without a host restore point the result does not offer undo', () => {
  const html = render(completed());
  assert.match(html, /<h3>Cleanup done<\/h3>/);
  assert.doesNotMatch(html, /Undo cleanup/);
  assert.doesNotMatch(html, /Restore dependency files/);
});

test('a kept restore point shows the action and explains what it does', () => {
  const state = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  const html = render(state);
  assert.match(html, /<button type="button" class="button button--secondary" data-undo-id="a1" data-undo-location="result" aria-busy="false">Undo cleanup<\/button>/);
  assert.doesNotMatch(html, /Open recovery|cleanup changes were kept/);
  assert.doesNotMatch(html, /reinstalls dependencies/);
  assert.doesNotMatch(html, /Use source control/);
});

test('restoring locks the workspace, then reports restored files and offers re-analysis', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  assert.equal(smartCleanupReducer(available, { type: 'restore-started', analysisId: 'other' }), available);
  const restoring = smartCleanupReducer(available, { type: 'restore-started', analysisId: 'a1' });
  assert.equal(canCloseSmartCleanup(restoring), false);
  assert.match(render(restoring), /disabled="" aria-busy="true">Restoring dependency files…<\/button>/);

  const restored = smartCleanupReducer(restoring, { type: 'restore-finished' });
  assert.equal(canCloseSmartCleanup(restored), true);
  const html = render(restored);
  assert.match(html, /<h3>Dependency files restored<\/h3>/);
  assert.match(html, /data-tone="restored"/);
  assert.match(html, /package\.json and the lockfile were put back\. Script side effects were not restored\./);
  assert.match(html, /Analyze current project/);
  assert.doesNotMatch(html, /Restore dependency files<\/button>/);
});

test('after a restore the results describe the restored dependencies, not the removed state', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  const restoring = smartCleanupReducer(available, { type: 'restore-started', analysisId: 'a1' });
  const html = render(smartCleanupReducer(restoring, { type: 'restore-finished' }));
  assert.match(html, /<h4>Restored dependencies<\/h4>/);
  assert.match(html, /removed by the cleanup and is back in the project/);
  assert.doesNotMatch(html, /<h4>Removed dependencies<\/h4>/);
  assert.doesNotMatch(html, /<h4>Verification<\/h4>/);
  assert.doesNotMatch(html, /smart-cleanup-metrics/);
});

test('result actions follow the change list in the persistent bottom footer', () => {
  const html = render(smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' }));
  assert.ok(html.indexOf('Undo cleanup') > html.indexOf('What changed'));
  assert.match(html, /<footer class="smart-cleanup-footer"><div class="smart-cleanup-results__actions">/);
  assert.ok(html.indexOf('Undo cleanup') < html.indexOf('Analyze current project'));
});

test('a cleanup with no build or test scripts is not reported as verified', () => {
  const state = smartCleanupReducer(createSmartCleanupState('fixture'), {
    type: 'execution-complete',
    result: { ...result, verification: 'not-configured', projectScriptsPresent: false, detail: 'Removed react. Dependency files were checked. No build or test scripts ran.' },
  });
  const html = render(state);
  assert.match(html, /<h3>Cleanup done<\/h3>/);
  assert.match(html, /1 package removed\./);
  const outcome = html.match(/<section class="smart-cleanup-results__headline"[^>]*>(.*?)<\/section>/s)?.[1];
  assert.equal((outcome.match(/No test scripts to run\. Run your build and tests before relying on the result\./g) ?? []).length, 1);
  assert.doesNotMatch(html, /verification passed/);
  assert.doesNotMatch(html, /Verified cleanup results/);
  // The detail line only repeated the headline on a completed run.
  assert.doesNotMatch(html, /smart-cleanup-results__detail/);
});

for (const projectScriptsPresent of [false, true, undefined]) for (const phase of ['complete', 'incomplete']) {
  test(`${phase} cleanup labels unselected checks from the ${String(projectScriptsPresent)} script snapshot`, () => {
    const label = projectScriptsPresent === false ? 'No test scripts to run' : 'No checks selected';
    const state = smartCleanupReducer(createSmartCleanupState('fixture'), {
      type: phase === 'complete' ? 'execution-complete' : 'execution-incomplete',
      message: 'Final counts could not be refreshed.',
      result: { ...result, verification: 'not-configured', projectScriptsPresent },
    });
    const html = render(state);
    const detail = `${label}. Run your build and tests before relying on the result.`;
    assert.ok(html.includes(`<p>${detail}</p>`));
    assert.doesNotMatch(html, projectScriptsPresent === false ? /No checks selected/ : /No test scripts to run/);
    if (phase === 'incomplete') assert.ok(html.includes(`<span>${label}</span>`));
    else {
      const announcement = html.match(/<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">(.*?)<\/p>/s)?.[1];
      assert.ok(announcement.includes(detail), 'the live announcement matches visible feedback');
    }
  });
}

for (const [verification, detail] of [
  ['passed', 'Configured project checks passed after cleanup.'],
  ['failed', 'Configured project checks failed after cleanup.'],
  ['not-configured', 'No test scripts to run. Run your build and tests before relying on the result.'],
  ['not-run', 'No post-cleanup project verification was run.'],
]) for (const count of [0, 1, 2]) test(`completion announces ${count} removed packages and ${verification} verification`, () => {
  const state = smartCleanupReducer(createSmartCleanupState('fixture'), {
    type: 'execution-complete',
    result: { ...result, verification, projectScriptsPresent: false, completedActionIds: [
      ...Array.from({ length: count }, (_, index) => `remove-direct:package-${index}`),
      'security-review:remaining',
    ] },
  });
  const html = render(state);
  const announcement = html.match(/<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">(.*?)<\/p>/s)?.[1];
  assert.equal(announcement, `Cleanup done. ${count} ${count === 1 ? 'package removed' : 'packages removed'}. ${detail}`);
  assert.equal((html.match(/<h3>Cleanup done<\/h3>/g) ?? []).length, 1, 'one visible outcome');
});

test('restored cleanup completion never announces the previous removed-package result', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  const restoring = smartCleanupReducer(available, { type: 'restore-started', analysisId: 'a1' });
  const restored = smartCleanupReducer(restoring, { type: 'restore-finished' });
  const announcement = render(restored).match(/<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">(.*?)<\/p>/s)?.[1];
  assert.equal(announcement, 'Dependency files restored. package.json and the lockfile were put back. Script side effects were not restored.');
});

test('a refused restore shows the host message as a warning', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  const restoring = smartCleanupReducer(available, { type: 'restore-started', analysisId: 'a1' });
  const message = 'Restore was not started because package.json or the lockfile changed after the cleanup. Newer edits were preserved.';
  const html = render(smartCleanupReducer(restoring, { type: 'restore-refused', message }));
  assert.match(html, /role="status"/);
  assert.match(html, /Newer edits were preserved\./);
  assert.doesNotMatch(html, /Restore dependency files<\/button>/);
});

test('a new cleanup result clears an old restore point', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  assert.equal(smartCleanupReducer(available, { type: 'execution-complete', result }).restore, null);
});

test('the app opens recovery with a host analysis id and never starts the former automatic restore', () => {
  assert.match(app, /incoming\.result\.restoreAvailable === true && kept/);
  assert.match(app, /vscode\.postMessage\(\{ type: 'restore-smart-cleanup', analysisId \}\)/);
  assert.doesNotMatch(app, /dispatchSmartCleanup\(\{ type: 'restore-started'/);
  assert.match(app, /case 'recovery':/);
});

for (const reinstall of ['succeeded', 'failed', 'skipped']) test(`cleanup rollback guidance matches optional reinstall ${reinstall}`, async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.state.installExitCode = 1;
  f.state.reinstallChoice = reinstall === 'skipped' ? 'Skip' : 'Reinstall';
  f.state.reinstallExitCode = reinstall === 'failed' ? 1 : 0;
  await f.coordinator.handleConfirmRemove({ analysisId: await review(f) });
  const hostResult = f.messages.findLast(message => message.status === 'remove-result')?.result;
  assert.equal(hostResult?.outcome, 'rolled-back', JSON.stringify(f.messages));
  assert.deepEqual(f.commands, reinstall === 'skipped' ? ['install'] : ['install', 'ci']);
  const state = smartCleanupReducer(createSmartCleanupState('fixture'), {
    type: 'execution-cancelled-and-restored',
    result: { ...result, rollback: 'restored', detail: hostResult.message },
  });
  const html = render(state);
  if (reinstall === 'succeeded') {
    assert.doesNotMatch(html, /Run your package manager|run npm install|To reinstall by hand|node_modules and script side effects were not restored/);
    assert.match(html, /Dependencies were reinstalled using the restored lockfile/);
  } else {
    assert.ok(html.includes(manualReinstallNote('npm')), html);
  }
});

for (const reinstall of ['succeeded', 'failed', 'skipped']) test(`normal removal panel follows actual reinstall ${reinstall}`, async t => {
  const project = await makeProject(t);
  const f = makeCoordinator(project, { mutationRoot: () => project.root });
  f.state.installExitCode = 1;
  f.state.reinstallChoice = reinstall === 'skipped' ? 'Skip' : 'Reinstall';
  f.state.reinstallExitCode = reinstall === 'failed' ? 1 : 0;
  await f.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
  const analysisId = f.messages.findLast(message => message.status === 'remove-analysis').analysis.analysisId;
  await f.coordinator.handleConfirmRemove({ analysisId });
  const hostResult = f.messages.findLast(message => message.status === 'remove-result')?.result;
  assert.equal(hostResult?.outcome, 'rolled-back', JSON.stringify(f.messages));
  const html = renderToStaticMarkup(createElement(RemovalResultPanel, {
    row: { name: 'react', current: '18.2.0', range: '^18.0.0' }, result: hostResult,
  }));
  assert.ok(html.includes(hostResult.message), html);
  if (reinstall === 'succeeded') {
    assert.doesNotMatch(html, /Run your package manager|run npm install|To reinstall by hand|node_modules were not restored/);
    assert.match(html, /Dependencies were reinstalled using the restored lockfile/);
  } else assert.ok(html.includes(manualReinstallNote('npm')), html);
});

for (const reinstall of ['succeeded', 'failed', 'skipped']) test(`transitive result panel follows actual optional reinstall ${reinstall}`, async t => {
  const f = await rollbackFixture(t, 'transitive');
  f.state.reinstallChoice = reinstall === 'skipped' ? 'Skip' : 'Reinstall';
  f.state.reinstallExitCode = reinstall === 'failed' ? 1 : 0;
  await f.confirm();
  const hostResult = f.messages.findLast(message => message.status === 'remediation-apply-result')?.result;
  assert.equal(hostResult?.outcome, 'rolled-back', JSON.stringify(f.messages));
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(TransitiveFixReview, {
    rootPackage: 'react', subject: 'react', dependencyPath: ['react'], disabled: false,
    state: { phase: 'result', plan: { rootPackage: 'react', changes: [], files: {} }, result: hostResult },
    onAnalyze: noop, onReview: noop, onApply: noop, onCancel: noop, onRetry: noop, onOpenAdvisory: noop,
  }));
  const note = reinstall === 'succeeded' ? 'Dependencies were reinstalled using the restored lockfile.' : manualReinstallNote('npm');
  assert.ok(html.includes(note), html);
  if (reinstall === 'succeeded') assert.doesNotMatch(html, /Run your package manager|run npm install|To reinstall by hand|node_modules were not restored/);
});

test('security result headings name vulnerabilities and metric copy explains the two counts', async () => {
  const finding = { sourceId: 'npm:1', identifiers: ['CVE-2026-1234'], flaggedPackage: 'affected', title: 'Published report', severity: 'high' };
  const state = smartCleanupReducer(createSmartCleanupState('fixture'), {
    type: 'execution-complete', result: { ...result, resolvedAdvisories: [finding], introducedAdvisories: [{ ...finding, sourceId: 'npm:2' }] },
  });
  const html = render(state);
  assert.match(html, /<h4[^>]*>Resolved vulnerabilities<\/h4>/);
  assert.match(html, /<h4[^>]*>New vulnerabilities to review<\/h4>/);
  const host = await readFile(join(process.cwd(), 'src/host/upgradeAssistantCoordinator.ts'), 'utf8');
  for (const source of [app, host]) {
    for (const copy of [
      'Affected packages',
      'Your direct dependencies affected by a known vulnerability, directly or through their own dependencies.',
      'Known vulnerabilities',
      'Separate published security reports that apply, counted once even when several packages reach them.',
    ]) assert.ok(source.includes(copy), copy);
    assert.doesNotMatch(source, /Vulnerable direct dependencies|Advisory findings/);
  }
});
