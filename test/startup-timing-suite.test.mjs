import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const completion = require('../scripts/performance/startup-timing-completion.cjs');
const suite = readFileSync('scripts/performance/startup-timing-suite.cjs', 'utf8');

test('the startup suite waits for the webview and writes panel, paint and existing host metrics', async () => {
  let now = 1000, report, opened = false, closedAt;
  const generatedAt = '2020-01-01T00:00:00.000Z';
  const messages = [
    { at: 1100, direction: 'outbound', message: { status: 'ready', data: { generatedAt, rows: [{}] } } },
    { at: 1200, direction: 'outbound', message: { status: 'cleanup-result' } },
    { at: 1300, direction: 'inbound', message: { type: 'rendered', generatedAt } },
  ];
  const exports = {};
  const api = { dashboard: { snapshot: () => ({ panelCreatedAt: 1050, messages: messages.filter(event => event.at <= now) }) } };
  const context = {
    module: { exports }, Date: { now: () => now },
    process: { uptime: () => 1, env: { PACKAGEAWY_TIMING_EXTENSION_ID: 'test', PACKAGEAWY_TIMING_REPORT: 'report.json' } },
    console: { debug() {}, log() {}, info() {} },
    setTimeout(callback, ms) {
      now += ms;
      callback();
    },
    require(name) {
      if (name === './completion.js') return completion;
      if (name === 'node:fs/promises') return { writeFile: async (_path, json) => { report = JSON.parse(json); } };
      if (name === 'vscode') return {
        version: 'test', extensions: { getExtension: () => ({ isActive: true, activate: async () => api }) },
        workspace: { getConfiguration: () => ({ get: () => true }) },
        commands: { async executeCommand(command) {
          if (command === 'perfview.show') throw new Error('No startup performance document in this fixture');
          if (command === 'packageawy.open') {
            opened = true;
            context.console.debug('Packageawy cache\nTotal 1.0 ms\nhit=true  freshness=fresh');
            context.console.debug('Packageawy cleanup usage analysis\nTotal 1.0 ms');
          }
          if (command === 'workbench.action.closeActiveEditor') closedAt = now;
        } },
      };
      throw new Error(name);
    },
  };
  runInNewContext(suite, context);
  await context.module.exports.run();
  assert.equal(opened, true);
  assert.equal(closedAt, 1300, 'the host result and usage completion alone do not close the panel');
  assert.equal(report.ok, true);
  assert.equal(report.scan.openToPanelCreatedMs, 50);
  assert.equal(report.scan.openToFirstRowsMs, 100);
  assert.equal(report.scan.openToPaintedRowsMs, 300);
  assert.equal(report.scan.openToScanResultMs, 100);
  assert.equal(report.scan.openToCompleteMs, 300);
  assert.deepEqual(report.scan.statuses, ['ready', 'cleanup-result']);
});
