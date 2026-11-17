import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'esbuild';

// Opt in with PACKAGEAWY_CHROMIUM_PATH pointing to a Chromium executable.
// CDP input uses browser hit testing, unlike JSDOM's element.click().
test('keyboard-focused security card still allows pointer help', {
  skip: !process.env.PACKAGEAWY_CHROMIUM_PATH && 'Set PACKAGEAWY_CHROMIUM_PATH to run rendered pointer checks',
  timeout: 30_000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'packageawy-summary-browser-'));
  const browser = spawn(process.env.PACKAGEAWY_CHROMIUM_PATH, [
    '--headless', '--no-first-run', '--no-default-browser-check',
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
    stdin: {
      contents: `import { createElement, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { SummaryCards } from './webview/src/components/SummaryCards.tsx';
        import { summaryMetrics } from './src/host/summaryMetrics.ts';
        function Harness() {
          const [selected, onSelect] = useState('all');
          return createElement(SummaryCards, { metrics: summaryMetrics([]),
            availability: { updates: 'complete', advisories: 'complete' }, selected, onSelect });
        }
        createRoot(document.getElementById('root')).render(createElement(Harness));`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  });
  const css = await readFile(join(process.cwd(), 'webview', 'src', 'styles.css'), 'utf8');
  const html = `<!doctype html><style>${css}</style><div id="root"></div>
    <script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
  for (const width of [1100, 400]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const page = html.replace('<div id="root">', `<div id="root" data-width="${width}">`);
    const navigation = await command('Page.navigate', { url: 'about:blank' });
    assert.equal(navigation.errorText, undefined, `Fixture navigation failed: ${navigation.errorText}`);
    assert.notEqual(navigation.isDownload, true, 'Fixture navigation unexpectedly started a download');
    await command('Page.setDocumentContent', { frameId: navigation.frameId, html: page });
    await waitFor(`document.querySelector('#root')?.dataset.width === '${width}' &&
      document.querySelectorAll('.summary-card').length === 4`);
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    for (let tab = 0; tab < 3; tab++) {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    }
    assert.equal(await evaluate(`document.activeElement.matches('[data-card="vulnerabilities"]:focus-visible')`), true);
    const point = await evaluate(`(() => {
      const trigger = document.querySelector('[aria-label="About security counts"]');
      const rect = trigger.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { x, y, reachable: trigger.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert.equal(point.reachable, true, `help must receive pointer input at width ${width}`);
    const { x, y } = point;
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await waitFor(`document.querySelector('[aria-label="About security counts"]').getAttribute('aria-expanded') === 'true'`);
    assert.equal(await evaluate(`document.activeElement.matches('[data-card="vulnerabilities"]:focus-visible')`), true);
    assert.equal(await evaluate(`document.querySelector('[role="tooltip"]').getBoundingClientRect().height > 0`), true);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    assert.equal(await evaluate(`document.querySelector('.summary-card[aria-pressed="true"]').dataset.card`), 'all');
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'About security counts');
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-expanded')`), 'true');
  }
});
