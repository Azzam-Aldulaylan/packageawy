import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export { SummaryCards } from './webview/src/components/SummaryCards.tsx';
      export { summaryMetrics } from './src/host/summaryMetrics.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external',
});
const module = { exports: {} };
vm.runInThisContext(`(function(module, exports, require) { ${bundle.outputFiles[0].text}\n})`, {
  filename: join(process.cwd(), 'summary-cards-dom.fixture.cjs'),
})(module, module.exports, require);
const { SummaryCards, summaryMetrics } = module.exports;
const css = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');

for (const selected of ['all', 'updates', 'vulnerabilities', 'attention']) {
  test(`security help is a sibling button and preserves the ${selected} filter`, async t => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const style = dom.window.document.createElement('style');
    style.textContent = css;
    dom.window.document.head.append(style);
    const previous = new Map();
    for (const [key, value] of Object.entries({
      window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    t.after(async () => {
      await act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    const selections = [];
    function Harness() {
      const [filter, setFilter] = useState(selected);
      return createElement(SummaryCards, {
        metrics: summaryMetrics([]), availability: { updates: 'complete', advisories: 'complete' },
        selected: filter, onSelect: id => { selections.push(id); setFilter(id); },
      });
    }
    await act(() => root.render(createElement(Harness)));
    const card = container.querySelector('button[data-card="vulnerabilities"]');
    const trigger = container.querySelector('button[aria-label="About security counts"]');
    assert.ok(card && trigger);
    assert.equal(trigger.type, 'button');
    assert.equal(trigger.tabIndex, 0);
    assert.equal(trigger.closest('.summary-card'), null);
    assert.equal(trigger.parentElement.parentElement, card.parentElement);
    assert.equal(card.parentElement.parentElement, container.querySelector('.summary-cards'));
    assert.equal(container.querySelectorAll('button').length, 5);
    assert.equal(container.querySelector('button button'), null);
    assert.equal(trigger.textContent, '');
    assert.ok(trigger.querySelector('svg[aria-hidden="true"] circle'));
    const pressed = () => [...container.querySelectorAll('.summary-card[aria-pressed="true"]')]
      .map(button => button.dataset.card);
    assert.deepEqual(pressed(), [selected]);

    // JSDOM does not hit-test pointer events. Check the stacking order that
    // keeps the sibling help reachable while the card has keyboard focus.
    await act(() => card.focus());
    assert.equal(dom.window.document.activeElement, card);
    assert.ok(card.matches(':focus-visible'));
    const cardStyle = dom.window.getComputedStyle(card);
    const helpStyle = dom.window.getComputedStyle(trigger.parentElement);
    assert.equal(helpStyle.position, 'absolute');
    assert.ok(Number.isFinite(Number.parseInt(cardStyle.zIndex, 10)));
    assert.ok(Number.parseInt(helpStyle.zIndex, 10) > Number.parseInt(cardStyle.zIndex, 10),
      'help must stack above the focused card for pointer hit testing');

    await act(() => trigger.click());
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const tooltip = container.querySelector('[role="tooltip"]');
    assert.equal(trigger.getAttribute('aria-describedby'), tooltip.id);
    assert.deepEqual([...tooltip.querySelectorAll('dt')].map(term => term.textContent), [
      'Affected packages', 'Known vulnerabilities',
    ]);
    assert.deepEqual([...tooltip.querySelectorAll('dd')].map(definition => definition.textContent), [
      'Your direct dependencies affected by a known vulnerability, directly or through their own dependencies.',
      'Separate published security reports that apply, counted once even when several packages reach them.',
    ]);
    assert.deepEqual(pressed(), [selected]);
    assert.deepEqual(selections, []);

    await act(() => trigger.focus());
    assert.equal(dom.window.document.activeElement, trigger);
    await act(() => trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(container.querySelector('[role="tooltip"]'), null);
    assert.deepEqual(pressed(), [selected]);

    await act(() => card.click());
    assert.deepEqual(selections, ['vulnerabilities']);
    assert.deepEqual(pressed(), ['vulnerabilities']);
    await act(() => trigger.click());
    assert.deepEqual(selections, ['vulnerabilities']);
    assert.deepEqual(pressed(), ['vulnerabilities']);
  });
}
