import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(join(process.cwd(), 'webview/src/focusTrap.ts'), 'utf8');
const javaScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { nextFocusTarget, trapFocus } = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
);

const controls = ['close', 'select-all', 'confirm'];

test('Tab from the last control wraps to the first', () => {
  assert.equal(nextFocusTarget(controls, 'confirm', true, false), 'close');
});

test('Shift+Tab from the first control wraps to the last', () => {
  assert.equal(nextFocusTarget(controls, 'close', true, true), 'confirm');
});

test('Tab between inner controls is left to the browser', () => {
  assert.equal(nextFocusTarget(controls, 'close', true, false), null);
  assert.equal(nextFocusTarget(controls, 'select-all', true, true), null);
});

test('a focused heading or other non-tabbable element sends Shift+Tab to the last control and Tab to the first', () => {
  assert.equal(nextFocusTarget(controls, 'heading', true, true), 'confirm');
  assert.equal(nextFocusTarget(controls, 'heading', true, false), 'close');
  assert.equal(nextFocusTarget(controls, null, true, true), 'confirm');
});

test('focus outside the dialog is pulled back in', () => {
  assert.equal(nextFocusTarget(controls, 'dashboard-button', false, false), 'close');
  assert.equal(nextFocusTarget(controls, 'dashboard-button', false, true), 'confirm');
  // Even an element that matches a control by identity counts as outside when the container does not hold it.
  assert.equal(nextFocusTarget(controls, 'confirm', false, false), 'close');
});

test('a dialog with no tabbable controls yields no target', () => {
  assert.equal(nextFocusTarget([], 'heading', true, true), null);
});

// Minimal fake DOM: enough for trapFocus to read tabbables and move focus.
class FakeElement {
  constructor(doc, name, { tabIndex = 0, visible = true } = {}) {
    this.doc = doc;
    this.name = name;
    this.tabIndex = tabIndex;
    this.offsetParent = visible ? {} : null;
  }
  focus() {
    this.doc.activeElement = this;
  }
}

function fakeDocument() {
  const listeners = new Set();
  return {
    listeners,
    activeElement: null,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
}

function fakeDialog(doc = fakeDocument()) {
  globalThis.HTMLElement = FakeElement;
  const listeners = doc.listeners;
  const heading = new FakeElement(doc, 'heading', { tabIndex: -1 });
  const close = new FakeElement(doc, 'close');
  const hidden = new FakeElement(doc, 'hidden', { visible: false });
  const confirm = new FakeElement(doc, 'confirm');
  const outside = new FakeElement(doc, 'outside');
  const inner = new Set([heading, close, hidden, confirm]);
  const container = new FakeElement(doc, 'dialog', { tabIndex: -1 });
  container.ownerDocument = doc;
  container.contains = (element) => element === container || inner.has(element);
  container.querySelectorAll = () => [close, hidden, confirm];
  const press = (shiftKey) => {
    const event = {
      key: 'Tab',
      shiftKey,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of listeners) listener(event);
    return event;
  };
  return { doc, container, heading, close, confirm, outside, press, listeners };
}

test('trapFocus: Shift+Tab from the initially focused heading lands on the last control', () => {
  const dialog = fakeDialog();
  const release = trapFocus(dialog.container);
  dialog.heading.focus();
  assert.equal(dialog.press(true).defaultPrevented, true);
  assert.equal(dialog.doc.activeElement, dialog.confirm);
  release();
});

test('trapFocus: Tab from the last control goes to the first, Shift+Tab from the first goes to the last', () => {
  const dialog = fakeDialog();
  const release = trapFocus(dialog.container);
  dialog.confirm.focus();
  dialog.press(false);
  assert.equal(dialog.doc.activeElement, dialog.close);
  dialog.press(true);
  assert.equal(dialog.doc.activeElement, dialog.confirm);
  release();
});

test('trapFocus: focus outside the dialog is pulled back in, and release removes the listener', () => {
  const dialog = fakeDialog();
  const release = trapFocus(dialog.container);
  dialog.outside.focus();
  dialog.press(false);
  assert.equal(dialog.doc.activeElement, dialog.close);
  release();
  assert.equal(dialog.listeners.size, 0);
});

test('trapFocus: only the most recently opened dialog handles Tab', () => {
  // One document, two stacked dialogs: both traps hear the same keydown.
  const lower = fakeDialog();
  const upper = fakeDialog(lower.doc);
  const releaseLower = trapFocus(lower.container);
  const releaseUpper = trapFocus(upper.container);
  lower.heading.focus();
  lower.press(true);
  assert.equal(lower.doc.activeElement, upper.confirm);
  releaseUpper();
  lower.heading.focus();
  lower.press(true);
  assert.equal(lower.doc.activeElement, lower.confirm);
  releaseLower();
});
