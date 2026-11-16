import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { appHarness } from './helpers/app-harness.mjs';

const ready = () => ({ status: 'ready', data: {
  rows: [], generatedAt: 'bridge-ready-snapshot',
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  project: { id: 'app', label: 'app', manifestPath: 'package.json' }, canChangeProject: false,
  extensionVersion: 'test', builtAt: 'test', hygieneFindings: [],
} });

function assertRendered(view, message) {
  const dashboard = view.find('Dashboard');
  assert.ok(dashboard, 'The bridge message must reach the App and render the dashboard');
  assert.equal(dashboard.props.data.generatedAt, message.data.generatedAt);
  view.paint();
  assert.deepEqual(JSON.parse(JSON.stringify(view.sent.filter(m => m.type === 'rendered'))),
    [{ type: 'rendered', generatedAt: message.data.generatedAt }]);
  assert.equal(view.sent.some(m => m.type === 'unhandled-host-message'), false);
}

test('VS Code outer-frame delivery renders and acknowledges a ready snapshot', t => {
  const view = appHarness(t), message = ready();
  // pre/index.html forwards with target.contentWindow.postMessage(data.message,
  // window.origin, data.transfer). The sender is the outer frame, not the App window.
  const outerFrame = {};
  assert.notEqual(outerFrame, view.window);
  view.event(message, { source: outerFrame, origin: 'vscode-webview://fixture-id' });
  assertRendered(view, message);
});

test('the injected JetBrains receiver exact MessageEvent shape renders and acknowledges ready', async t => {
  const view = appHarness(t), message = ready();
  const kotlin = await readFile(new URL('../jetbrains/src/main/kotlin/io/github/azzamaldulaylan/packageawy/webview/WebviewHtml.kt', import.meta.url), 'utf8');
  // Execute the actual injected receiver, rather than duplicating its event
  // options in a fake. There is no JCEF browser-level test harness in this repo.
  const receiver = kotlin.match(/window\.__packageawyReceive = function \(message\) \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(receiver, 'JetBrains injected receiver must be executable by this contract test');
  let delivered;
  const window = { dispatchEvent(event) {
    delivered = event;
    view.event(event.data, { origin: event.origin, source: event.source });
  } };
  vm.runInNewContext(receiver, { window, MessageEvent });
  window.__packageawyReceive(message);
  assert.ok(delivered instanceof MessageEvent);
  assert.equal(delivered.origin, '');
  assert.equal(delivered.source, null);
  assertRendered(view, message);
});

test('a well-formed unknown status from an outer frame still pauses new changes', t => {
  const view = appHarness(t);
  view.event({ status: 'future-status' }, { origin: 'vscode-webview://fixture-id', source: {} });
  assert.equal(view.sent.filter(m => m.type === 'unhandled-host-message').length, 1);
});
