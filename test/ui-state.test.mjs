import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './helpers/app-harness.mjs';

const text = 'Packageawy received something it did not understand';
const row = name => ({ name, current: '1.0.0', range: '^1.0.0', wanted: '1.0.1', latest: '2.0.0', dev: false, optional: false,
  advisories: [], worstSeverity: null, upgradeTo: '2.0.0', upgradeReason: 'update' });
export const snapshot = (id = 'project-a', generatedAt = 'first') => ({ status: 'ready', data: {
  rows: [row('alpha'), row('beta')], availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
  generatedAt, project: { id, label: id, manifestPath: 'package.json' }, canChangeProject: true,
  extensionVersion: 'test', builtAt: 'test', hygieneFindings: [],
} });
function open(view, name) { view.find('Dashboard').props.onOpenManage(name); view.render(); }
function targets(view, versions = ['1.5.0', '2.0.0']) {
  const request = view.sent.filter(m => m.type === 'load-upgrade-targets').at(-1);
  view.event({ status: 'upgrade-targets', package: request.package, requestId: request.requestId, targets: {
    options: versions.map(version => ({ version, labels: [], channel: 'stable' })),
    recommendedVersion: '2.0.0', truncated: false,
  } });
}
function upgrade(view) { return view.find('ManageDependencyModal').props.upgrade; }

test('chosen target survives same-project refresh and retry', t => {
  const view = appHarness(t); view.event(snapshot()); open(view, 'alpha'); targets(view);
  upgrade(view).onTargetChange('1.5.0'); view.render();
  assert.equal(upgrade(view).targetVersion, '1.5.0');
  view.event(snapshot('project-a', 'second')); targets(view);
  assert.equal(upgrade(view).targetVersion, '1.5.0');
  upgrade(view).onRetryTargets(); view.render(); targets(view);
  assert.equal(upgrade(view).targetVersion, '1.5.0');
});

test('refresh clears a chosen target that is no longer eligible', t => {
  const view = appHarness(t); view.event(snapshot()); open(view, 'alpha'); targets(view);
  upgrade(view).onTargetChange('1.5.0'); view.render();
  view.event(snapshot('project-a', 'second')); targets(view, ['2.0.0']);
  assert.equal(upgrade(view).targetVersion, null);
});

test('switching package or project clears the previous explicit target', t => {
  const view = appHarness(t); view.event(snapshot()); open(view, 'alpha'); targets(view);
  upgrade(view).onTargetChange('1.5.0'); view.render();
  open(view, 'beta'); targets(view);
  assert.equal(upgrade(view).targetVersion, '2.0.0');
  upgrade(view).onTargetChange('1.5.0'); view.render();
  view.event(snapshot('project-b', 'first')); open(view, 'beta'); targets(view);
  assert.equal(upgrade(view).targetVersion, '2.0.0');
});

test('unknown host messages preserve the dashboard, show one banner and block new changes without success or rollback', t => {
  const view = appHarness(t); view.event(snapshot());
  const before = view.find('Dashboard').props.data;
  const start = view.sent.length;
  view.event({ status: 'future-status', token: 'secret', file: '/Users/private/app/package.json', contents: 'private' });
  view.event({ status: 'another-future-status' });
  assert.equal(view.find('Dashboard').props.data, before);
  assert.equal(view.elements().filter(e => e.props?.children?.includes?.(text)).length, 1);
  assert.equal(view.elements().find(e => e.props?.value && 'blocked' in e.props.value)?.props.value.blocked, true);
  assert.deepEqual(JSON.parse(JSON.stringify(view.sent.slice(start))), [{ type: 'unhandled-host-message' }]);
  const banner = view.find('StatusBanner');
  assert.equal(banner.props.action.label, 'Show Log'); banner.props.action.onClick();
  const reload = view.elements().find(e => e.type === 'button' && e.props.children === 'Reload');
  assert.equal(reload.props.disabled, false); reload.props.onClick(); assert.equal(view.reloads, 1);
  assert.equal(view.sent.at(-1).type, 'show-log');
  view.event(snapshot('project-a', 'second'));
  assert.equal(view.elements().find(e => e.props?.value && 'blocked' in e.props.value)?.props.value.blocked, true);
});

for (const state of ['running', 'still-running']) {
  test(`unknown message keeps Reload disabled while dependency task is ${state}`, t => {
    const view = appHarness(t); view.event(snapshot()); view.event({ status: 'dependency-task', state });
    view.event({ status: 'future-status' });
    assert.equal(view.elements().find(e => e.type === 'button' && e.props.children === 'Reload').props.disabled, true);
    view.event({ status: 'dependency-task', state: 'idle' });
    assert.equal(view.elements().find(e => e.type === 'button' && e.props.children === 'Reload').props.disabled, false);
  });
}

test('malformed events from any source are ignored quietly without a banner or blocked changes', t => {
  const view = appHarness(t); view.event(snapshot(), { origin: 'https://webview.test', source: view.window }); const before = view.tree, count = view.sent.length;
  for (const [data, props] of [
    [{ type: 'foreign-message' }, { origin: 'https://foreign.test', source: {} }],
    [{ status: 'bad status' }, { origin: view.window.location.origin, source: {} }],
    [{ status: '\nfuture-status' }, {}], [{ status: 'x'.repeat(129) }, {}],
    [null, {}], [{}, {}], [{ status: 4 }, {}], [{ status: '' }, {}],
    [{ status: 'ready', data: {} }, {}], [{ status: 'dependency-task', state: 'bogus' }, {}],
  ]) view.event(data, props);
  assert.equal(view.sent.length, count); assert.equal(view.warnings.length, 0);
  assert.equal(view.elements().some(e => e.props?.children?.includes?.(text)), false);
  assert.equal(view.elements().find(e => e.props?.value && 'blocked' in e.props.value)?.props.value.blocked, false);
  assert.equal(view.tree.type, before.type);
});

test('the unknown-message banner stays visible in recovery and prevents applying dependency file choices', t => {
  const view = appHarness(t); view.event(snapshot());
  view.event({ status: 'recovery', recovery: { state: 'open', message: 'Review saved files', files: [], claim: null, canApply: true, canDismiss: false } });
  view.elements().find(e => e.props?.value && 'blocked' in e.props.value).props.value.openRecovery(); view.render();
  assert.ok(view.find('RecoveryScreen'));
  view.event({ status: 'future-status' });
  assert.ok(view.find('StatusBanner'));
  assert.equal(view.find('RecoveryScreen').props.changesBlocked, true);
  assert.equal(view.find('RecoveryScreen').props.recovery.message, 'Review saved files');
});
