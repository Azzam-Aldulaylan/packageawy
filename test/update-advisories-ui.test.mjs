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

test('Available cell marks only the offered upgrade, not the within-range or installed version', () => {
  const html = render(AvailableVersionCell, { row }, [result(), result('1.1.0', 1), result('1.0.0', 2)]);
  assert.match(html, /class="[^"]*update-version-warning/);
  assert.equal(html.split(`aria-label="${plural}"`).length - 1, 1, 'one warning, on the offered version');
  assert.doesNotMatch(html, /1\.1\.0|1\.0\.0 has|Within current range/);
});

test('an offered version that is not the latest is shown with its warning and the latest underneath', () => {
  const axios = { ...row, name: 'axios', current: '0.21.1', wanted: '0.21.1', latest: '1.21.1', upgradeTo: '0.21.4',
    upgradeReason: 'security-fix' };
  const html = render(AvailableVersionCell, { row: axios }, [
    { name: 'axios', version: '0.21.4', status: 'checked', count: 23, highestSeverity: 'high' },
    { name: 'axios', version: '1.21.1', status: 'checked', count: 1, highestSeverity: 'low' },
    { name: 'axios', version: '0.21.1', status: 'checked', count: 24, highestSeverity: 'critical' }]);
  assert.ok(html.includes('aria-label="0.21.4 has 23 known vulnerabilities. Highest severity: high."'));
  assert.match(html, /version-cell__value--primary">0\.21\.4</);
  assert.match(html, />Latest: 1\.21\.1</);
  assert.doesNotMatch(html, /1\.21\.1 has|0\.21\.1 has/, 'only the offered version is marked');
});

test('rows with no offered upgrade show the latest version without a warning', () => {
  const html = render(AvailableVersionCell, { row: { ...row, upgradeTo: null, upgradeReason: null } });
  assert.match(html, />2\.3\.0</);
  assert.doesNotMatch(html, /update-version-warning|known vulnerabilit/);
});

test('alias rows sharing one result only warn where the version is not installed', () => {
  const results = [result()];
  assert.ok(render(AvailableVersionCell, { row: { ...row, name: 'a1', registryName: 'app' } }, results).includes(plural));
  assert.doesNotMatch(render(AvailableVersionCell, { row: { ...row, name: 'a2', registryName: 'app', current: '2.3.0' } }, results),
    /update-version-warning/);
});

test('missing registry metadata still shows an offered security fix with its warning', () => {
  const unavailable = render(AvailableVersionCell, { row, resolutionAvailable: false });
  assert.match(unavailable, />2\.3\.0</);
  assert.ok(unavailable.includes(plural));
  assert.match(unavailable, />Unavailable</);
  const signIn = render(AvailableVersionCell, { row, resolutionAvailable: false, signInHost: 'npm.example.com' });
  assert.ok(signIn.includes(plural));
  assert.match(signIn, /title="[^"]*npm\.example\.com/);
  const noOffer = render(AvailableVersionCell, { row: { ...row, upgradeTo: null, upgradeReason: null }, resolutionAvailable: false });
  assert.doesNotMatch(noOffer, /2\.3\.0|update-version-warning/);
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

test('picker options show a short tag after the version and the selected version gets the warning beside the list', () => {
  const html = render(UpgradeTargetSelector, picker, [result(), result('1.9.0', 1), result('3.0.0-beta.1', 1)]);
  assert.match(html, /<option value="1.9.0" title="1.9.0 has 1 known vulnerability. Highest severity: high." selected="">1.9.0 · Publisher LTS · 1 vulnerability \(high\)<\/option>/);
  assert.match(html, />2.3.0 · Latest stable · 3 vulnerabilities \(high\)<\/option>/);
  assert.match(html, />3.0.0-beta.1 · 1 vulnerability \(high\)<\/option>/);
  assert.doesNotMatch(html, /\. 2\.3\.0 has|Publisher LTS\. /, 'no long sentence inside option text');
  assert.match(html, /aria-describedby="upgrade-target-version-warning"/);
  assert.match(html, /id="upgrade-target-version-warning">1.9.0 has 1 known vulnerability/);
  assert.match(html, /upgrade-target-picker__row[\s\S]*<\/select>[\s\S]*update-version-warning/);
});

test('picker warning follows fallback, recommended and outside-the-list selections', () => {
  const ready = picker.state;
  const fallback = render(UpgradeTargetSelector, { ...picker, selectedVersion: null }, [result()]);
  assert.match(fallback, /aria-describedby="upgrade-target-version-warning"/);
  assert.ok(fallback.includes(`id="upgrade-target-version-warning">${plural}`));
  const recommended = render(UpgradeTargetSelector, { ...picker, selectedVersion: null, fallbackVersion: null }, [result()]);
  assert.ok(recommended.includes(`id="upgrade-target-version-warning">${plural}`));
  const outside = render(UpgradeTargetSelector, { ...picker, selectedVersion: '2.2.0', state: ready },
    [{ ...result('2.2.0', 2) }]);
  assert.match(outside, />2.2.0 \(selected target\) · 2 vulnerabilities \(high\)</);
  assert.match(outside, /id="upgrade-target-version-warning">2.2.0 has 2 known vulnerabilities/);
  const errorFallback = render(UpgradeTargetSelector, { ...picker, selectedVersion: null,
    state: { phase: 'error', error: { code: 'x', message: 'y' } } }, [result()]);
  assert.match(errorFallback, />2.3.0 \(dashboard target\) · 3 vulnerabilities \(high\)</);
  const loading = render(UpgradeTargetSelector, { ...picker, state: { phase: 'loading' } }, [result('1.9.0', 1)]);
  assert.doesNotMatch(loading, /aria-describedby|update-version-warning/);
});

for (const results of [[], [result('2.3.0', 0)], [{ name: 'app', version: '2.3.0', status: 'unavailable' }], [result('2.2.0')]]) {
  test(`pending, clean, unavailable and other versions make no warning claim: ${JSON.stringify(results)}`, () => {
    assert.doesNotMatch(render(AvailableVersionCell, { row }, results), /update-version-warning|known vulnerabilit|Safe/);
    assert.doesNotMatch(render(UpgradeTargetSelector, picker, results), /known vulnerabilit|vulnerabilities \(|Safe|aria-describedby/);
    assert.doesNotMatch(render(UpgradeTargetSelector, { ...picker, selectedVersion: '2.3.0' }, results),
      /known vulnerabilit|vulnerabilities \(|Safe|aria-describedby/, 'checked on the selected version itself');
  });
}

test('alias warnings use registry identity and the installed Safe badge describes the tree', () => {
  assert.ok(render(AvailableVersionCell, { row: { ...row, name: 'alias', registryName: 'app' } }).includes(plural));
  assert.match(render(SeverityBadge, { severity: null }), /title="No known vulnerabilities in the installed dependency tree\."/);
});
