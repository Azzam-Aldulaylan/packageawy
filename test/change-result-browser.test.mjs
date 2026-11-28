import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { browserSkip } from './helpers/browser.mjs';

// Opt in with PACKAGEAWY_CHROMIUM_PATH pointing to a Chromium executable.
// CDP input uses browser hit testing, unlike JSDOM's element.click().
test('shared result keeps check statuses beside commands at narrow and wide widths', {
  skip: browserSkip('Set PACKAGEAWY_CHROMIUM_PATH to run rendered result layout checks'),
  timeout: 30_000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'packageawy-result-browser-'));
  const browser = spawn(process.env.PACKAGEAWY_CHROMIUM_PATH, [
    '--headless', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => browser.once('close', resolve));
  t.after(async () => {
    browser.kill('SIGKILL');
    await exited;
    await rm(profile, { recursive: true, force: true });
  });
  let nextId = 0;
  let buffer = '';
  const pending = new Map();
  const rejectPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  browser.on('error', rejectPending);
  browser.on('exit', (code, signal) => rejectPending(new Error(`Chromium exited: ${code ?? signal}`)));
  browser.stdio[3].on('error', rejectPending);
  browser.stdio[4].setEncoding('utf8');
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  async function send(method, params = {}, sessionId) {
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), 5_000);
        browser.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    assert.fail(`Browser condition not met: ${expression}`);
  }
  const bundle = await build({
    stdin: { contents: `import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChangeResult } from './webview/src/components/ChangeResult.tsx';
      const checks = [
        { id: 'install', kind: 'install', command: 'npm install', status: 'passed', exitCode: 0 },
        { id: 'test', kind: 'script', scriptName: 'test', command: 'npm run test', status: 'failed', exitCode: 1, terminalAvailable: true },
        { id: 'build', kind: 'script', scriptName: 'build', command: 'npm run build', status: 'not-run', reason: 'Stopped after an earlier failure.' },
        { id: 'long', kind: 'script', scriptName: 'a-very-long-project-check-name', command: 'npm run a-very-long-project-check-name', status: 'unknown' },
      ];
      createRoot(document.getElementById('root')).render(h(ChangeResult, { flow: 'Upgrade', headingId: 'result', title: 'Upgrade done with a warning', warning: true,
        summary: 'A project check failed. Changes were kept.', packages: [{ name: 'chalk', from: '4.1.2', to: '5.0.0' }], checks, facts: [] }));`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  });
  const css = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
  const themes = { dark: ['#1f1f1f', '#cccccc', '#a6a6a6', '#454545'], light: ['#ffffff', '#333333', '#616161', '#cccccc'], highContrast: ['#000000', '#ffffff', '#ffffff', '#ffffff'] };
  for (const width of [1100, 400, 240]) for (const [theme, [background, foreground, description, border]] of Object.entries(themes)) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    const html = `<!doctype html><style>${css}
      :root { --vscode-editor-background: ${background}; --vscode-editorWidget-background: ${background}; --vscode-foreground: ${foreground};
        --vscode-descriptionForeground: ${description}; --vscode-panel-border: ${border}; --vscode-contrastBorder: ${border}; --vscode-focusBorder: ${foreground};
        --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; --vscode-font-size: 13px;
        --vscode-editor-font-family: 'SFMono-Regular', Consolas, monospace; --vscode-button-background: ${theme === 'light' ? '#005fb8' : '#0078d4'};
        --vscode-button-foreground: #ffffff; --vscode-inputValidation-warningBorder: ${border}; --vscode-inputValidation-warningBackground: ${background}; }
      body { margin: 0; padding: 16px; } #root { width: 100%; max-width: 760px; margin: auto; }
      </style><div id="root" data-theme="${theme}" data-width="${width}"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
    const navigation = await command('Page.navigate', { url: 'about:blank' });
    assert.equal(navigation.errorText, undefined);
    await command('Page.setDocumentContent', { frameId: navigation.frameId, html });
    await waitFor(`document.querySelector('#root')?.dataset.theme === '${theme}' && document.querySelectorAll('.change-result__check').length === 4`);
    const metrics = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.change-result__check')];
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        rows: rows.map(row => {
          const label = row.querySelector('.change-result__check-label').getBoundingClientRect();
          const status = row.querySelector('.change-result__check-status').getBoundingClientRect();
          const badge = row.querySelector('.status-badge').getBoundingClientRect();
          const rect = row.getBoundingClientRect();
          return { labelTop: label.top, labelRight: label.right, statusTop: status.top, statusLeft: status.left, statusRight: status.right, badgeRight: badge.right, rowRight: rect.right, rowBottom: rect.bottom, statusBottom: status.bottom };
        }) };
    })()`);
    assert.equal(metrics.overflow, false, `${theme} at ${width}px does not overflow`);
    for (const row of metrics.rows) {
      if (width >= 400) {
        assert.ok(Math.abs(row.labelTop - row.statusTop) < 2, `${theme} at ${width}px keeps status beside its command`);
        assert.ok(row.statusLeft > row.labelRight, 'columns do not overlap');
      } else {
        assert.ok(row.statusTop > row.labelTop || row.statusLeft > row.labelRight, 'a status wraps when its columns cannot fit');
      }
      assert.ok(Math.abs(row.statusRight - row.badgeRight) < 2, 'badge stays right aligned');
      assert.ok(row.rowRight - row.statusRight < 16, 'status stays at the row right edge');
      assert.ok(row.statusBottom <= row.rowBottom, 'status remains inside its row');
    }
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    if (process.env.PACKAGEAWY_RESULT_SCREENSHOTS) {
      await writeFile(join(process.env.PACKAGEAWY_RESULT_SCREENSHOTS, `result-${theme}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
  }
});
