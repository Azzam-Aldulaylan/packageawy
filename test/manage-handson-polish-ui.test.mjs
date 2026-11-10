/** Upgrade review verification row, Manage footer note, and tab status dots. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: [
      'export { verificationReviewSignal } from "./webview/src/components/UpgradeAnalysisSections.tsx";',
      'export { manageFooterNote } from "./webview/src/components/ManageDependencyModal.tsx";',
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { verificationReviewSignal, manageFooterNote } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const unconfigured = { configured: false, suggestedScriptNames: ['build', 'test'] };

test('the Verification row names the ticked scripts', () => {
  const signal = verificationReviewSignal(unconfigured, ['build', 'test']);
  assert.equal(signal.value, 'build, test will run');
  assert.equal(signal.tone, 'neutral');
  assert.equal(signal.needsReview, false);
});

test('the Verification row falls back when nothing is ticked or configured', () => {
  const signal = verificationReviewSignal(unconfigured, []);
  assert.equal(signal.value, 'Build/test checks not configured');
  assert.equal(signal.tone, 'warning');
  assert.equal(signal.needsReview, true);
  assert.equal(verificationReviewSignal(unconfigured).value, 'Build/test checks not configured');
});

test('configured scripts keep their own summary and ignore ticked suggestions', () => {
  const signal = verificationReviewSignal({ configured: true, scriptNames: ['lint'] }, ['build']);
  assert.equal(signal.value, 'Install + 1 script queued');
});

test('the completed review passes the ticked scripts into its signals', () => {
  const review = readFileSync('webview/src/components/UpgradeReviewPanel.tsx', 'utf8');
  assert.match(review, /selectedSuggestions\(analysis\.verification, verificationOptIn\.selectionFor\(analysis\.analysisId\)\)/);
});

const result = (application) => ({
  package: 'axios', refreshId: 'r', install: 'succeeded', application, verification: 'passed', changes: [], refreshingDerivedData: false,
});

test('the footer keeps the read-only note only while nothing has been applied', () => {
  assert.match(manageFooterNote(null), /^Analysis does not modify your project\./);
  assert.equal(manageFooterNote(result('applied')), 'Changes were applied to package.json and the lockfile.');
  assert.equal(manageFooterNote(result('rolled-back')), 'Your dependency files were restored.');
  assert.equal(manageFooterNote(result('unconfirmed')), null);
});

test('tab status dots sit right after their label', () => {
  const css = readFileSync('webview/src/styles.css', 'utf8');
  const tab = css.match(/^\.manage-tabs__tab\s*\{([^}]+)\}/m)?.[1] ?? '';
  assert.match(tab, /grid-template-columns:\s*1\.35rem minmax\(0, max-content\) 0\.4rem/);
  assert.match(tab, /justify-content:\s*start/);
});
