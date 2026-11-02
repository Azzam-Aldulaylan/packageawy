import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: [
      'export { VerificationStepsCard } from "./webview/src/components/UpgradeAnalysisCards.tsx";',
      'export { VerificationSection } from "./webview/src/components/VerificationSection.tsx";',
      'export { VerificationOptInContext, confirmVerificationFields } from "./webview/src/components/VerificationSuggestions.tsx";',
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
const { VerificationStepsCard, VerificationSection, VerificationOptInContext, confirmVerificationFields } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=verification-suggestions.fixture.js').toString('base64')}`
);

const unconfigured = { configured: false, suggestedScriptNames: ['typecheck', 'build', 'test'] };

function render(component, props, selection = { scripts: [], remember: false }) {
  const store = { selectionFor: () => selection, update: () => {} };
  return renderToStaticMarkup(
    createElement(VerificationOptInContext.Provider, { value: store }, createElement(component, { onConfigureVerification: () => {}, ...props }))
  );
}

const checkboxes = (markup) => [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);

test('detected scripts render as unchecked choices with Remember for this project', () => {
  const markup = render(VerificationStepsCard, { analysisId: 'a1', verification: unconfigured });
  assert.match(markup, /Detected scripts\. Run after this upgrade:/);
  for (const name of ['typecheck', 'build', 'test']) assert.match(markup, new RegExp(`Run <code>${name}</code>`));
  assert.match(markup, /Remember for this project/);
  const boxes = checkboxes(markup);
  assert.equal(boxes.length, 4);
  assert.ok(boxes.every((box) => !/checked=""/.test(box)), 'nothing is selected by default');
  assert.ok(/disabled=""/.test(boxes[3]), 'Remember is disabled until a script is selected');
  assert.match(markup, /Not configured/);
  assert.match(markup, /Configure verification/);
});

test('selected scripts show as queued steps and keep the configure button', () => {
  const markup = render(VerificationStepsCard, { analysisId: 'a1', verification: unconfigured }, { scripts: ['test', 'build'], remember: true });
  assert.doesNotMatch(markup, /Not configured/);
  const queued = [...markup.matchAll(/<li class="verification-steps__item"><span>Run <code>([^<]+)<\/code><\/span><span class="status-badge status-badge--neutral">Queued/g)]
    .map((match) => match[1]);
  assert.deepEqual(queued, ['build', 'test'], 'queued in host suggestion order');
  const boxes = checkboxes(markup);
  assert.equal(boxes.filter((box) => /checked=""/.test(box)).length, 3);
  assert.match(markup, /Configure verification/);
});

test('no choices are offered before the review has an id, without suggestions, or when configured', () => {
  assert.doesNotMatch(render(VerificationStepsCard, { verification: unconfigured }), /Detected scripts/);
  assert.doesNotMatch(
    render(VerificationStepsCard, { analysisId: 'a1', verification: { configured: false, suggestedScriptNames: [] } }),
    /Detected scripts/
  );
  const configured = render(VerificationStepsCard, { analysisId: 'a1', verification: { configured: true, scriptNames: ['lint'] } }, { scripts: ['build'], remember: true });
  assert.doesNotMatch(configured, /Detected scripts|<code>build<\/code>/);
  assert.match(configured, /Run <code>lint<\/code>/);
});

test('the modal Verification section offers the same choices', () => {
  const markup = render(VerificationSection, { analysisId: 'r1', verification: unconfigured, actionLabel: 'this removal' }, { scripts: ['build'], remember: false });
  assert.match(markup, /Detected scripts\. Run after this removal:/);
  assert.match(markup, /Selected checks run after this change/);
});

test('confirm fields carry only selected suggestions, and remember only alongside them', () => {
  assert.deepEqual(confirmVerificationFields(unconfigured, { scripts: [], remember: true }), {});
  assert.deepEqual(confirmVerificationFields(unconfigured, { scripts: ['test', 'postinstall'], remember: false }), { verificationScripts: ['test'] });
  assert.deepEqual(confirmVerificationFields(unconfigured, { scripts: ['test', 'typecheck'], remember: true }), {
    verificationScripts: ['typecheck', 'test'],
    rememberVerificationScripts: true,
  });
  assert.deepEqual(confirmVerificationFields({ configured: true, scriptNames: ['lint'] }, { scripts: ['lint'], remember: true }), {});
});

test('every confirm path sends the opt-in, and every review surface offers it', () => {
  const app = readFileSync(new URL('../webview/src/App.tsx', import.meta.url), 'utf8');
  for (const type of ['confirm-upgrade', 'use-smart-plan', 'confirm-remove', 'confirm-remediation']) {
    assert.match(app, new RegExp(`type: '${type}',[\\s\\S]{0,200}confirmVerificationFields\\(`), type);
  }
  assert.match(app, /<VerificationOptInContext\.Provider value=\{verificationOptInStore\}>/);
  for (const file of ['RemovalReviewPanel.tsx', 'TransitiveFixReview.tsx', 'SmartCleanupWorkspace.tsx', 'VerificationSection.tsx', 'UpgradeAnalysisCards.tsx']) {
    const source = readFileSync(new URL(`../webview/src/components/${file}`, import.meta.url), 'utf8');
    assert.match(source, /<VerificationSuggestions\b/, file);
  }
});

test('detected scripts sit above the steps list so ticking one never moves the boxes', () => {
  for (const selection of [{ scripts: [], remember: false }, { scripts: ['typecheck', 'build', 'test'], remember: false }]) {
    const markup = render(VerificationStepsCard, { analysisId: 'a1', verification: unconfigured }, selection);
    assert.ok(markup.indexOf('Detected scripts') < markup.indexOf('class="verification-steps"'));
  }
  for (const file of ['RemovalReviewPanel.tsx', 'TransitiveFixReview.tsx']) {
    const source = readFileSync(new URL(`../webview/src/components/${file}`, import.meta.url), 'utf8');
    const suggestions = source.indexOf('<VerificationSuggestions');
    const steps = file === 'RemovalReviewPanel.tsx' ? source.indexOf('className="verification-steps"') : source.indexOf('Security rescan');
    assert.ok(suggestions > 0 && suggestions < steps, file);
  }
});

test('choices lock once they have been sent with a confirm message', () => {
  const markup = render(VerificationStepsCard, { analysisId: 'a1', verification: unconfigured }, { scripts: ['build'], remember: true, locked: true });
  assert.match(markup, /<fieldset class="verification-suggestions" disabled="">/);
  const open = render(VerificationStepsCard, { analysisId: 'a1', verification: unconfigured }, { scripts: ['build'], remember: false });
  assert.doesNotMatch(open, /<fieldset[^>]*disabled/);
});
