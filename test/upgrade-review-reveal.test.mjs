import assert from 'node:assert/strict';
import test from 'node:test';
import { join, win32 } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { appHarness } from './helpers/app-harness.mjs';
import { buildUpgradeAnalysisPresentation } from '../out/host/upgradeAnalysisPresentation.js';
import { isHostToWebviewMessage } from '../out/host/webviewProtocol.js';
import { WAITING_UPGRADE_ANALYSIS_SECTIONS, applyPartialSection } from '../out/host/upgradeAnalysisSections.js';
import { upgradeReviewHasIncompleteChecks } from '../out/host/upgradeReviewUiState.js';
import { majorUpdateSummary } from '../out/host/findingCopy.js';
import { analyzeCompatibility } from '../out/core/compatibility/preflight.js';
import { buildDependencyGraph } from '../out/core/lockfile/build.js';
import { parseManifest } from '../out/core/manifest/parse.js';
import { dependencyWarningCount } from '../out/host/upgradeReviewDecision.js';
import { UpgradeAssistantCoordinator } from '../out/host/upgradeAssistantCoordinator.js';
import { ProjectMutationLocks, canonicalProjectRoot } from '../out/host/projectMutationLock.js';
import { resolvedTarget } from './helpers/mutation-target.mjs';
import { blocker } from './helpers/removal-project.mjs';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `
  export { ManageDependencyModal } from './webview/src/components/ManageDependencyModal.tsx';
  export { CompatibilityCheckCard } from './webview/src/components/UpgradeAnalysisCards.tsx';
  export { DependencyChangeContext } from './webview/src/components/DependencyChangeStatus.tsx';
  export { RemoveAnalysisModal } from './webview/src/components/RemoveAnalysisModal.tsx';
  export { TransitiveFixReview } from './webview/src/components/TransitiveFixReview.tsx';
  export { UpgradeReviewPanel } from './webview/src/components/UpgradeReviewPanel.tsx';
  export { UpgradeAnalysisModal } from './webview/src/components/UpgradeAnalysisModal.tsx';
  export { UpgradeReviewAnnouncement } from './webview/src/components/UpgradeAnalysisLoading.tsx';
  export { VerificationOptInContext } from './webview/src/components/VerificationSuggestions.tsx';
  export { buildUpgradeReviewSignals } from './webview/src/components/UpgradeAnalysisSections.tsx';
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { ManageDependencyModal, CompatibilityCheckCard, DependencyChangeContext, RemoveAnalysisModal, TransitiveFixReview, UpgradeReviewPanel, UpgradeAnalysisModal, UpgradeReviewAnnouncement, VerificationOptInContext, buildUpgradeReviewSignals } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const now = Date.now();
const noop = () => {};
const row = { name: 'alpha', current: '6.2.0', range: '^6.2.0', wanted: '6.3.0', latest: '7.1.0', dev: false, optional: false,
  upgradeTo: '7.1.0', upgradeReason: 'update', advisories: [], worstSeverity: null };
const major = { id: 'major-alpha', kind: 'major-version-change', status: 'warning', source: 'static',
  subject: { name: 'alpha', version: '7.1.0', nodeId: null }, relation: { kind: 'direct', nodeIds: [], packageNames: ['alpha'] }, explanation: 'A major change.' };
function analysis(overrides = {}) {
  return buildUpgradeAnalysisPresentation({ analysisId: 'review-1', analyzedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo, classification: 'prod',
    compatibility: { status: 'warning', completeness: 'complete', findings: [major] },
    projectCompatibility: { identity: { packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo, requestId: 'project-request', sourceFingerprint: 'fingerprint' },
      analyzers: ['runtime-compatibility', 'import-compatibility'].map(analyzerId => ({ analyzerId, status: 'complete', findings: [] })), findings: [],
      startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString() },
    security: { status: 'not-applicable', checkState: 'complete', resolvedAdvisories: [], remaining: [] }, smartPlan: null, verificationScriptNames: [],
    manifestPath: join('fixture', 'package.json'), lockfilePath: join('fixture', 'package-lock.json'), ...overrides });
}
const common = { packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo, busy: false, hardStale: false, now,
  onConfirm: noop, onUseSmartPlan: noop, onCancel: noop, onRefresh: noop, onOpenAdvisory: noop, onConfigureVerification: noop };
const panelProps = { ...common, row, active: true, targetState: { phase: 'idle' }, error: null, disabled: false,
  advisoriesAvailable: true, onAnalyzeUpgrade: noop, onTargetChange: noop, onChangeTab: noop };
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
function partials(value) {
  const { currentVersion, targetVersion, classification, majorUpdate, changes, verification, files, compatibility, projectCompatibility, security, smartPlan } = value;
  return [{ kind: 'overview', currentVersion, targetVersion, classification, majorUpdate, changes, verification, files },
    { kind: 'compatibility', compatibility }, { kind: 'project-compatibility', projectCompatibility }, { kind: 'security', security }, { kind: 'smart-plan', smartPlan }];
}

for (const [name, Component, props] of [['single', UpgradeReviewPanel, panelProps], ['bulk', UpgradeAnalysisModal, common]]) {
  test(`${name} review preserves identity and disabled shortcuts through every partial, then reveals together`, () => {
    const value = analysis();
    let sections = WAITING_UPGRADE_ANALYSIS_SECTIONS;
    for (const section of [null, ...partials(value)]) {
      if (section) sections = applyPartialSection(sections, section);
      const html = render(Component, { ...props, analysis: null, sections });
      assert.match(html, />Upgrade alpha</);
      assert.match(html, /<code>6\.2\.0<\/code>[\s\S]*<code>7\.1\.0<\/code>/);
      assert.match(html, /aria-busy="true"/);
      assert.equal((html.match(/<div class="upgrade-section-skeleton">/g) ?? []).length, 5);
      assert.equal((html.match(/<button[^>]*disabled=""[^>]*aria-label="[^"]+\. View details"/g) ?? []).length, 4);
      assert.match(html, /Checking compatibility, security and project files/);
      assert.doesNotMatch(html, /Major update: 6 to 7|A major change|No conflicts found|No issues were found/);
      assert.match(html, /<button[^>]*>Cancel<\/button>/);
    }
    const html = render(Component, { ...props, analysis: value, sections });
    assert.doesNotMatch(html, /upgrade-section-skeleton|upgrade-summary-skeleton|aria-busy="true"/);
    assert.match(html, /upgrade-major-notice[\s\S]*<svg[\s\S]*Major update: 6 to 7\. May include breaking changes\./);
    assert.match(html, /Warning · 1 finding/);
    assert.equal((html.match(/role="status"/g) ?? []).length, 1);
    assert.match(html, /Upgrade review ready\./);
  });

  test(`${name} fatal error replaces placeholders with Retry and keeps Cancel`, () => {
    const html = render(Component, { ...props, analysis: null, sections: WAITING_UPGRADE_ANALYSIS_SECTIONS, error: 'Registry is unavailable.' });
    assert.match(html, /Registry is unavailable\./);
    assert.match(html, />Retry</);
    assert.match(html, />Cancel</);
    assert.doesNotMatch(html, /upgrade-section-skeleton|upgrade-summary-skeleton|aria-busy="true"/);
  });

  test(`${name} final partial coverage is settled, visible and honest`, () => {
    const value = analysis({ compatibility: { status: 'unknown', completeness: 'partial', findings: [] }, security: null });
    const html = render(Component, { ...props, analysis: value });
    assert.doesNotMatch(html, /upgrade-section-skeleton/);
    assert.match(html, /Some checks could not complete\./);
    assert.match(html, /Checks incomplete/);
    assert.match(html, /Security check unavailable/);
    assert.doesNotMatch(html, /No issues were found\./);
  });
}

test('coverage handles missing analyzers, resolver uncertainty, security unknown and intentional Off independently', () => {
  const complete = analysis();
  assert.equal(upgradeReviewHasIncompleteChecks(complete), false);
  for (const value of [
    { ...complete, projectCompatibility: { ...complete.projectCompatibility, analyzers: [] } },
    { ...complete, projectCompatibility: { ...complete.projectCompatibility, analyzers: complete.projectCompatibility.analyzers.slice(0, 1) } },
    { ...complete, security: null },
    { ...complete, security: { ...complete.security, status: 'unknown' } },
    { ...complete, compatibility: { ...complete.compatibility, resolverVerification: { status: 'unknown' } } },
  ]) assert.equal(upgradeReviewHasIncompleteChecks(value), true);
  assert.equal(upgradeReviewHasIncompleteChecks({ ...complete, security: null }, true), false);
  assert.equal(upgradeReviewHasIncompleteChecks({ ...complete, security: { ...complete.security, checkState: 'off' } }), false);
  const html = render(UpgradeReviewPanel, { ...panelProps, analysis: { ...complete, security: { ...complete.security, status: 'unknown' } } });
  assert.match(html, /aria-label="Security impact: Security outcome unknown\. View details"/);
  assert.match(html, /<p class="security-outcome__value">Undetermined<\/p>/);
  assert.doesNotMatch(html, /security-outcome__value--good/);
  const security = { ...complete.security, status: 'unknown', introduced: [{ advisory: { id: 'known', title: 'Known issue', severity: 'high' }, flaggedPackage: row.name, path: [row.name] }] };
  const mixed = render(UpgradeReviewPanel, { ...panelProps, analysis: { ...complete, security } });
  assert.match(mixed, /Security impact: 1 introduced, Security outcome unknown/);
});

test('completion announcement is empty while waiting and has one atomic completion message', () => {
  assert.doesNotMatch(render(UpgradeReviewAnnouncement, { analysis: null }), /Upgrade review ready/);
  const html = render(UpgradeReviewAnnouncement, { analysis: analysis({ security: null }) });
  assert.match(html, /aria-live="polite" aria-atomic="true"/);
  assert.equal((html.match(/Upgrade review ready/g) ?? []).length, 1);
});

test('major copy uses real majors, supports prereleases and never invents an unavailable current version', () => {
  assert.equal(majorUpdateSummary(major, { package: 'alpha', currentVersion: '6.2.0' }), 'Major update: 6 to 7. May include breaking changes.');
  assert.match(majorUpdateSummary({ ...major, subject: { ...major.subject, version: '8.0.0-beta.1' } }, { package: 'alpha', currentVersion: '0.1.0' }), /0 to 8/);
  assert.equal(majorUpdateSummary(major, { package: 'other', currentVersion: '99.0.0' }), 'Major update. May include breaking changes.');
  assert.doesNotMatch(majorUpdateSummary(major, { package: 'alpha', currentVersion: 'unknown' }), /unknown to|undefined|null/);
});

for (const makePath of [join, win32.join]) test(`summary handles ${makePath === join ? 'native' : 'Windows'} file paths`, () => {
  const html = render(UpgradeReviewPanel, { ...panelProps, analysis: analysis({ manifestPath: makePath('fixture', 'package.json'), lockfilePath: makePath('fixture', 'package-lock.json') }) });
  assert.match(html, /Will update <code>package\.json<\/code> and <code>package-lock\.json<\/code>/);
  assert.doesNotMatch(html, /fixture[\\/]/);
});

test('major summary keeps all other warnings and reports coordinated package versions correctly', () => {
  const other = { ...major, id: 'major-other', subject: { ...major.subject, name: 'other', version: '12.0.0' } };
  const value = analysis({ compatibility: { status: 'warning', completeness: 'complete', findings: [major, other] },
    smartPlan: { changes: [{ packageName: 'other', currentVersion: '10.4.0', targetVersion: '12.0.0', classification: 'prod' }], reasonFindingIds: [] } });
  const html = render(UpgradeReviewPanel, { ...panelProps, analysis: value });
  assert.match(html, /Major update: 6 to 7/);
  assert.match(html, /Major update: 10 to 12/);
  assert.match(html, /2 dependency compatibility warnings/);
});

function reviewArea(document, name, area) {
  if (name === 'bulk') return document.querySelector(`[data-review-area="${area}"]`);
  const labels = { dependency: 'Dependency compatibility', project: 'Project compatibility', verification: 'Verification' };
  const disclosure = [...document.querySelectorAll('.upgrade-review-disclosure')].find(section =>
    section.querySelector('.upgrade-review-disclosure__label')?.textContent === labels[area]);
  disclosure.open = true;
  return disclosure.querySelector('.upgrade-review-disclosure__body');
}

function visibleInArea(node, area) {
  for (let current = node; current && current !== area; current = current.parentElement) {
    if (current.hidden || (current.tagName === 'DETAILS' && !current.open)) return false;
  }
  return true;
}

for (const makePath of [join, win32.join]) test(`chalk fixture reproduces only a major warning with ${makePath === join ? 'native' : 'Windows'} paths`, async () => {
  const directory = join(process.cwd(), 'test', 'fixtures', 'chalk-upgrade');
  const [manifestText, lockfileText, metadata, resolver] = await Promise.all([
    readFile(join(directory, 'package.json'), 'utf8'), readFile(join(directory, 'package-lock.json'), 'utf8'),
    readFile(join(directory, 'target-metadata.json'), 'utf8').then(JSON.parse),
    readFile(join(directory, 'resolver-verification.json'), 'utf8').then(JSON.parse),
  ]);
  const root = makePath('fixture', 'chalk-upgrade');
  const requested = { packageName: 'chalk', currentVersion: '4.1.2', targetVersion: metadata.version, classification: 'prod' };
  const result = await analyzeCompatibility({
    graph: buildDependencyGraph({ root, manifest: parseManifest(manifestText), lockfileText, packageManager: 'npm' }),
    proposal: { requested, changes: [requested] }, policy: { strictPeerDeps: false, legacyPeerDeps: false },
    metadataProvider: { async getPackageVersionMetadata(name, version) {
      assert.equal(name, metadata.name); assert.equal(version, metadata.version); return metadata;
    } }, resolverVerifier: { async verify() { return resolver; } },
  });
  assert.equal(result.status, 'warning');
  assert.equal(result.completeness, 'complete');
  assert.equal(result.resolverVerification.status, 'compatible');
  assert.deepEqual(result.findings.map(finding => [finding.id, finding.kind, finding.status]), [
    ['["major-version-change","chalk","4.1.2","6.0.1"]', 'major-version-change', 'warning'],
  ]);
  const value = analysis({ packageName: 'chalk', currentVersion: '4.1.2', targetVersion: metadata.version, compatibility: result,
    manifestPath: makePath(root, 'package.json'), lockfilePath: makePath(root, 'package-lock.json') });
  const document = new JSDOM(render(UpgradeReviewPanel, { ...panelProps,
    row: { ...row, name: 'chalk', current: '4.1.2', upgradeTo: metadata.version }, targetVersion: metadata.version, analysis: value }));
  try {
    const area = reviewArea(document.window.document, 'single', 'dependency');
    const warning = area.querySelector('.outcome-status--warning');
    assert.match(warning.textContent, /Warning: Major update/);
    assert.match(warning.textContent, /Major update: 4 to 6\. May include breaking changes\./);
    assert.match(warning.textContent, /Review the release notes and check your imports, Node\.js version and tests before upgrading\./);
    assert.ok(warning.querySelector('svg'));
    assert.ok(visibleInArea(warning, area));
    assert.ok(warning.compareDocumentPosition(area.querySelector('.hygiene-strip')) & 4, 'warning leads the tiles');
    assert.ok(warning.compareDocumentPosition(area.querySelector('.outcome-status--compatible')) & 4, 'warning leads resolver success');
    assert.match(document.window.document.body.textContent, /Warning · 1 finding/);
    assert.match(document.window.document.body.textContent, /Will update package\.json and package-lock\.json/);
  } finally { document.window.close(); }
});

for (const [name, Component, props] of [['single', UpgradeReviewPanel, panelProps], ['bulk', UpgradeAnalysisModal, common]]) {
  test(`${name} every warning signal has visible warning evidence without another disclosure or Show more`, () => {
    const peer = { ...major, id: 'peer', kind: 'peer-incompatible', requirement: { name: 'companion', range: '^2', optional: false }, observedVersion: '1.0.0' };
    const unknown = { ...major, id: 'unknown', kind: 'metadata-unavailable', status: 'unknown' };
    const warningResolver = { status: 'warning', packageManager: 'npm', packageManagerVersion: '10', code: 'WARN', explanation: 'A companion version needs review.' };
    const projectFinding = confidence => ({ id: `project-${confidence}`, analyzerId: 'import-compatibility', confidence, category: 'import',
      title: `${confidence} import change`, explanation: 'The imported entry may have changed.', migrationHint: 'Check the target exports.', evidence: [] });
    const cases = [
      analysis(),
      analysis({ compatibility: { status: 'warning', completeness: 'complete', findings: [], resolverVerification: warningResolver } }),
      analysis({ compatibility: { status: 'warning', completeness: 'complete', findings: [] } }),
      analysis({ compatibility: { status: 'warning', completeness: 'partial', findings: [unknown, peer, ...Array.from({ length: 5 }, (_, i) => ({ ...major, id: `major-${i}` }))], resolverVerification: warningResolver } }),
      ...['confirmed', 'likely', 'review'].map(confidence => {
        const value = analysis();
        value.projectCompatibility = { ...value.projectCompatibility, findings: [projectFinding(confidence)] };
        return value;
      }),
    ];
    const checked = new Set();
    for (const value of cases) {
      const document = new JSDOM(render(Component, { ...props, analysis: value }));
      try {
        for (const signal of buildUpgradeReviewSignals(value, true).filter(signal => signal.tone === 'warning')) {
          checked.add(signal.area);
          const shortcut = [...document.window.document.querySelectorAll('.upgrade-decision__signal--warning button')]
            .find(button => button.getAttribute('aria-label') === `${signal.label}: ${signal.value}. View details`);
          assert.ok(shortcut, `${signal.area}: summary exposes the same warning`);
          const area = reviewArea(document.window.document, name, signal.area);
          const items = [...area.querySelectorAll('.outcome-status--warning, .project-compat__finding, .verification-steps__item:has(.status-badge--warning)')];
          assert.ok(items.some(item => visibleInArea(item, area) && item.querySelector('svg') && item.textContent.trim().length > 0), `${signal.area}: visible icon and text explain warning`);
          const findings = signal.area === 'dependency' ? value.compatibility.findings.filter(finding => finding.status === 'warning')
            : signal.area === 'project' ? value.projectCompatibility.findings : [];
          for (const finding of findings) {
            const item = [...area.querySelectorAll('[data-finding-id]')].find(item => item.dataset.findingId === finding.id);
            assert.ok(item && visibleInArea(item, area), `${signal.area}: ${finding.id} is visible without another action`);
          }
          if (signal.area === 'dependency' && value.compatibility.resolverVerification?.status === 'warning') {
            assert.ok(items.some(item => item.textContent.includes(warningResolver.explanation) && visibleInArea(item, area)), 'resolver-only warning has visible explanation');
          }
        }
      } finally { document.window.close(); }
    }
    assert.deepEqual([...checked].sort(), ['dependency', 'project', 'verification'], 'covers every signal area that can warn');
  });
}

test('dependency warning count includes resolver warnings and excludes incomplete checks', () => {
  assert.equal(dependencyWarningCount({ findings: [major, { ...major, status: 'unknown' }], resolverVerification: { status: 'warning' } }), 2);
  assert.equal(dependencyWarningCount({ findings: [], resolverVerification: { status: 'compatible' } }), 0);
});

const snapshot = () => ({ status: 'ready', data: { rows: [row], generatedAt: 'snapshot',
  project: { id: 'fixture', label: 'fixture', manifestPath: join('fixture', 'package.json') }, canChangeProject: false,
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] }, hygieneFindings: [], extensionVersion: 'test', builtAt: 'test' } });
function start(view, bulk) {
  view.event(snapshot());
  if (bulk) {
    view.find('Dashboard').props.onOpenBulkActions(); view.render();
    view.find('ManageDependenciesModal').props.onBulkUpgrade([{ packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo, major: true }]);
  } else {
    view.find('Dashboard').props.onOpenManage(row.name); view.render();
    view.find('ManageDependencyModal').props.upgrade.onAnalyze(row.upgradeTo);
  }
  view.render();
  return view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
}
const reviewProps = (view, bulk) => bulk ? view.find('UpgradeAnalysisModal')?.props : view.find('ManageDependencyModal')?.props.upgrade;
for (const bulk of [false, true]) test(`${bulk ? 'bulk' : 'single'} App waits for final, ignores stale messages, retries fatal error and cancels safely`, t => {
  const view = appHarness(t);
  const requestId = start(view, bulk);
  const value = analysis();
  value.projectCompatibility.identity.requestId = requestId;
  for (const section of partials(value)) assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis-partial', requestId, package: row.name, section }), true, JSON.stringify(section));
  assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis', requestId, analysis: value }), true, JSON.stringify(value));
  for (const section of partials(value)) {
    view.event({ status: 'upgrade-analysis-partial', requestId, package: row.name, section });
    assert.equal(reviewProps(view, bulk).analysis, null);
  }
  view.event({ status: 'upgrade-error', requestId, package: row.name, error: { code: 'NETWORK', message: 'Registry is unavailable.' } });
  assert.equal(reviewProps(view, bulk).error, 'Registry is unavailable.');
  view.event({ status: 'upgrade-analysis', requestId, analysis: value });
  assert.equal(reviewProps(view, bulk).analysis, null, 'late final after error is ignored');
  view.event({ status: 'upgrade-error', requestId, package: row.name, error: { code: 'NETWORK', message: 'Duplicate error' } });
  assert.equal(reviewProps(view, bulk).error, 'Registry is unavailable.');
  reviewProps(view, bulk).onRefresh(); view.render();
  const retry = view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
  assert.notEqual(retry, requestId);
  assert.equal(reviewProps(view, bulk).error, null);
  view.event({ status: 'upgrade-analysis', requestId, analysis: value });
  assert.equal(reviewProps(view, bulk).analysis, null, 'superseded final is ignored');
  value.projectCompatibility.identity.requestId = retry;
  view.event({ status: 'upgrade-analysis', requestId: retry, analysis: value });
  assert.equal(reviewProps(view, bulk).analysis.analysisId, value.analysisId);
  reviewProps(view, bulk).onCancel(); view.render();
  view.event({ status: 'upgrade-analysis', requestId: retry, analysis: value });
  if (bulk) assert.equal(reviewProps(view, bulk), undefined);
  else assert.equal(reviewProps(view, bulk).active, false);
  assert.equal(view.sent.some(message => message.type === 'confirm-upgrade' || message.type === 'use-smart-plan'), false);
});

test('loading uses static themed placeholders with visible focus and high contrast fallbacks', async () => {
  const css = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
  const skeletonStyles = css.slice(css.indexOf('/* Upgrade review stays'));
  assert.doesNotMatch(skeletonStyles, /animation:|transition:/);
  assert.match(skeletonStyles, /--vscode-panel-border/);
  assert.match(skeletonStyles, /--vscode-focusBorder/);
  assert.match(skeletonStyles, /forced-colors: active/);
  const theme = await readFile(join(process.cwd(), 'jetbrains', 'src', 'main', 'kotlin', 'io', 'github', 'azzamaldulaylan', 'packageawy', 'webview', 'ThemeVariables.kt'), 'utf8');
  for (const variable of ['panel-border', 'focusBorder', 'inputValidation-warningBorder', 'inputValidation-warningBackground']) assert.ok(theme.includes(`v["${variable}"]`));
});

for (const bulk of [false, true]) test(`${bulk ? 'bulk' : 'single'} waiting Cancel drops late partials and final results`, t => {
  const view = appHarness(t);
  const requestId = start(view, bulk);
  const value = analysis();
  value.projectCompatibility.identity.requestId = requestId;
  view.event({ status: 'upgrade-analyzing', requestId, package: row.name, phase: 'compatibility' });
  reviewProps(view, bulk).onCancel(); view.render();
  for (const section of partials(value)) view.event({ status: 'upgrade-analysis-partial', requestId, package: row.name, section });
  view.event({ status: 'upgrade-analysis', requestId, analysis: value });
  if (bulk) assert.equal(reviewProps(view, bulk), undefined);
  else assert.equal(reviewProps(view, bulk).active, false);
  assert.equal(view.sent.filter(message => message.type === 'cancel-upgrade').at(-1).analysisId, null);
  assert.equal(view.sent.some(message => message.type === 'confirm-upgrade' || message.type === 'use-smart-plan'), false);
});

for (const bulk of [false, true]) test(`${bulk ? 'bulk' : 'single'} refreshed review handles an immediate fatal reply before rendering`, t => {
  const view = appHarness(t);
  const requestId = start(view, bulk);
  const value = analysis();
  value.projectCompatibility.identity.requestId = requestId;
  view.event({ status: 'upgrade-analysis', requestId, analysis: value });
  reviewProps(view, bulk).onRefresh();
  const retry = view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
  // Deliberately do not render between the user's refresh and the host reply.
  view.event({ status: 'upgrade-error', requestId: retry, package: row.name, error: { code: 'NETWORK', message: 'Immediate refresh failure.' } });
  assert.equal(reviewProps(view, bulk).analysis, null);
  assert.equal(reviewProps(view, bulk).error, 'Immediate refresh failure.');
  assert.ok(bulk || reviewProps(view, bulk).active);
});

// Real coordinators share a project lock while an aborted read drains. No
// package manager or network work starts in this fixture.
function blockedHost(root, locks, postMessage) {
  const gate = blocker();
  const coordinator = new UpgradeAssistantCoordinator({
    platform: { getSetting: (_key, fallback) => fallback },
    sink: { postMessage }, httpClient: {}, etagStore: {},
    ensureController: async () => ({
      root, lastResultRows: () => [], upgradeSource: { mutationTarget: resolvedTarget(root) },
      validateBulkUpgradeRequest: () => ({ ok: true, upgrades: [{ packageName: row.name,
        currentVersion: row.current, target: row.upgradeTo, classification: 'prod' }] }),
    }),
    getSelectedProject: () => ({ id: 'project', dir: '', folder: { id: 'folder', name: 'fixture', path: root } }),
    mutationRoot: () => root, mutationLocks: locks, isDisposed: () => false,
    reloadFinalState: async () => {}, flushDeferredChanges: async () => {},
    loadProject: async () => { await gate.wait(); throw new Error('Read failed.'); },
  });
  return { coordinator, gate };
}

for (const windows of [false, true]) for (const bulk of [false, true]) test(`${bulk ? 'bulk' : 'single'} active contention is terminal and Retry cannot release another window's lock (${windows ? 'Windows' : 'native'} path)`, async t => {
  const view = appHarness(t);
  const requestId = start(view, bulk);
  const locks = new ProjectMutationLocks();
  const root = windows ? win32.join('C:\\', 'fixture', randomUUID()) : join(tmpdir(), `packageawy-contention-${randomUUID()}`);
  const foreign = blockedHost(root, locks, () => {});
  const local = blockedHost(root, locks, message => view.event(message));
  const running = foreign.coordinator.handleAnalyzeUpgrade({ requestId: 'foreign', package: row.name, target: row.upgradeTo });
  await foreign.gate.arrived;
  t.after(async () => { foreign.gate.release(); await running; });
  const key = canonicalProjectRoot(root);
  const owner = locks.holderOf(key);
  const reject = id => local.coordinator.handleAnalyzeUpgrade({ requestId: id, package: row.name, target: row.upgradeTo });
  await reject(requestId);
  assert.match(reviewProps(view, bulk).error, /already in progress/);
  assert.equal(reviewProps(view, bulk).analysis, null);
  assert.match(render(bulk ? UpgradeAnalysisModal : UpgradeReviewPanel,
    { ...(bulk ? common : panelProps), ...reviewProps(view, bulk) }), />Retry</);
  assert.equal(locks.holderOf(key), owner);
  reviewProps(view, bulk).onRefresh(); view.render();
  await local.coordinator.handleCancelUpgrade(view.sent.filter(message => message.type === 'cancel-upgrade').at(-1));
  const retry = view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
  assert.notEqual(retry, requestId);
  await reject(retry);
  assert.match(reviewProps(view, bulk).error, /already in progress/);
  assert.equal(locks.holderOf(key), owner, 'a rejected window never owns or releases the reservation');
  foreign.gate.release(); await running;
  assert.equal(locks.holderOf(key), undefined);
  reviewProps(view, bulk).onRefresh(); view.render();
  const accepted = view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
  local.gate.release();
  await reject(accepted);
  assert.equal(reviewProps(view, bulk).error, 'Read failed.', 'retry reaches analysis after the foreign lock clears');
});

for (const windows of [false, true]) for (const bulk of [false, true]) test(`${bulk ? 'bulk' : 'single'} Retry during cancelled analysis cleanup settles and ignores late outcomes (${windows ? 'Windows' : 'native'} path)`, async t => {
  const view = appHarness(t);
  const requestId = start(view, bulk);
  const locks = new ProjectMutationLocks();
  const root = windows ? win32.join('C:\\', 'fixture', randomUUID()) : join(tmpdir(), `packageawy-draining-${randomUUID()}`);
  const host = blockedHost(root, locks, message => view.event(message));
  const running = host.coordinator.handleAnalyzeUpgrade({ requestId, package: row.name, target: row.upgradeTo });
  await host.gate.arrived;
  t.after(async () => { host.gate.release(); await running; });
  const key = canonicalProjectRoot(root);
  const owner = locks.holderOf(key);
  // The user refreshes while the prior analysis still has asynchronous work.
  reviewProps(view, bulk).onRefresh(); view.render();
  await host.coordinator.handleCancelUpgrade(view.sent.filter(message => message.type === 'cancel-upgrade').at(-1));
  const retry = view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
  await host.coordinator.handleAnalyzeUpgrade({ requestId: retry, package: row.name, target: row.upgradeTo });
  const error = reviewProps(view, bulk).error;
  assert.match(error, /already in progress/);
  assert.equal(locks.holderOf(key), owner, 'cancel retains the reservation until the read drains');
  host.gate.release(); await running;
  assert.equal(locks.holderOf(key), undefined);
  const value = analysis();
  value.projectCompatibility.identity.requestId = requestId;
  view.event({ status: 'upgrade-analysis', requestId, analysis: value });
  view.event({ status: 'upgrade-error', requestId, package: row.name, error: { code: 'CANCELLED', message: 'Cancelled.' } });
  assert.equal(reviewProps(view, bulk).error, error);
  assert.equal(reviewProps(view, bulk).analysis, null);
});

for (const bulk of [false, true]) test(`${bulk ? 'bulk' : 'single'} duplicate contention leaves the tracked request and its final result intact`, t => {
  const view = appHarness(t);
  const requestId = start(view, bulk);
  for (const duplicate of [{ requestId: 'untracked' }, {}]) {
    view.event({ status: 'upgrade-error', ...duplicate, package: row.name,
      error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' } });
    assert.equal(reviewProps(view, bulk).error, null);
  }
  const value = analysis();
  value.projectCompatibility.identity.requestId = requestId;
  view.event({ status: 'upgrade-analysis', requestId, analysis: value });
  assert.equal(reviewProps(view, bulk).analysis.analysisId, 'review-1');
});

for (const windows of [false, true]) for (const bulk of [false, true]) for (const coordinated of [false, true]) {
  test(`${bulk ? 'bulk' : 'single'} ${coordinated ? 'coordinated' : 'plain'} confirmation contention unlocks review controls without releasing another window's lock (${windows ? 'Windows' : 'native'} path)`, async t => {
    const view = appHarness(t);
    const dom = await reviewDom(t);
    const requestId = start(view, bulk);
    const makePath = windows ? win32.join : join;
    const value = analysis({
      manifestPath: makePath('fixture', 'package.json'), lockfilePath: makePath('fixture', 'package-lock.json'),
      compatibility: { status: coordinated ? 'conflict' : 'warning', completeness: 'complete', findings: [major] },
      smartPlan: coordinated ? { changes: [
        { packageName: row.name, currentVersion: row.current, targetVersion: row.upgradeTo },
        { packageName: 'beta', currentVersion: '1.0.0', targetVersion: '2.0.0' },
      ], reasonFindingIds: [] } : null,
    });
    value.verification = { configured: false, suggestedScriptNames: ['build', 'test'] };
    value.projectCompatibility.identity.requestId = requestId;
    assert.equal(isHostToWebviewMessage({ status: 'upgrade-analysis', requestId, analysis: value }), true);
    view.event({ status: 'upgrade-analysis', requestId, analysis: value });
    const renderReview = async () => {
      const store = view.elements().find(element => typeof element.props?.value?.selectionFor === 'function').props.value;
      await dom.render(createElement(VerificationOptInContext.Provider, { value: store },
        createElement(bulk ? UpgradeAnalysisModal : UpgradeReviewPanel, { ...(bulk ? common : panelProps), ...reviewProps(view, bulk) })));
    };
    await renderReview();
    const evidenceSelector = bulk ? '[data-review-area]' : '.upgrade-review-disclosure';
    let evidence = [...dom.container.querySelectorAll(evidenceSelector)];
    assert.equal(evidence.length, bulk ? 4 : 5);
    let script = dom.container.querySelector('.verification-suggestions input');
    await act(() => script.click());
    view.render(); await renderReview();
    assert.equal(script.checked, true);
    const signalValues = [...dom.container.querySelectorAll('.upgrade-decision__signal-value')].map(node => node.textContent);

    // Another window acquires the released read-only reservation after our
    // final result arrives, before either confirmation action is clicked.
    const locks = new ProjectMutationLocks();
    const root = windows ? win32.join('C:\\', 'fixture', randomUUID()) : join(tmpdir(), `packageawy-confirm-contention-${randomUUID()}`);
    const foreign = blockedHost(root, locks, () => {});
    const replies = [];
    const local = blockedHost(root, locks, message => { replies.push(message); view.event(message); });
    const stored = { id: value.analysisId, expiresAt: Date.now() + 60_000, security: null,
      eligibility: { packageName: row.name }, compatibilityStatus: value.compatibility.status,
      smartPlanProposal: coordinated ? { changes: [] } : null, proposal: { changes: [] } };
    local.coordinator.analysis = stored;
    const running = foreign.coordinator.handleAnalyzeUpgrade({ requestId: 'foreign', package: row.name, target: row.upgradeTo });
    await foreign.gate.arrived;
    t.after(async () => { foreign.gate.release(); await running; });
    const key = canonicalProjectRoot(root);
    const owner = locks.holderOf(key);
    const action = coordinated ? 'onUseSmartPlan' : 'onConfirm';
    const messageType = coordinated ? 'use-smart-plan' : 'confirm-upgrade';
    const method = coordinated ? 'handleUseSmartPlan' : 'handleConfirmUpgrade';
    reviewProps(view, bulk)[action](); view.render();
    assert.equal(reviewProps(view, bulk).busy, true);
    await renderReview();
    assert.equal(dom.document.activeElement.id, 'change-running-heading');
    assert.equal(dom.container.querySelector(evidenceSelector), null, 'busy loading replaces the evidence');
    if (!bulk) assert.equal(view.find('ManageDependencyModal').props.blockClose, true);

    for (const untracked of [{ analysisId: 'old-analysis' }, { requestId: 'duplicate' }, {}]) {
      view.event({ status: 'upgrade-error', ...untracked, package: row.name,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Unrelated contention.' } });
      assert.equal(reviewProps(view, bulk).busy, true, 'untracked duplicates cannot settle this confirmation');
      assert.equal(reviewProps(view, bulk).error, null);
    }

    // The real host replies with analysisId alone. Retry confirmation itself
    // as well as the explicit Retry action, while the foreign lock is held.
    for (let attempt = 0; attempt < 2; attempt++) {
      const confirm = view.sent.filter(message => message.type === messageType).at(-1);
      assert.equal(confirm.analysisId, value.analysisId);
      await local.coordinator[method](confirm);
      assert.equal(replies.at(-1).error.code, 'UPGRADE_IN_PROGRESS');
      assert.equal(replies.at(-1).analysisId, value.analysisId);
      assert.equal(replies.at(-1).requestId, undefined);
      const props = reviewProps(view, bulk);
      assert.equal(props.busy, false);
      assert.equal(props.analysis.analysisId, value.analysisId, 'the completed review remains available');
      assert.match(props.error, /already in progress/);
      await renderReview();
      assert.equal(dom.container.querySelector('.analysis-loading'), null);
      const retry = dom.container.querySelector('.upgrade-review__error button');
      assert.equal(retry.textContent.trim(), 'Retry');
      assert.equal(retry.disabled, false);
      assert.ok(dom.document.activeElement === retry, 'rejection moves focus from the removed loader to Retry');
      evidence = [...dom.container.querySelectorAll(evidenceSelector)];
      assert.equal(evidence.length, bulk ? 4 : 5, 'every evidence section returns');
      script = dom.container.querySelector('.verification-suggestions input');
      assert.equal(script.checked, true, 'the selected script survives contention');
      assert.equal(script.closest('fieldset').disabled, true, 'script choices still match the submitted confirmation');
      assert.match(dom.container.querySelector('.upgrade-major-notice').textContent, /Major update: 6 to 7/);
      assert.ok(dom.container.querySelector('.upgrade-decision__reason'), 'the completed conclusions remain visible');
      assert.deepEqual([...dom.container.querySelectorAll('.upgrade-decision__signal-value')].map(node => node.textContent), signalValues,
        'confirmation contention does not relabel completed checks as unchecked');
      const shortcuts = [...dom.container.querySelectorAll('.upgrade-decision__signals button')];
      assert.equal(shortcuts.length, 4);
      for (const [index, shortcut] of shortcuts.entries()) {
        const destination = evidence[bulk || index < 3 ? index : 4];
        let scrolled = false;
        destination.scrollIntoView = () => { scrolled = true; };
        assert.equal(shortcut.disabled, false);
        await act(() => shortcut.click());
        assert.equal(scrolled, true, `${shortcut.ariaLabel} scrolls to its mounted evidence`);
        if (bulk) assert.equal(dom.document.activeElement, destination);
        else {
          assert.equal(destination.open, true);
          assert.equal(dom.document.activeElement, destination.querySelector('summary'));
        }
      }
      if (!bulk) {
        const manage = view.find('ManageDependencyModal').props;
        assert.equal(manage.blockClose, false, 'Close and Escape become available again');
        assert.equal(manage.upgradeDisabled, false);
      }
      const html = render(bulk ? UpgradeAnalysisModal : UpgradeReviewPanel, { ...(bulk ? common : panelProps), ...props });
      assert.match(html, /Another dependency change is already in progress for this project\./);
      const rendered = new JSDOM(html);
      try {
        const buttons = [...rendered.window.document.querySelectorAll('button')];
        for (const label of ['Retry', bulk ? 'Cancel' : 'Close review', coordinated ? 'Use coordinated upgrade' : `Upgrade to ${row.upgradeTo}`]) {
          const button = buttons.find(candidate => candidate.textContent.trim() === label);
          assert.ok(button, `${label} is available`);
          assert.equal(button.disabled, false, `${label} is enabled`);
        }
        if (bulk) assert.equal(rendered.window.document.querySelector('[aria-label="Cancel upgrade"]').disabled, false);
      } finally { rendered.window.close(); }
      assert.doesNotMatch(html, /upgrade-section-skeleton/);
      assert.equal(local.coordinator.analysis, stored, 'contention does not consume the host review');
      assert.equal(locks.holderOf(key), owner);
      assert.equal(view.sent.some(message => message.type === 'cancel-upgrade'), false);
      if (attempt === 0) {
        props[action](); view.render();
        assert.equal(reviewProps(view, bulk).busy, true);
        await renderReview();
        assert.equal(dom.document.activeElement.id, 'change-running-heading');
      }
    }

    reviewProps(view, bulk).onRefresh(); view.render();
    await local.coordinator.handleCancelUpgrade(view.sent.filter(message => message.type === 'cancel-upgrade').at(-1));
    assert.equal(local.coordinator.analysis, undefined);
    assert.equal(locks.holderOf(key), owner, 'Retry only discards this window\'s cached review');
    const retry = view.sent.filter(message => message.type === (bulk ? 'bulk-upgrade' : 'upgrade')).at(-1).requestId;
    await local.coordinator.handleAnalyzeUpgrade({ requestId: retry, package: row.name, target: row.upgradeTo });
    assert.match(reviewProps(view, bulk).error, /already in progress/);
    reviewProps(view, bulk).onCancel(); view.render();
    await local.coordinator.handleCancelUpgrade(view.sent.filter(message => message.type === 'cancel-upgrade').at(-1));
    assert.equal(locks.holderOf(key), owner, 'Cancel cannot release another operation\'s reservation');
    view.event({ status: 'upgrade-error', analysisId: value.analysisId, package: row.name,
      error: { code: 'UPGRADE_IN_PROGRESS', message: 'Late confirmation error.' } });
    if (bulk) assert.equal(reviewProps(view, bulk), undefined);
    else assert.equal(reviewProps(view, bulk).active, false);
    foreign.gate.release(); await running;
    assert.equal(locks.holderOf(key), undefined);
  });
}

async function reviewDom(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: callback => { callback(); return 1; } };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { container, document: dom.window.document, render: element => act(() => root.render(element)) };
}

for (const [name, Component, props, footer] of [
  ['single', UpgradeReviewPanel, panelProps, '.review-panel__footer'],
  ['bulk', UpgradeAnalysisModal, common, '.modal__footer'],
]) test(`${name} completion keeps the focused Cancel DOM button through settled and stale results`, async t => {
  const dom = await reviewDom(t);
  await dom.render(createElement(Component, { ...props, analysis: null, sections: WAITING_UPGRADE_ANALYSIS_SECTIONS }));
  const cancel = dom.container.querySelector(`${footer} button`);
  cancel.focus();
  assert.equal(dom.document.activeElement, cancel);
  for (const value of [analysis(), analysis({ compatibility: { status: 'unknown', completeness: 'partial', findings: [] }, security: null })]) {
    await dom.render(createElement(Component, { ...props, analysis: value, hardStale: true }));
    assert.equal(dom.container.querySelector(`${footer} button`), cancel, 'the footer control is reconciled in place');
    assert.equal(dom.document.activeElement, cancel, 'completion preserves keyboard focus');
    assert.ok(cancel.nextElementSibling?.matches('button'), 'the next control remains the confirmation action');
  }
  await dom.render(createElement(Component, { ...props, analysis: null, error: 'Read failed.' }));
  assert.equal(dom.document.activeElement, cancel, 'a refreshed review failure preserves focus too');
});

for (const [name, Component, props] of [['single', UpgradeReviewPanel, panelProps], ['bulk', UpgradeAnalysisModal, common]]) test(`${name} summary and verification warning follow a detected script checkbox together`, async t => {
  const dom = await reviewDom(t);
  const value = analysis();
  value.verification = { configured: false, suggestedScriptNames: ['build', 'test'] };
  function Review() {
    const [selection, update] = useState({ scripts: [], remember: false });
    return createElement(VerificationOptInContext.Provider, { value: {
      selectionFor: id => id === value.analysisId ? selection : { scripts: [], remember: false },
      update: (_id, next) => update(next),
    } }, createElement(Component, { ...props, analysis: value }));
  }
  await dom.render(createElement(Review));
  assert.match(dom.container.textContent, /Build\/test checks not configured/);
  const area = reviewArea(dom.document, name, 'verification');
  const warningSelector = '.outcome-status--warning, .status-badge--warning';
  assert.ok(area.querySelector(warningSelector)?.querySelector('svg'));
  const box = dom.container.querySelector('.verification-suggestions input');
  await act(() => box.click());
  assert.equal(box.checked, true);
  assert.match(dom.container.textContent, /build will run/);
  if (name === 'bulk') assert.match(dom.container.textContent, /Selected checks run after this change/);
  else assert.match(area.textContent, /Run build/);
  assert.equal(area.querySelector(warningSelector), null, 'the section clears its warning with the summary');
  assert.doesNotMatch(dom.container.textContent, /Build\/test checks not configured/);
  await act(() => box.click());
  assert.equal(box.checked, false);
  assert.match(dom.container.textContent, /Build\/test checks not configured/);
  assert.ok(area.querySelector(warningSelector)?.querySelector('svg'));
  assert.doesNotMatch(dom.container.textContent, /build will run|Selected checks run after this change/);
});

test('dependency warnings stay visible while Show more still reveals supporting findings', async t => {
  const dom = await reviewDom(t);
  const supporting = Array.from({ length: 5 }, (_, i) => ({ ...major, id: `compatible-${i}`, kind: 'peer-compatible', status: 'compatible',
    requirement: { name: 'peer', range: '^1', optional: false }, observedVersion: '1.0.0' }));
  const value = analysis({ compatibility: { status: 'warning', completeness: 'complete', findings: [...supporting, major] } });
  await dom.render(createElement(UpgradeReviewPanel, { ...panelProps, analysis: value }));
  const area = reviewArea(dom.document, 'single', 'dependency');
  assert.equal(area.querySelectorAll('[data-finding-id]').length, 1);
  assert.match(area.querySelector('.outcome-status--warning').textContent, /Warning: Major update/);
  const more = area.querySelector('.analysis-card__more');
  assert.match(more.textContent, /Show 5 more findings/);
  await act(() => more.click());
  assert.equal(area.querySelectorAll('[data-finding-id]').length, 6);
  assert.equal(area.querySelector('.analysis-card__more'), null);
});

test('resolver conflicts display their reason without claiming resolution succeeded', () => {
  const value = analysis({ compatibility: { status: 'conflict', completeness: 'complete', findings: [],
    resolverVerification: { status: 'conflict', packageManager: 'npm', packageManagerVersion: '10', code: 'ERESOLVE', explanation: 'Required peer versions conflict.' } } });
  const document = new JSDOM(render(UpgradeReviewPanel, { ...panelProps, analysis: value }));
  try {
    const area = reviewArea(document.window.document, 'single', 'dependency');
    assert.match(area.textContent, /Required peer versions conflict\./);
    assert.doesNotMatch(area.textContent, /npm resolved the proposed dependency tree/);
  } finally { document.window.close(); }
});

// Use a real layout engine without adding a browser dependency to the extension.
// Set PACKAGEAWY_CHROMIUM_PATH to a local Chromium or headless-shell executable.
test('bulk summary fits the capped dialog at wide and narrow viewport widths', {
  skip: process.env.PACKAGEAWY_CHROMIUM_PATH ? false : 'Set PACKAGEAWY_CHROMIUM_PATH to run the rendered layout check',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'packageawy-review-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stylesheet = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
  const cases = [
    ['loading', { analysis: null }],
    ['completed', { analysis: analysis() }],
    ['contention', { analysis: analysis(), error: 'Another dependency change is already in progress for this project.' }],
  ].map(([name, props]) => ({ name, html: render(UpgradeAnalysisModal, { ...common, ...props }) }));
  const fixturePath = join(directory, 'review.html');
  await writeFile(fixturePath, `<!doctype html><html><head><style>
    :root { --vscode-font-family: sans-serif; --vscode-font-size: 13px;
      --vscode-foreground: #cccccc; --vscode-editor-background: #1e1e1e;
      --vscode-descriptionForeground: #cccccc; --vscode-panel-border: #808080;
      --vscode-focusBorder: #007fd4; }
    ${stylesheet}
    </style></head><body><div id="fixture"></div><pre id="measurements"></pre><script>
    const bounds = node => {
      const { left, right, top, bottom, width } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    };
    const results = [];
    for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
      document.body.className = theme;
      for (const entry of ${JSON.stringify(cases)}) {
        document.getElementById('fixture').innerHTML = entry.html;
        const summary = document.querySelector('.upgrade-decision');
        results.push({ name: entry.name, theme, viewport: innerWidth,
          dialog: bounds(document.querySelector('.modal')), summary: bounds(summary),
          lead: bounds(summary.querySelector('.upgrade-decision__lead')),
          signals: bounds(summary.querySelector('.upgrade-decision__signals')),
          shortcuts: [...summary.querySelectorAll('.upgrade-decision__signal > button')].map(button => ({
            button: bounds(button), value: bounds(button.querySelector('.upgrade-decision__signal-value')),
            arrow: bounds(button.querySelector('.upgrade-decision__signal-arrow')),
          })),
        });
      }
    }
    document.getElementById('measurements').textContent = JSON.stringify(results);
    </script></body></html>`);
  for (const width of [1440, 480]) {
    const { stdout } = await promisify(execFile)(process.env.PACKAGEAWY_CHROMIUM_PATH, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run',
      '--force-prefers-reduced-motion', `--user-data-dir=${join(directory, `profile-${width}`)}`,
      `--window-size=${width},1100`, '--dump-dom', pathToFileURL(fixturePath).href,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const document = new JSDOM(stdout);
    try {
      const results = JSON.parse(document.window.document.getElementById('measurements').textContent);
      assert.equal(results.length, cases.length * 4);
      for (const result of results) {
        const label = `${result.name}, ${result.theme}, ${width}px`;
        assert.equal(result.viewport, width, label);
        assert.ok(result.dialog.width <= 44 * 16 + 1, `${label}: dialog keeps its width cap`);
        if (width === 1440) assert.ok(result.dialog.width >= 44 * 16 - 1, `${label}: test exercises the capped desktop dialog`);
        assert.ok(result.signals.top >= result.lead.bottom - 1, `${label}: shortcuts stack below the summary`);
        assert.ok(result.summary.scrollWidth <= result.summary.clientWidth + 1, `${label}: summary does not clip content`);
        assert.equal(result.shortcuts.length, 4);
        for (const shortcut of result.shortcuts) {
          assert.ok(shortcut.button.scrollWidth <= shortcut.button.clientWidth + 1, `${label}: shortcut fits`);
          for (const part of [shortcut.value, shortcut.arrow]) {
            assert.ok(part.width > 0 && part.left >= shortcut.button.left - 1 && part.right <= shortcut.button.right + 1,
              `${label}: status and arrow fit inside their button`);
            assert.ok(part.left >= result.summary.left && part.right <= result.summary.right,
              `${label}: status and arrow stay inside the summary`);
          }
        }
      }
    } finally { document.window.close(); }
  }
});


for (const [name, Component, props] of [['single', UpgradeReviewPanel, panelProps], ['bulk', UpgradeAnalysisModal, common]]) {
  test(`${name} apply replaces the review with simple loading while retaining native operation ownership`, () => {
    const value = analysis({ manifestPath: win32.join('fixture', 'package.json'), lockfilePath: win32.join('fixture', 'package-lock.json') });
    const html = render(Component, { ...props, analysis: value, busy: true });
    const dom = new JSDOM(html);
    try {
      const document = dom.window.document;
      assert.equal(document.querySelector('.analysis-loading__title').textContent, 'Upgrading alpha to 7.1.0...');
      assert.equal(document.querySelector('.analysis-loading').getAttribute('aria-busy'), 'true');
      assert.equal(document.querySelector('.upgrade-decision, .verification-steps, .upgrade-tab__details'), null);
      assert.doesNotMatch(document.body.textContent, /fixture[\\/]/);
      assert.ok(document.querySelector('.analysis-loading__icon'));
      assert.equal(document.querySelector('button:not(:disabled)'), null, 'execution cannot be dismissed locally');
    } finally { dom.window.close(); }
    for (const status of [{ task: 'still-running', blocked: false }, { task: 'idle', blocked: true }]) {
      const paused = renderToStaticMarkup(createElement(DependencyChangeContext.Provider, { value: { ...status, openRecovery: noop } },
        createElement(Component, { ...props, analysis: value, busy: true })));
      assert.doesNotMatch(paused, /analysis-loading__icon/);
      assert.match(paused, /aria-busy="false"/);
    }
  });
  test(`${name} coordinated apply labels the complete plan without rendering steps`, () => {
    const value = analysis({ smartPlan: { changes: [
      { packageName: 'alpha', currentVersion: '6.2.0', targetVersion: '7.1.0', classification: 'prod' },
      { packageName: 'peer', currentVersion: '1.0.0', targetVersion: '2.0.0', classification: 'prod' },
    ], reasonFindingIds: [] } });
    const html = render(Component, { ...props, analysis: value, busy: true });
    assert.match(html, /Upgrading 2 dependencies\.\.\./);
    assert.doesNotMatch(html, /verification-steps|coordinated-plan__reasons/);
  });
}

for (const makePath of [join, win32.join]) test(`bulk removal loading hides review facts with ${makePath === join ? 'native' : 'Windows'} paths`, () => {
  const value = { analysisId: 'remove', changes: [], files: { manifestPath: makePath('fixture', 'package.json'), lockfilePath: makePath('fixture', 'package-lock.json') }, verification: { configured: false } };
  for (const packages of [['alpha'], ['alpha', 'peer']]) {
    const html = render(RemoveAnalysisModal, { packages, analysis: value, busy: true, matchTags: new Map(), onConfirm: noop, onCancel: noop, onConfigureVerification: noop });
    assert.match(html, packages.length === 1 ? /Removing alpha\.\.\./ : /Removing 2 dependencies\.\.\./);
    assert.doesNotMatch(html, /fixture[\\/]|verification-steps|remove-selected-heading/);
    assert.match(html, /analysis-loading__icon/);
  }
});

test('transitive fix loading keeps safe cancellation and phase announcements without repeating the plan', () => {
  const plan = { analysisId: 'fix', rootPackage: 'alpha' };
  const props = { state: { phase: 'applying', plan, progress: 'installing', cancelRequested: false }, onCancel: noop };
  const html = render(TransitiveFixReview, props);
  assert.match(html, /Applying dependency fix for alpha\.\.\./);
  assert.match(html, /class="sr-only"[^>]*role="status"[^>]*>Installing the reviewed dependency tree…/);
  assert.match(html, />Cancel fix</);
  assert.doesNotMatch(html, /transitive-review__change|transitive-review__files/);
  const stopping = render(TransitiveFixReview, { ...props, state: { ...props.state, cancelRequested: true } });
  assert.match(stopping, /Stopping at a safe point, then restoring if needed…/);
  assert.match(stopping, /disabled="">Cancelling…/);
});

test('upgrade review visibly loads before any host progress message and keeps Cancel reachable', async t => {
  const dom = await reviewDom(t);
  await dom.render(createElement(UpgradeReviewPanel, { ...panelProps, analysis: null, sections: WAITING_UPGRADE_ANALYSIS_SECTIONS }));
  assert.equal(dom.container.querySelector('.analysis-loading__title').textContent, 'Analyzing upgrade...');
  assert.ok(dom.container.querySelector('.analysis-loading__icon'));
  const cancel = dom.container.querySelector('.review-panel__footer button');
  cancel.focus();
  assert.equal(dom.document.activeElement, cancel);
  await dom.render(createElement(UpgradeReviewPanel, { ...panelProps, analysis: analysis() }));
  assert.equal(dom.container.querySelector('.analysis-loading'), null);
  assert.ok(dom.container.querySelector('.upgrade-decision'));
  assert.equal(dom.document.activeElement, cancel);
});

test('apply focuses its loading heading when the confirmation control leaves the review', async t => {
  const dom = await reviewDom(t);
  await dom.render(createElement(UpgradeReviewPanel, { ...panelProps, analysis: analysis() }));
  dom.container.querySelector('.review-panel__footer button:last-child').focus();
  await dom.render(createElement(UpgradeReviewPanel, { ...panelProps, analysis: analysis(), busy: true }));
  assert.equal(dom.document.activeElement.id, 'change-running-heading');
});

for (const [name, Component, props] of [['single', UpgradeReviewPanel, panelProps], ['bulk', UpgradeAnalysisModal, common]]) {
  test(`${name} failed confirmation preserves focus moved outside the loader`, async t => {
    const dom = await reviewDom(t);
    const value = analysis();
    await dom.render(createElement(Component, { ...props, analysis: value }));
    await dom.render(createElement(Component, { ...props, analysis: value, busy: true }));
    assert.equal(dom.document.activeElement.id, 'change-running-heading');
    const elsewhere = dom.document.createElement('button');
    dom.document.body.append(elsewhere);
    elsewhere.focus();
    await dom.render(createElement(Component, { ...props, analysis: value,
      error: 'Another dependency change is already in progress for this project.' }));
    assert.ok(dom.container.querySelector('.upgrade-review__error button:not(:disabled)'));
    assert.equal(dom.document.activeElement, elsewhere, 'rejection must not steal focus');
    // A later error update must not trigger a delayed focus jump either.
    await dom.render(createElement(Component, { ...props, analysis: value, error: 'Please retry.' }));
    assert.equal(dom.document.activeElement, elsewhere);
  });
}

test('dependency findings keep reading order, aligned edges and group spacing at 1100px and 400px in both host themes', {
  skip: !process.env.PACKAGEAWY_CHROMIUM_PATH && 'Set PACKAGEAWY_CHROMIUM_PATH to run rendered compatibility checks',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'packageawy-compatibility-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stylesheet = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
  const value = analysis({ compatibility: { status: 'warning', completeness: 'complete', findings: [major],
    resolverVerification: { status: 'compatible', packageManager: 'npm', packageManagerVersion: '10', explanation: 'Resolved.' } } });
  const html = render(CompatibilityCheckCard, { compatibility: value.compatibility, projectCompatibility: value.projectCompatibility, context: { package: row.name, currentVersion: row.current } });
  const partialHtml = render(CompatibilityCheckCard, { compatibility: { ...value.compatibility, completeness: 'partial' }, context: { package: row.name, currentVersion: row.current } });
  const fixture = join(directory, 'compatibility.html');
  await writeFile(fixture, `<!doctype html><html><head><style>
    :root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; --vscode-foreground: #ccc;
      --vscode-editor-background: #1e1e1e; --vscode-descriptionForeground: #ccc; --vscode-panel-border: #808080;
      --vscode-editorWarning-foreground: #cca700; --vscode-inputValidation-warningBorder: #b89500;
      --vscode-inputValidation-warningBackground: #352a05; --vscode-inputValidation-warningForeground: #fff;
      --vscode-focusBorder: #007fd4; }
    body.vscode-light, body.jetbrains-light { --vscode-foreground: #222; --vscode-editor-background: #fff;
      --vscode-descriptionForeground: #444; --vscode-inputValidation-warningBackground: #fff4ce;
      --vscode-inputValidation-warningForeground: #222; --vscode-editorWarning-foreground: #795e00; }
    body.vscode-high-contrast { --vscode-foreground: #fff; --vscode-editor-background: #000;
      --vscode-descriptionForeground: #fff; --vscode-focusBorder: #f38518; --vscode-contrastBorder: #fff; }
    body.vscode-high-contrast-light { --vscode-foreground: #000; --vscode-editor-background: #fff;
      --vscode-descriptionForeground: #000; --vscode-focusBorder: #005fb8; --vscode-contrastBorder: #000;
      --vscode-inputValidation-warningBackground: #fff; --vscode-inputValidation-warningForeground: #000; }
    ${stylesheet}
    main { padding: 16px; }
    </style></head><body><main class="upgrade-tab" id="fixture"></main><pre id="measurements"></pre><script>
      const fixture = document.getElementById('fixture');
      const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, scroll: node.scrollWidth, client: node.clientWidth }; };
      const results = [];
      for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light', 'jetbrains-dark', 'jetbrains-light']) {
        document.body.className = theme;
        for (const [name, html] of ${JSON.stringify([['complete', html], ['partial', partialHtml]])}) {
          fixture.innerHTML = html;
          const warning = fixture.querySelector('.outcome-status--warning');
          const resolver = fixture.querySelector('.compatibility-findings > .outcome-status');
          const group = fixture.querySelector('.upgrade-compatibility__findings');
          const tiles = fixture.querySelector('.hygiene-strip');
          results.push({ theme, name, viewport: innerWidth, warning: bounds(warning), resolver: bounds(resolver), group: bounds(group), tiles: bounds(tiles),
            warningIcon: bounds(warning.querySelector('svg')), resolverIcon: bounds(resolver.querySelector('svg')),
            warningText: bounds(warning.querySelector('.outcome-status__label')), resolverText: bounds(resolver.querySelector('.outcome-status__label')),
            summary: fixture.querySelector('.upgrade-compatibility__summary')?.textContent.trim() ?? null,
            items: [...tiles.children].map(bounds), all: [...fixture.querySelectorAll('.compatibility-findings, .outcome-status, .outcome-status > div, .hygiene-strip__item')].map(bounds) });
        }
      }
      fixture.innerHTML = ${JSON.stringify(html)};
      document.body.className = 'vscode-high-contrast';
      document.getElementById('measurements').textContent = JSON.stringify(results);
    </script></body></html>`);
  for (const width of [1100, 400]) {
    const { stdout } = await promisify(execFile)(process.env.PACKAGEAWY_CHROMIUM_PATH, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run',
      '--force-prefers-reduced-motion', `--user-data-dir=${join(directory, `profile-${width}`)}`,
      `--window-size=${width},1100`, `--screenshot=${join(tmpdir(), `packageawy-compatibility-${width}.png`)}`,
      '--dump-dom', pathToFileURL(fixture).href,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const dom = new JSDOM(stdout);
    try {
      const results = JSON.parse(dom.window.document.getElementById('measurements').textContent);
      assert.equal(results.length, 12);
      for (const result of results) {
        const label = `${result.theme}, ${result.name}, ${width}px`;
        assert.equal(result.viewport, width, label);
        assert.ok(result.resolver.top - result.warning.bottom >= 11, `${label}: findings never touch`);
        assert.ok(result.tiles.top - result.group.bottom >= 23, `${label}: tiles form a separate group`);
        assert.ok(Math.abs(result.warningIcon.left - result.resolverIcon.left) < 1, `${label}: icon edges align`);
        assert.ok(Math.abs(result.warningText.left - result.resolverText.left) < 1, `${label}: text edges align`);
        assert.ok(Math.abs(result.warning.width - result.tiles.width) < 1, `${label}: warning uses full column width`);
        if (result.name === 'complete') assert.equal(result.summary, null, `${label}: duplicate warning summary removed`);
        else assert.equal(result.summary, 'Some compatibility checks could not be completed.');
        for (const part of result.all) assert.ok(part.scroll <= part.client + 1, `${label}: content wraps without clipping`);
        if (width === 400) assert.ok(result.items[1].top >= result.items[0].bottom, `${label}: tiles stack on narrow screens`);
        else assert.ok(Math.abs(result.items[0].top - result.items[1].top) < 1, `${label}: tiles share a row`);
      }
    } finally { dom.window.close(); }
  }
});


for (const entry of ['overview action', 'review tab']) test(`Manage ${entry} starts upgrade analysis and visibly waits for its final summary`, async t => {
  const view = appHarness(t);
  view.event(snapshot());
  view.find('Dashboard').props.onOpenManage(row.name); view.render();
  const dom = await reviewDom(t);
  let targetPhase = entry === 'review tab' ? 'loading' : 'idle';
  const draw = async () => {
    const props = view.find('ManageDependencyModal').props;
    await dom.render(createElement(ManageDependencyModal, { ...props, upgrade: { ...props.upgrade, targetState: { phase: targetPhase } } }));
  };
  await draw();
  const action = entry === 'overview action'
    ? [...dom.container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Review upgrade')
    : dom.document.getElementById('manage-tab-upgrade');
  assert.ok(action);
  await act(() => action.click()); view.render();
  await draw();
  if (entry === 'review tab') {
    assert.equal(view.sent.filter(message => message.type === 'upgrade').length, 0, 'wait for target eligibility before analysis');
    assert.ok(dom.container.querySelector('.analysis-loading__icon'));
    targetPhase = 'idle';
    await draw();
  }
  view.render(); await draw();
  const requests = view.sent.filter(message => message.type === 'upgrade');
  assert.equal(requests.length, 1, 'opening a review requests one analysis');
  assert.equal(view.find('ManageDependencyModal').props.upgrade.active, true);
  assert.equal(dom.container.querySelector('.analysis-loading__title').textContent, 'Analyzing upgrade...');
  assert.ok(dom.container.querySelector('.analysis-loading__icon'));
  const requestId = requests[0].requestId;
  const value = analysis();
  value.projectCompatibility.identity.requestId = requestId;
  for (const section of partials(value)) {
    view.event({ status: 'upgrade-analysis-partial', requestId, package: row.name, section }); await draw();
    assert.ok(dom.container.querySelector('.analysis-loading__icon'));
    assert.equal(dom.container.querySelector('.upgrade-major-notice'), null);
  }
  view.event({ status: 'upgrade-analysis', requestId, analysis: value }); await draw();
  assert.equal(dom.container.querySelector('.analysis-loading'), null);
  assert.ok(dom.container.querySelector('.upgrade-major-notice'));
  assert.equal(view.sent.filter(message => message.type === 'upgrade').length, 1);
  const props = view.find('ManageDependencyModal').props;
  props.upgrade.onTargetChange('8.0.0'); view.render(); await draw();
  assert.equal(view.sent.filter(message => message.type === 'upgrade').length, 1, 'picker changes keep the explicit Analyze step');
  assert.ok([...dom.container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Analyze upgrade'));
});
