import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(path.join('src', 'host', 'platform', 'vscode', 'dashboardWebview.ts'), 'utf8');
const javaScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function open({ performance = false, mode = 1, testFlag = false, paths = path, extensionUri = 'extension:' } = {}) {
  let changed, reload, createdOptions, panelOptions, panelTitle;
  let now = 1000;
  const panel = {
    webview: { asWebviewUri: uri => uri, cspSource: 'webview:', onDidReceiveMessage() {} },
    onDidDispose() {},
  };
  const exports = {};
  const context = {
    extensionMode: mode, extensionUri, subscriptions: [], extension: { packageJSON: { version: 'test' } },
  };
  const vscode = {
    ExtensionMode: { Production: 1, Development: 2, Test: 3 }, ViewColumn: { One: 1 },
    Uri: { joinPath: (...parts) => paths.join(...parts) }, RelativePattern: class {},
    window: { createWebviewPanel(_type, title, _column, options) { now = 1050; panelTitle = title; panelOptions = options; return panel; } },
    workspace: { createFileSystemWatcher: () => ({ onDidChange: listener => { changed = listener; }, onDidCreate() {} }) },
  };
  runInNewContext(javaScript, {
    exports, process: { env: { PACKAGEAWY_EXTENSION_TEST: testFlag ? '1' : undefined } },
    Date: { now: () => now }, setTimeout: callback => { reload = callback; }, clearTimeout() {},
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:crypto') return { randomBytes: () => Buffer.from('nonce') };
      if (/[\\/]dashboardPanel\.js$/.test(name)) return { DashboardPanel: {
        reveal: () => false, create: (_platform, _channel, options) => { createdOptions = options; },
      } };
      if (/[\\/]openManifestTarget\.js$/.test(name)) return {};
      if (/[\\/]core[\\/]diagnostics\.js$/.test(name)) return { runtimeFailureLine: () => 'runtime: failed' };
      if (/[\\/]core[\\/]fireAndForget\.js$/.test(name)) return { fireAndForget() {} };
      throw new Error(name);
    },
  });
  exports.showDashboard(context, { getSetting: () => performance });
  return { panel, panelOptions, panelTitle, get options() { return createdOptions; }, rebuild() { changed(); reload(); } };
}

for (const paths of [path.posix, path.win32]) {
  test(`dashboard tab uses packaged theme icons with ${paths === path.win32 ? 'Windows' : 'POSIX'} paths`, () => {
    const extensionUri = paths.join(paths === path.win32 ? 'C:\\' : paths.sep, 'Extensions', 'Packageawy release');
    const view = open({ paths, extensionUri });
    assert.equal(view.panelTitle, 'Packageawy');
    assert.equal(view.panel.iconPath.light, paths.join(extensionUri, 'media', 'editor-tab.svg'));
    assert.equal(view.panel.iconPath.dark, paths.join(extensionUri, 'media', 'editor-tab_dark.svg'));
    assert.deepEqual(Array.from(view.panelOptions.localResourceRoots), [paths.join(extensionUri, 'dist')]);
  });
}

for (const [name, options, enabled] of [
  ['normal session', {}, false],
  ['performance debugging', { performance: true }, true],
  ['extension test mode', { mode: 3 }, true],
  ['integration runner flag', { testFlag: true }, true],
]) {
  test(`boot data enables render acknowledgements for ${name}: ${enabled}`, () => {
    const view = open(options);
    assert.match(view.panel.webview.html, new RegExp(`data-render-acknowledgements="${enabled}"`));
    assert.match(view.panel.webview.html, new RegExp(`data-performance-debug="${options.performance === true}"`));
    assert.equal(view.options.speculativeStartup, true, 'VS Code opts into startup at panel creation');
    assert.equal(view.options.createdAt, 1050, 'the timestamp is captured at native panel creation');
  });
}

test('a dev rebuild keeps integration render acknowledgements enabled without enabling performance logs', () => {
  const view = open({ mode: 2, testFlag: true });
  view.rebuild();
  assert.match(view.panel.webview.html, /data-render-acknowledgements="true"/);
  assert.match(view.panel.webview.html, /data-performance-debug="false"/);
});

test('JetBrains boot data opts into acknowledgements with its performance debugging setting', () => {
  const html = readFileSync(path.join('jetbrains', 'src', 'main', 'kotlin', 'io', 'github', 'azzamaldulaylan', 'packageawy', 'webview', 'WebviewHtml.kt'), 'utf8');
  assert.match(html, /data-render-acknowledgements="\$performanceDebug"/);
});
