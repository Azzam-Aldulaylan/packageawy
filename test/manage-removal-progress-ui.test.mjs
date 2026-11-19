/** Removal from the Manage dialog: running state, result panel, close labels and peer wording. */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { rollbackFixture } from './helpers/optional-reinstall.mjs';
import { manualReinstallNote } from '../out/host/manualReinstallCopy.js';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: [
      'export { ManageDependencyModal, manageFooterNote } from "./webview/src/components/ManageDependencyModal.tsx";',
      'export { RemovalErrorPanel, RemovalResultPanel, RemovalRunningPanel, removalProgressSteps, removalViewFocusTarget } from "./webview/src/components/RemovalProgressPanels.tsx";',
      'export { RemovalReviewPanel } from "./webview/src/components/RemovalReviewPanel.tsx";',
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
      plugin.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
        path: pathToFileURL(require.resolve(args.path)).href,
        external: true,
      }));
    },
  }],
});
const {
  ManageDependencyModal,
  manageFooterNote,
  RemovalErrorPanel,
  RemovalResultPanel,
  RemovalReviewPanel,
  RemovalRunningPanel,
  removalProgressSteps,
  removalViewFocusTarget,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const manageSource = await readFile(join(process.cwd(), 'webview/src/components/ManageDependencyModal.tsx'), 'utf8');
const coordinator = await readFile(join(process.cwd(), 'src/host/upgradeAssistantCoordinator.ts'), 'utf8');

const noop = () => {};
const row = { name: 'left-pad', range: '^1.3.0', current: '1.3.0', advisories: [], worstSeverity: 'none', dev: false, optional: false };
const result = (outcome, verification, rollback = 'not-needed') => ({
  analysisId: 'removal-1',
  packages: ['left-pad'],
  outcome,
  verification,
  rollback,
  message: 'host message',
});

/** Strips tags so assertions read the visible text. */
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function assertPlainCopy(html) {
  const visible = text(html);
  assert.doesNotMatch(visible, /[–—→;]/, `copy has a dash, arrow or semicolon: ${visible}`);
}

test('the running state shows simple loading and announces the phase the host reported', () => {
  const html = renderToStaticMarkup(createElement(RemovalRunningPanel, { row, progress: 'installing' }));
  assert.match(text(html), /Removing left-pad/);
  assert.match(text(html), /Installing…/);
  assert.match(html, /role="status"/);
  assert.match(html, /class="analysis-loading" aria-busy="true"/);
  assert.match(html, /class="sr-only"[^>]*role="status"[^>]*>Installing…/);
  assert.doesNotMatch(html, /verification-steps|status-badge|restore point/);
  assert.match(html, /id="removal-running-heading" tabindex="-1"/);
  assertPlainCopy(html);
});

test('progress steps only advance with reported phases', () => {
  assert.deepEqual(removalProgressSteps(null).map((step) => step.status), ['running', 'waiting', 'waiting', 'waiting']);
  assert.deepEqual(removalProgressSteps('verifying').map((step) => step.status), ['complete', 'complete', 'running', 'waiting']);
  assert.deepEqual(removalProgressSteps('refreshing').map((step) => step.status), ['complete', 'complete', 'complete', 'running']);
});

test('the result panel reports what was removed, install, verification and rollback', () => {
  const html = text(renderToStaticMarkup(createElement(RemovalResultPanel, { row, result: result('verified', 'passed') })));
  assert.match(html, /Removal done/);
  assert.match(html, /left-pad 1\.3\.0 Direct entry removed/);
  assert.match(html, /Install Succeeded/);
  assert.match(html, /Dependency files package\.json and the lockfile updated/);
  assert.match(html, /Verification Passed/);
  assert.match(html, /Rollback Not needed/);
  assert.match(html, /host message/);
});

test('a kept removal without build or test checks says so', () => {
  const html = text(renderToStaticMarkup(createElement(RemovalResultPanel, { row, result: { ...result('verified', 'not-configured'), projectScriptsPresent: false } })));
  assert.match(html, /Removal done/);
  assert.match(html, /Verification No test scripts to run/);
  assert.match(html, /Run your checks before you commit\./);
});

test('a rolled back removal reports the restore and does not claim an install', () => {
  const raw = renderToStaticMarkup(createElement(RemovalResultPanel, { row, result: result('rolled-back', 'not-run', 'succeeded') }));
  const html = text(raw);
  assert.match(html, /Removal rolled back/);
  assert.match(html, /left-pad 1\.3\.0 Restored/);
  assert.match(html, /Install Did not finish/);
  assert.match(html, /Dependency files package\.json and the lockfile restored/);
  assert.match(html, /Rollback Restore point applied/);
  assert.match(html, /host message/);
  assertPlainCopy(raw);
  const afterVerification = text(renderToStaticMarkup(createElement(RemovalResultPanel, {
    row,
    result: result('rolled-back', 'failed', 'succeeded'),
  })));
  assert.match(afterVerification, /Install Succeeded/);
});

function renderManage(props) {
  return renderToStaticMarkup(createElement(ManageDependencyModal, {
    row,
    allRows: [row],
    remediation: undefined,
    removalImpact: { phase: 'idle' },
    usage: undefined,
    hygieneFindings: [],
    activeTab: 'removal',
    onChangeTab: noop,
    actionsDisabled: false,
    upgradeDisabled: false,
    updateResolutionAvailable: true,
    advisoriesAvailable: true,
    blockClose: false,
    upgradeResult: null,
    upgradeEnrichment: null,
    upgrade: {
      targetVersion: null,
      targetState: { phase: 'idle' },
      active: false,
      analyzingPhase: null,
      analysis: null,
      sections: {},
      hardStale: false,
      busy: false,
      error: null,
      onAnalyze: noop,
      onTargetChange: noop,
      onConfirm: noop,
      onUseSmartPlan: noop,
      onCancel: noop,
      onConfigureVerification: noop,
      onRefresh: noop,
    },
    removal: {
      active: false,
      analysis: null,
      busy: false,
      error: null,
      onAnalyze: noop,
      onConfirm: noop,
      onConfigureVerification: noop,
    },
    onAnalyzeRemediation: noop,
    onReviewRemediation: noop,
    onApplyRemediation: noop,
    onCancelRemediation: noop,
    onRetryRemediation: noop,
    onOpenAdvisory: noop,
    onReanalyzeUsage: noop,
    onOpenUsageReference: noop,
    onRetryUpgradeEnrichment: noop,
    now: Date.now(),
    onClose: noop,
    ...props,
  }));
}

test('Manage package tile uses the decorative Packageawy logo', () => {
  const html = renderManage({});
  assert.match(html, /<span class="package-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false"><path fill-rule="evenodd"/);
});

test('Manage shows the running removal instead of Analyze removal and locks Close', () => {
  const html = renderManage({ removalRun: { phase: 'running', progress: 'verifying' }, blockClose: true });
  assert.match(text(html), /Removing left-pad/);
  assert.match(text(html), /Verifying…/);
  assert.doesNotMatch(text(html), /Analyze removal/);
  assert.doesNotMatch(text(html), /Analysis does not modify your project/);
  assert.match(html, /aria-label="Close dialog"[^>]*disabled=""/);
});

test('Manage keeps the removal result with a footer that says what changed', () => {
  const html = text(renderManage({ removalRun: { phase: 'result', result: result('verified', 'passed') } }));
  assert.match(html, /Removal done/);
  assert.match(html, /package\.json and the lockfile updated/);
  assert.equal(
    manageFooterNote(null, { phase: 'result', result: result('rolled-back', 'not-run', 'succeeded') }),
    'Your dependency files were restored.'
  );
  assert.equal(manageFooterNote(null, { phase: 'running', progress: null }), null);
});

test('the two close controls have distinct accessible names', () => {
  const html = renderManage({});
  assert.match(html, /<button[^>]*class="modal__close"[^>]*aria-label="Close dialog"/);
  assert.match(html, /<button type="button" class="button button--secondary">Close<\/button>/);
  assert.equal((html.match(/aria-label="Close"/g) ?? []).length, 0);
  const drilldown = renderManage({ closeLabel: 'Back to Smart Cleanup' });
  assert.match(drilldown, /aria-label="Close dialog"/);
});

test('the host skips its notification only when the dialog shows the result', () => {
  assert.match(coordinator, /if \(!resultInDialog\) this\.options\.platform\.showInformationMessage\(message\);/);
  assert.match(coordinator, /if \(!resultInDialog\) this\.options\.platform\.showWarningMessage\(presentation\.message\);/);
});

function renderReview(assessment) {
  return text(renderToStaticMarkup(createElement(RemovalReviewPanel, {
    row,
    active: true,
    analysis: {
      analysisId: 'removal-1',
      analyzedAt: '2026-08-01T09:00:00.000Z',
      expiresAt: '2026-08-01T11:00:00.000Z',
      package: 'left-pad',
      changes: [{ packageName: 'left-pad', classification: 'prod', stillRequiredBy: [] }],
      files: { manifestPath: '/fixture/package.json', lockfilePath: '/fixture/package-lock.json', rollbackAvailable: true },
      verification: { configured: false, suggestedScriptNames: [] },
    },
    busy: false,
    error: null,
    removalImpact: {
      phase: 'done',
      requestId: 'removal',
      packages: ['left-pad'],
      assessments: assessment === undefined ? new Map() : new Map([['left-pad', { assessment, usageId: 'usage' }]]),
      generatedAt: new Date(0).toISOString(),
    },
    usage: undefined,
    advisoriesAvailable: true,
    now: Date.parse('2026-08-01T09:30:00.000Z'),
    onAnalyzeRemoval: noop,
    onConfirm: noop,
    onViewReferences: noop,
    onConfigureVerification: noop,
  })));
}

test('peer dependencies read from the lockfile even when the usage scan is incomplete', () => {
  const incomplete = renderReview({
    status: 'unknown',
    evidence: [{ kind: 'source-reference', summary: 'Workspace usage analysis was incomplete or cancelled.' }],
  });
  assert.match(incomplete, /Peer dependencies No conflicts in the lockfile/);
  assert.match(renderReview({ status: 'low-risk', evidence: [] }), /Peer dependencies No conflicts in the lockfile/);
  assert.match(renderReview(undefined), /Peer dependencies Not checked/);
});

test('a removal error after the package left shows the failure and rollback outcome', () => {
  const raw = renderToStaticMarkup(createElement(RemovalErrorPanel, {
    row,
    error: { code: 'ROLLBACK_CONFLICT', message: 'Rollback was incomplete because dependency files changed concurrently.' },
  }));
  const html = text(raw);
  assert.match(raw, /role="alert"/);
  assert.match(raw, /id="removal-error-heading"[^>]*tabindex="-1"/);
  assert.match(html, /Removal partly failed/);
  assert.match(html, /Rollback was incomplete because dependency files changed concurrently\./);
  assert.match(html, /Rollback Incomplete, newer edits were kept/);
  assertPlainCopy(raw);
  const manage = text(renderManage({ removalRun: { phase: 'error', error: { code: 'ROLLBACK_FAILED', message: 'Rollback failed.' } } }));
  assert.match(manage, /Removal partly failed/);
  assert.match(manage, /Rollback Failed/);
  assert.match(manage, /\bClose\b/);
});

test('focus moves to the heading of each new removal view', () => {
  assert.equal(removalViewFocusTarget('review', 'running'), 'removal-running-heading');
  assert.equal(removalViewFocusTarget('running', 'result'), 'removal-result-heading');
  assert.equal(removalViewFocusTarget('running', 'error'), 'removal-error-heading');
  assert.equal(removalViewFocusTarget('running', 'running'), null);
  assert.equal(removalViewFocusTarget('result', 'review'), null);
  // A confirmation refused while the package is still listed returns to the review's error.
  assert.equal(removalViewFocusTarget('running', 'review-error'), 'removal-review-error-heading');
  assert.equal(removalViewFocusTarget('review-error', 'review-error'), null);
  const refused = renderManage({
    removal: {
      active: true, analysis: null, busy: false,
      error: { code: 'STALE_SOURCE', message: 'Project files changed before removal could begin. Refresh and try again.' },
      onAnalyze: noop, onConfirm: noop, onConfigureVerification: noop,
    },
  });
  assert.match(refused, /id="removal-review-error-heading" tabindex="-1"/);
  for (const [view, progress] of [['running', { phase: 'running', progress: null }], ['result', { phase: 'result', result: result('verified', 'passed') }]]) {
    assert.match(renderManage({ removalRun: progress }), new RegExp(`id="removal-${view}-heading"[^>]*tabindex="-1"`));
  }
});

test('Manage focuses the new view and handles Escape on the document', () => {
  assert.match(manageSource, /removalViewFocusTarget\(previousRemovalView\.current, removalView\)/);
  assert.match(manageSource, /querySelector<HTMLElement>\(`#\$\{target\}`\)\?\.focus\(\)/);
  assert.match(manageSource, /ownerDocument\.addEventListener\('keydown', onKeyDown\)/);
  assert.match(manageSource, /!isTopmostTrap\(node\)/);
  assert.doesNotMatch(manageSource, /node\.addEventListener\('keydown'/);
});

for (const reinstall of ['succeeded', 'failed', 'skipped']) test(`upgrade result panel follows actual optional reinstall ${reinstall}`, async t => {
  const f = await rollbackFixture(t, 'upgrade');
  f.state.reinstallChoice = reinstall === 'skipped' ? 'Skip' : 'Reinstall';
  f.state.reinstallExitCode = reinstall === 'failed' ? 1 : 0;
  await f.confirm();
  const hostResult = f.messages.findLast(message => message.status === 'upgrade-result')?.result;
  assert.equal(hostResult?.application, 'rolled-back', JSON.stringify(f.messages));
  const raw = renderManage({ activeTab: 'upgrade', upgradeResult: hostResult });
  const html = text(raw);
  const note = reinstall === 'succeeded' ? 'Dependencies were reinstalled using the restored lockfile.' : manualReinstallNote('npm');
  assert.ok(html.includes(note), html);
  if (reinstall === 'succeeded') assert.doesNotMatch(html, /Run your package manager|run npm install|To reinstall by hand|node_modules were not restored/);
  assertPlainCopy(raw);
});

for (const hostKind of ['vscode', 'jetbrains']) for (const operation of ['removal', 'upgrade']) {
  for (const scripts of [{}, { build: 'tsc', test: 'node --test' }, { 'check:custom': 'node check.js', dev: 'vite' }]) {
    test(`${hostKind} ${operation} result snapshots ${Object.keys(scripts).length ? 'existing unselected' : 'absent'} manifest scripts`, async t => {
      const f = await rollbackFixture(t, operation);
      f.coordinator.options.platform.hostKind = hostKind;
      t.after(() => f.coordinator.disposeWhenIdle());
      const manifest = JSON.parse(await readFile(f.project.manifestPath, 'utf8'));
      await writeFile(f.project.manifestPath, JSON.stringify({ ...manifest, scripts }));
      // Capture the same reviewed manifest that real analysis stores.
      if (operation === 'upgrade') {
        f.coordinator.analysis.snapshot = await f.read();
        f.coordinator.options.readAndApplyMutationLocalState = async () => ({ project: await f.read(), structurallyCurrent: true });
        const upgradedLockfile = (await readFile(f.project.lockfilePath, 'utf8')).replace('18.2.0', '18.3.0').replace('^18.0.0', '^18.3.0');
        const runProcess = f.coordinator.options.platform.runProcess;
        f.coordinator.options.platform.runProcess = async request => {
          const running = await runProcess(request);
          if (request.args.includes('install')) await writeFile(f.project.lockfilePath, upgradedLockfile);
          return running;
        };
      } else {
        await f.coordinator.handleAnalyzeBulkRemove({ changes: [{ package: 'react' }] });
      }
      f.state.installExitCode = 0;
      if (operation === 'upgrade') await f.confirm();
      else await f.coordinator.handleConfirmRemove({ analysisId: f.messages.findLast(message => message.status === 'remove-analysis').analysis.analysisId });
      const hostResult = f.messages.findLast(message => message.status === `${operation === 'upgrade' ? 'upgrade' : 'remove'}-result`).result;
      const present = Object.keys(scripts).length > 0;
      if (operation === 'upgrade') assert.equal(hostResult.application, 'applied', JSON.stringify({ hostResult, messages: f.messages }));
      assert.equal(hostResult.verification, 'not-configured');
      assert.equal(hostResult.projectScriptsPresent, present);
      const scriptChecks = hostResult.checks.filter(check => check.kind === 'script');
      assert.ok(scriptChecks.length > 0);
      for (const check of scriptChecks) {
        const exists = Object.hasOwn(scripts, check.scriptName);
        assert.equal(check.status, exists ? 'not-run' : 'no-script');
        assert.equal(check.reason, exists ? 'Not selected.' : `No ${check.scriptName} script in package.json.`);
      }
      assert.deepEqual(f.commands, operation === 'upgrade' ? ['install', 'install'] : ['install'], 'only dependency installs run, including upgrade range reconciliation');
      // Later edits do not change the reviewed script-presence snapshot.
      await writeFile(f.project.manifestPath, JSON.stringify({ ...manifest, scripts: present ? {} : { test: 'node --test' } }));
      const html = text(renderManage(operation === 'upgrade'
        ? { activeTab: 'upgrade', upgradeResult: hostResult }
        : { removalRun: { phase: 'result', result: hostResult } }));
      assert.match(html, present ? /Verification No checks selected/ : /Verification No test scripts to run/);
      assert.doesNotMatch(html, present ? /No test scripts to run/ : /No checks selected/);
    });
  }
}
for (const operation of ['removal', 'upgrade']) test(`${operation} result does not claim scripts are absent without a host snapshot`, () => {
  const html = text(renderManage(operation === 'upgrade' ? { activeTab: 'upgrade', upgradeResult: {
    install: 'succeeded', application: 'applied', verification: 'not-configured', changes: [],
  } } : { removalRun: { phase: 'result', result: result('verified', 'not-configured') } }));
  assert.match(html, /Verification No checks selected/);
  assert.doesNotMatch(html, /No test scripts to run/);
});
