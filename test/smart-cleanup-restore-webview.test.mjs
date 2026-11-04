/** Smart Cleanup results offer the host-kept restore point and report its outcome. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const app = await readFile(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');

const bundle = await build({
  stdin: {
    contents: [
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
const { SmartCleanupWorkspace, createSmartCleanupState, smartCleanupReducer, canCloseSmartCleanup } = await import(
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

test('without a host restore point the results keep the source control guidance', () => {
  const html = render(completed());
  assert.match(html, /The cleanup changes were kept\. Use source control if you need to reverse them later\./);
  assert.doesNotMatch(html, /Restore dependency files/);
});

test('a kept restore point shows the action and explains what it does', () => {
  const state = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  const html = render(state);
  assert.match(html, /<button type="button" class="button button--secondary">Restore dependency files<\/button>/);
  assert.match(html, /puts package\.json and the lockfile back as they were\s+before the cleanup and reinstalls dependencies/);
  assert.match(html, /It is refused if either file changed after the cleanup\./);
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
  assert.match(html, /package\.json and the lockfile were put back as they were before the cleanup, and dependencies were reinstalled\./);
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

test('the restore note sits above the change list so the action is visible without scrolling', () => {
  const html = render(smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' }));
  assert.ok(html.indexOf('Restore dependency files') < html.indexOf('What changed'));
});

test('a cleanup with no build or test scripts is not reported as verified', () => {
  const state = smartCleanupReducer(createSmartCleanupState('fixture'), {
    type: 'execution-complete',
    result: { ...result, verification: 'not-configured', detail: 'Removed react. Dependency files were checked. No build or test scripts ran.' },
  });
  const html = render(state);
  assert.match(html, /<h3>Cleanup applied<\/h3>/);
  assert.match(html, /Dependency files were checked, but no build or test scripts ran/);
  assert.match(html, /No build or test scripts are configured for verification\./);
  assert.doesNotMatch(html, /verification passed/);
  assert.doesNotMatch(html, /Verified cleanup results/);
  // The detail line only repeated the headline on a completed run.
  assert.doesNotMatch(html, /smart-cleanup-results__detail/);
});

test('a refused restore shows the host message as a warning', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  const restoring = smartCleanupReducer(available, { type: 'restore-started', analysisId: 'a1' });
  const message = 'Restore was not started because package.json or the lockfile changed after the cleanup. Newer edits were preserved.';
  const html = render(smartCleanupReducer(restoring, { type: 'restore-refused', message }));
  assert.match(html, /class="smart-cleanup-results__recovery" data-tone="attention"/);
  assert.match(html, /Newer edits were preserved\./);
  assert.doesNotMatch(html, /Restore dependency files<\/button>/);
});

test('a new cleanup result clears an old restore point', () => {
  const available = smartCleanupReducer(completed(), { type: 'restore-available', analysisId: 'a1' });
  assert.equal(smartCleanupReducer(available, { type: 'execution-complete', result }).restore, null);
});

test('the app sends only the host analysis id and routes the restore outcome to the results', () => {
  assert.match(app, /incoming\.result\.restoreAvailable === true && kept/);
  assert.match(app, /vscode\.postMessage\(\{ type: 'restore-smart-cleanup', analysisId \}\)/);
  assert.match(app, /dispatchSmartCleanup\(\{ type: 'restore-refused', message: incoming\.error\.message \}\)/);
  assert.match(app, /dispatchSmartCleanup\(\{ type: 'restore-finished' \}\)/);
});
