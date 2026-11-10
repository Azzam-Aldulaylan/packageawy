import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `
  export { UpdateAdvisoryContext } from './webview/src/components/UpdateVersionWarning.tsx';
  export { AvailableVersionCell } from './webview/src/components/VersionCell.tsx';
  export { OverviewPanel } from './webview/src/components/OverviewPanel.tsx';
  export { UpgradeTargetSelector } from './webview/src/components/UpgradeTargetSelector.tsx';
  export { SeverityBadge } from './webview/src/components/SeverityBadge.tsx';
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'shared-react', setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { UpdateAdvisoryContext, AvailableVersionCell, OverviewPanel, UpgradeTargetSelector, SeverityBadge } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const noop = () => {};
const row = { name: 'app', current: '1.0.0', wanted: '1.1.0', latest: '2.3.0', upgradeTo: '2.3.0', upgradeReason: 'update',
  range: '^1', dev: false, optional: false, advisories: [], worstSeverity: null };
const result = (version = '2.3.0', count = 3) => ({ name: 'app', version, status: 'checked', count, highestSeverity: count === 0 ? null : 'high' });
const render = (Component, props, results = [result()]) => renderToStaticMarkup(createElement(UpdateAdvisoryContext.Provider,
  { value: results }, createElement(Component, props)));
const plural = '2.3.0 has 3 known vulnerabilities. Highest severity: high.';

test('Available cell marks the exact offered versions with accessible tooltip text', () => {
  const html = render(AvailableVersionCell, { row }, [result(), result('1.1.0', 1)]);
  assert.match(html, /class="[^"]*update-version-warning/);
  assert.ok(html.includes(`aria-label="${plural}"`));
  assert.match(html, /aria-label="1.1.0 has 1 known vulnerability. Highest severity: high\."/);
  assert.equal(render(AvailableVersionCell, { row: { ...row, wanted: row.latest } }).split(`aria-label="${plural}"`).length - 1, 1,
    'a collapsed version has a single warning');
});

test('Overview upgrade target has the same warning and keeps its requested target', () => {
  const html = render(OverviewPanel, { row, removalImpact: { phase: 'idle' }, actionsDisabled: false,
    upgradeDisabled: false, updateResolutionAvailable: true, advisoriesAvailable: true,
    onStartUpgradeReview: noop, onStartRemovalReview: noop, onAnalyzeRemediation: noop, onReviewRemediation: noop,
    onApplyRemediation: noop, onCancelRemediation: noop, onRetryRemediation: noop, onOpenAdvisory: noop, onChangeTab: noop });
  assert.ok(html.includes(`aria-label="${plural}"`));
  assert.match(html, /manage-action-card__version--target">2.3.0/);
  assert.match(html, />Review upgrade</);
});

const picker = { registryName: 'app', state: { phase: 'ready', targets: { recommendedVersion: '2.3.0', truncated: false,
  options: [{ version: '1.9.0', labels: ['lts'], channel: 'stable' }, { version: '2.3.0', labels: ['latest'], channel: 'stable' },
    { version: '3.0.0-beta.1', labels: [], channel: 'prerelease' }] } },
  selectedVersion: '1.9.0', fallbackVersion: '2.3.0', disabled: false, onChange: noop };

test('native picker uses visible option text for warnings, including LTS and prereleases', () => {
  const html = render(UpgradeTargetSelector, picker, [result(), result('1.9.0', 1), result('3.0.0-beta.1', 1)]);
  assert.match(html, /<option value="1.9.0" selected="">1.9.0 · Publisher LTS. 1.9.0 has 1 known vulnerability. Highest severity: high\.<\/option>/);
  assert.ok(html.includes(`2.3.0 · Latest stable. ${plural}</option>`));
  assert.match(html, />3.0.0-beta.1. 3.0.0-beta.1 has 1 known vulnerability. Highest severity: high\.<\/option>/);
});

for (const results of [[], [result('2.3.0', 0)], [{ name: 'app', version: '2.3.0', status: 'unavailable' }], [result('2.2.0')]]) {
  test(`pending, clean, unavailable and other versions make no warning claim: ${JSON.stringify(results)}`, () => {
    assert.doesNotMatch(render(AvailableVersionCell, { row }, results), /update-version-warning|known vulnerabilit|Safe/);
    assert.doesNotMatch(render(UpgradeTargetSelector, picker, results), /known vulnerabilit|Safe/);
  });
}

test('alias warnings use registry identity and the installed Safe badge describes the tree', () => {
  assert.ok(render(AvailableVersionCell, { row: { ...row, name: 'alias', registryName: 'app' } }).includes(plural));
  assert.match(render(SeverityBadge, { severity: null }), /title="No known vulnerabilities in the installed dependency tree\."/);
});
