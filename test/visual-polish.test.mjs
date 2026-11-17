import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'packageawy-polish-'));
after(() => rmSync(dir, { recursive: true, force: true }));
buildSync({
  stdin: { contents: `import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { SeverityBadge } from './webview/src/components/SeverityBadge.tsx';
    import { DependencyEmptyState } from './webview/src/components/DependencyEmptyState.tsx';
    import { SummaryCards } from './webview/src/components/SummaryCards.tsx';
    import { AvailableHeaderInfo } from './webview/src/components/VersionCell.tsx';
    import { summaryMetrics } from './src/host/summaryMetrics.ts';
    export const badge = props => renderToStaticMarkup(createElement(SeverityBadge, props));
    export const availableHelp = () => renderToStaticMarkup(createElement(AvailableHeaderInfo));
    export const empty = props => renderToStaticMarkup(createElement(DependencyEmptyState, props));
    export const cards = () => renderToStaticMarkup(createElement(SummaryCards, {
      metrics: summaryMetrics([]), availability: {updates: 'complete', advisories: 'complete'}, selected: 'all', onSelect(){}
    }));`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'render.cjs'), logLevel: 'silent',
});
const { badge, availableHelp, empty, cards } = createRequire(import.meta.url)(join(dir, 'render.cjs'));
const css = readFileSync(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');

test('Safe is a text-only badge with a keyboard reachable explanation', () => {
  const html = badge({ severity: null });
  assert.match(html, /<button[^>]*aria-label="Safe"[^>]*aria-describedby=/);
  assert.match(html, /severity--none">Safe<\/span>/);
  assert.doesNotMatch(html, /<svg/);
  for (const [props, label] of [
    [{ checked: false }, 'Not checked'], [{ advisoriesAvailable: false }, 'Unavailable'], [{ advisoriesOff: true }, 'Off'],
  ]) {
    const other = badge({ severity: null, ...props });
    assert.match(other, new RegExp(`>${label}<`));
    assert.doesNotMatch(other, /Safe|severity--none/);
  }
  const tooltip = readFileSync(join(process.cwd(), 'webview', 'src', 'components', 'Tooltip.tsx'), 'utf8');
  assert.match(tooltip, /onMouseEnter=\{show\}/);
  assert.match(tooltip, /onFocus=\{show\}/);
  assert.match(tooltip, /event.key === 'Escape'/);
  const display = readFileSync(join(process.cwd(), 'src', 'host', 'severityDisplay.ts'), 'utf8');
  assert.match(display, /No known vulnerabilities\. The latest security check found no published vulnerabilities in this package or its installed dependencies\./);
});

test('every severity and check state uses intrinsic badge sizing with equal padding', () => {
  for (const [severity, label] of [
    ['critical', 'Critical'], ['high', 'High'], ['moderate', 'Moderate'], ['low', 'Low'], ['info', 'Info'], [null, 'Safe'],
  ]) {
    assert.match(badge({ severity }), new RegExp(`class="severity severity--${severity ?? 'none'}">${label}</span>`));
  }
  assert.match(css, /\.severity \{[^}]*display: inline-flex;[^}]*padding: 0\.1rem 0\.5rem;[^}]*border: 1px solid currentColor;[^}]*border-radius: 3px/);
  // No severity or state may reintroduce a fixed width or special shape.
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/(?:^|\s)\.severity(?:[\s.{:]|--)/.test(selector)) {
      assert.doesNotMatch(body, /(?:^|;)\s*(?:(?:min-|max-)?width|flex(?:-grow|-basis)?):/);
      if (selector.includes('.severity--')) {
        assert.doesNotMatch(body, /(?:^|;)\s*(?:padding(?:-\w+)?|line-height|white-space|border-radius):/);
      }
    }
  }
  assert.match(css, /\.severity--none \{[^}]*color: var\(--vscode-charts-green/);
});

test('inline help stays unfilled and borderless in every state with visible keyboard focus', () => {
  assert.match(availableHelp(), /<button[^>]*class="info-tooltip__trigger"[^>]*aria-label="Version terminology"[^>]*aria-describedby=/);
  assert.match(css, /\.info-tooltip__trigger \{[^}]*border: none;[^}]*background: none;/);
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.includes('.info-tooltip__trigger')) continue;
    for (const [, property, value] of body.matchAll(/(?:^|;)\s*(border|background):\s*([^;]+)/g)) {
      assert.ok((property === 'border' ? ['none', '0'] : ['none', 'transparent']).includes(value.trim()), `${selector}: ${property}: ${value}`);
    }
  }
  assert.match(css, /\.info-tooltip__trigger:focus-visible \{[^}]*outline: 2px solid var\(--vscode-focusBorder, var\(--vscode-contrastBorder, currentColor\)\)/);
});

test('project empty state uses the decorative brand while search and filter stay distinct', () => {
  const project = empty({ icon: 'package', title: 'No dependencies', detail: 'Add dependencies to package.json.' });
  assert.match(project, /empty-state__heading"><svg[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"/);
  assert.match(project, /empty-state__title">No dependencies/);
  for (const icon of ['search', 'filter']) {
    assert.match(empty({ icon, title: 'No matches' }), /viewBox="0 0 16 16"/);
  }
});

test('dashboard security counts have accurate labels and focusable help', () => {
  const html = cards();
  assert.match(html, /summary-card__label">Affected packages</);
  assert.match(html, /No known vulnerabilities/);
  assert.doesNotMatch(html, /Vulnerable Dependencies/);
  assert.match(html, /<button[^>]*aria-label="About security counts"[^>]*aria-describedby=/);
  const source = readFileSync(join(process.cwd(), 'webview', 'src', 'components', 'SummaryCards.tsx'), 'utf8');
  assert.match(source, /Your direct dependencies affected by a known vulnerability, directly or through their own dependencies\./);
  assert.match(source, /Separate published security reports that apply, counted once even when several packages reach them\./);
});

test('security help has a reserved corner and card dividers follow their grid slots', () => {
  assert.match(css, /\.summary-card-slot \{[^}]*position: relative;[^}]*display: grid;[^}]*min-width: 0;/);
  assert.match(css, /\.summary-card \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.summary-card-slot--with-help \.summary-card__selection \{[^}]*min-width: 1\.5rem;[^}]*margin-top: 1\.8rem;/);
  assert.match(css, /\.summary-card__help \{[^}]*position: absolute;[^}]*top: 0\.8rem;[^}]*right: 0\.9rem;/);
  assert.match(css, /\.summary-card__help \.info-tooltip__trigger \{[^}]*width: 1\.5rem;[^}]*height: 1\.5rem;[^}]*margin: 0;/);
  assert.match(css, /\.summary-card-slot:nth-child\(2\) > \.summary-card \{[^}]*border-right: 0;/);
  assert.match(css, /\.summary-card-slot:nth-child\(-n \+ 2\) > \.summary-card \{[^}]*border-bottom: 1px solid var\(--dashboard-line\);/);
  assert.match(css, /\.summary-card-slot:last-child > \.summary-card \{[^}]*border-bottom: 0;/);
  assert.doesNotMatch(css, /\.summary-card:(?:last-child|nth-child)/);
});

test('table headers and cells share insets without making th a flex container', () => {
  assert.match(css, /\.packages th,\s*\.packages td \{[^}]*padding: var\(--cell-inset-block\) var\(--cell-inset-inline\)/);
  assert.match(css, /\.sortable-header__row \{[^}]*display: flex;[^}]*padding-inline: var\(--cell-inset-inline\)/);
  assert.match(css, /\.sort-header \{[^}]*padding: var\(--cell-inset-block\) 0;/);
  assert.match(css, /padding-inline-start: calc\(var\(--cell-inset-inline\) - var\(--security-badge-inset\) - 1px\)/);
  assert.match(css, /\.packages \.severity \{[^}]*justify-content: flex-start;[^}]*padding-inline: var\(--security-badge-inset\)/);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.packages (?:thead )?th/.test(rule[1])) assert.doesNotMatch(rule[2], /display:\s*(?:inline-)?flex/);
  }
});

test('secondary and icon buttons retain fill, border, focus and disabled states across host themes', () => {
  for (const variant of ['secondary', 'subtle']) {
    assert.match(css, new RegExp(`\\.button--${variant} \\{[^}]*background: var\\(--secondary-fill\\);[^}]*border-color: var\\(--secondary-border\\);`));
  }
  for (const token of ['secondaryBackground', 'secondaryForeground', 'secondaryHoverBackground']) {
    assert.ok(css.includes(`--vscode-button-${token}`));
  }
  assert.match(css, /--secondary-border: var\(--vscode-contrastBorder, var\(--vscode-button-border,/);
  assert.match(css, /\.button:focus-visible \{[^}]*outline: 2px solid/);
  assert.match(css, /\.button:disabled \{[^}]*opacity: 0\.5;[^}]*cursor: default/);
  assert.match(css, /\.modal__close,\s*\.disclosure,\s*\.pagination__nav,\s*\.pagination__page,\s*\.search__clear \{[^}]*border: 1px solid var\(--secondary-border\);[^}]*background: var\(--secondary-fill\)/);
  const theme = readFileSync(join(process.cwd(), 'jetbrains', 'src', 'main', 'kotlin', 'io', 'github', 'azzamaldulaylan', 'packageawy', 'webview', 'ThemeVariables.kt'), 'utf8');
  for (const token of ['button-secondaryBackground', 'button-secondaryForeground', 'button-secondaryHoverBackground', 'button-border', 'contrastBorder']) {
    assert.ok(theme.includes(`v["${token}"] = css(p.`));
  }
});
