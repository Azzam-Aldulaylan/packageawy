import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bundle = await build({
  stdin: {
    contents: `export { IconBrand } from './webview/src/icons.tsx';
      export { PackageIcon } from './webview/src/components/PackageIcon.tsx';
      export { PackageTable } from './webview/src/components/PackageTable.tsx';
      export { DependencyLoadingState } from './webview/src/components/DependencyLoadingState.tsx';
      export { SummaryCards } from './webview/src/components/SummaryCards.tsx';
      export { ManageDependenciesModal } from './webview/src/components/ManageDependenciesModal.tsx';
      export { RemovalReviewPanel } from './webview/src/components/RemovalReviewPanel.tsx';
      export { emptyCriteria } from './src/host/dependencyCriteria.ts';
      export { summaryMetrics } from './src/host/summaryMetrics.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { IconBrand, PackageIcon, PackageTable, DependencyLoadingState, SummaryCards,
  ManageDependenciesModal, RemovalReviewPanel, emptyCriteria, summaryMetrics } = module.exports;
const noop = () => {};
const row = { name: 'left-pad', range: '^1.3.0', current: '1.3.0', dev: false,
  advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null };
const now = Date.parse('2026-11-17T10:00:00.000Z');
const brandPaths = renderToStaticMarkup(createElement(IconBrand)).match(/<path[^>]+>/g);

function checkIcons(component, props, selectors) {
  const dom = new JSDOM(renderToStaticMarkup(createElement(component, props)));
  try {
    for (const selector of selectors) {
      const icons = dom.window.document.querySelectorAll(selector);
      assert.equal(icons.length, 1, selector);
      const icon = icons[0];
      assert.equal(icon.getAttribute('viewBox'), '0 0 24 24', selector);
      assert.equal(icon.getAttribute('fill'), 'currentColor', selector);
      assert.equal(icon.getAttribute('width'), '1em', selector);
      assert.equal(icon.getAttribute('height'), '1em', selector);
      assert.equal(icon.getAttribute('aria-hidden'), 'true', selector);
      assert.equal(icon.getAttribute('focusable'), 'false', selector);
      assert.equal(icon.hasAttribute('tabindex'), false, selector);
      assert.deepEqual(icon.innerHTML.match(/<path[^>]+>/g), brandPaths, selector);
    }
  } finally {
    dom.window.close();
  }
}

test('package tiles and table rows use the decorative Packageawy logo', () => {
  checkIcons(PackageIcon, { name: row.name }, ['.package-icon[aria-hidden="true"] > svg']);
  checkIcons(PackageTable, {
    rows: [row], unavailableUpdatePackages: new Set(), advisoriesAvailable: true,
    searchQuery: '', sortState: null, onSort: noop, onOpenAdvisory: noop,
    hygieneFindings: [], onOpenManage: noop,
  }, ['.package-icon[aria-hidden="true"] > svg']);
});

test('indeterminate and determinate loading rings keep the logo decorative at the centre', () => {
  for (const progress of [undefined, { completed: 0, total: 4 }, { completed: 4, total: 4 }]) {
    checkIcons(DependencyLoadingState, { progress }, ['.loading-ring-wrapper[aria-hidden="true"] > svg.loading-ring__icon']);
  }
});

test('the Total summary card uses the Packageawy logo', () => {
  checkIcons(SummaryCards, {
    metrics: summaryMetrics([row]), availability: { updates: 'complete', advisories: 'complete' },
    selected: 'all', onSelect: noop,
  }, ['[data-card="all"] .summary-card__icon > svg']);
});

test('the Type criteria group uses the Packageawy logo', () => {
  checkIcons(ManageDependenciesModal, {
    rows: [row], hygieneFindings: [], initialCriteria: emptyCriteria(), cleanupBusy: false,
    removalImpact: { phase: 'idle' }, onRecheckHealth: noop, onBulkUpgrade: noop,
    onBulkRemove: noop, onAnalyzeRemovalImpact: noop, onCancelRemovalImpact: noop, onClose: noop,
  }, ['.criteria-group:has([aria-label="Type criteria"]) svg.criteria-group__icon']);
});

for (const paths of [join, win32.join]) {
  test(`removal package and relationship icons use the logo with ${paths === join ? 'native' : 'Windows'} paths`, () => {
    checkIcons(RemovalReviewPanel, {
      row, active: true, busy: false, error: null, removalImpact: { phase: 'idle' },
      analysis: {
        analysisId: 'brand-review', package: row.name, analyzedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        changes: [{ packageName: row.name, classification: 'prod', stillRequiredBy: [] }],
        files: { manifestPath: paths('project', 'package.json'), lockfilePath: paths('project', 'package-lock.json'), rollbackAvailable: true },
        verification: { configured: false, suggestedScriptNames: [] },
      },
      advisoriesAvailable: true, now, onAnalyzeRemoval: noop, onConfirm: noop,
      onViewReferences: noop, onConfigureVerification: noop,
    }, ['svg.removal-package__icon', '.removal-impact__item:first-child .removal-impact__icon[aria-hidden="true"] > svg']);
  });
}
