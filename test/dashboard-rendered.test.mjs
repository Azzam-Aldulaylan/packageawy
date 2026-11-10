import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardPanel } from '../out/host/dashboardPanel.js';

globalThis.__BUILD_TIME__ = 'test';

function panel(t, integrationTestMode) {
  const store = { get: () => undefined, update: async () => {} };
  let receive, dispose;
  const posted = [];
  DashboardPanel.create({
    getSetting: (_, fallback) => fallback, globalState: store, workspaceState: store,
    onDidChangeSetting: () => ({ dispose() {} }),
  }, {
    postMessage: message => posted.push(message),
    onDidReceiveMessage: listener => { receive = listener; },
    onDidDispose: listener => { dispose = listener; },
  }, { extensionVersion: 'test', integrationTestMode, createdAt: 1234 });
  t.after(() => dispose());
  return { receive, posted, current: DashboardPanel.current };
}

test('the integration log records rendered as a separate inbound entry after the outbound snapshot', t => {
  const { receive, posted, current } = panel(t, true);
  current.sink.postMessage({ status: 'ready', data: { generatedAt: 'warm-snapshot', rows: [] } });
  const before = DashboardPanel.integrationTestSnapshot();
  assert.equal(before.panelCreatedAt, 1234);
  assert.equal(before.messages.at(-1).direction, 'outbound');
  const ack = { type: 'rendered', generatedAt: 'warm-snapshot' };
  const started = Date.now();
  receive(ack);
  const after = DashboardPanel.integrationTestSnapshot();
  const event = after.messages.at(-1);
  assert.equal(after.messages.length, before.messages.length + 1);
  assert.equal(event.direction, 'inbound');
  assert.deepEqual(event.message, ack);
  assert.equal(event.sequence, before.messages.at(-1).sequence + 1);
  assert.ok(event.at >= started);
  assert.equal(posted.length, before.messages.length, 'acknowledgements cause no host reply');
  receive({ ...ack, extra: true });
  assert.equal(DashboardPanel.integrationTestSnapshot().messages.length, after.messages.length);
});

test('outside integration mode rendered is ignored and creates no log or controller', async t => {
  const { receive, posted, current } = panel(t, false);
  receive({ type: 'rendered', generatedAt: 'snapshot' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted, []);
  assert.deepEqual(current.integrationTestMessages, []);
  assert.equal(current.controller, undefined);
  assert.throws(() => DashboardPanel.integrationTestSnapshot(), /only available/);
});
