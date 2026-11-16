import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './helpers/app-harness.mjs';
import { panel } from './helpers/dashboard-startup.mjs';

const bannerText = 'Packageawy received something it did not understand';
function blocked(view) {
  return view.elements().find(e => e.props?.value && 'blocked' in e.props.value).props.value.blocked;
}
function open(view) { view.find('Dashboard').props.onOpenManage('clean-pkg'); view.render(); }
function target(view) { return view.find('ManageDependencyModal').props.upgrade; }
function targets(view) {
  const request = view.sent.filter(m => m.type === 'load-upgrade-targets').at(-1);
  view.event({ status: 'upgrade-targets', package: request.package, requestId: request.requestId, targets: {
    options: ['1.5.0', '2.0.0'].map(version => ({ version, labels: [], channel: 'stable' })),
    recommendedVersion: '2.0.0', truncated: false,
  } });
}
async function fixture(t, projects = ['a']) {
  const host = await panel(t, { early: false, projects });
  host.gate.resolve();
  host.current.requestAutomaticUsageRefresh = () => {};
  const view = appHarness(t);
  let delivered = 0;
  const deliver = (mounted = view) => {
    for (const message of host.posted.slice(delivered)) mounted.event(message);
    delivered = host.posted.length;
  };
  await host.ready(); deliver();
  return { host, view, deliver };
}

// Real App remount and real host ready dispatch must both recover. Testing
// either fence alone would allow the other to leave changes permanently paused.
test('Reload remount against a consistent host clears both protocol fences and permits changes', async t => {
  const { host, view, deliver } = await fixture(t);
  view.event({ status: 'future-status' });
  await host.current.handle(view.sent.at(-1));
  assert.equal(blocked(view), true);
  let changes = 0;
  host.current.upgradeCoordinator.handleConfirmRemove = async () => { changes++; };
  await host.current.handle({ type: 'confirm-remove', analysisId: 'review' });
  assert.equal(changes, 0, 'the host rejects a stale client while fenced');
  const reload = view.elements().find(e => e.type === 'button' && e.props.children === 'Reload');
  assert.equal(reload.props.disabled, false);
  reload.props.onClick();
  assert.equal(view.reloads, 1);
  view.unmount();
  const remounted = appHarness(t);
  assert.equal(remounted.sent[0].type, 'ready');
  await host.current.handle(remounted.sent[0]); deliver(remounted);
  assert.equal(blocked(remounted), false);
  assert.equal(remounted.elements().some(e => e.props?.children?.includes?.(bannerText)), false);
  open(remounted);
  assert.equal(remounted.find('ManageDependencyModal').props.upgradeDisabled, false);
  await host.current.handle({ type: 'confirm-remove', analysisId: 'review' });
  assert.equal(changes, 1, 'ready from the new mount also releases the host fence');
});

async function branch(host) {
  host.current.onGitHeadChanged();
  await host.current.reconcileAfterGitHeadChange(host.current.branchChangeCoordinator.generation);
}

test('a branch change that replaces the selected project clears its chosen target', async t => {
  const projects = ['a', 'b'];
  const { host, view, deliver } = await fixture(t, projects);
  open(view); targets(view);
  target(view).onTargetChange('1.5.0'); view.render();
  assert.equal(target(view).targetVersion, '1.5.0');
  const previousProject = view.find('Dashboard').props.data.project.id;
  projects.splice(0, 1); // The selected manifest is absent from the new HEAD.
  await branch(host); deliver();
  assert.notEqual(view.find('Dashboard').props.data.project.id, previousProject);
  assert.equal(view.find('ManageDependencyModal'), undefined);
  open(view); targets(view);
  assert.notEqual(target(view).targetVersion, '1.5.0');
});

test('project removal clears the chosen target even if the same project later returns', async t => {
  const projects = ['a'];
  const { host, view, deliver } = await fixture(t, projects);
  open(view); targets(view);
  target(view).onTargetChange('1.5.0'); view.render();
  assert.equal(target(view).targetVersion, '1.5.0');
  projects.length = 0;
  await branch(host); deliver();
  assert.equal(host.current.controller, undefined);
  assert.equal(host.posted.at(-1).error.code, 'NoProjectFoundOnBranchError');
  assert.equal(view.find('ManageDependencyModal'), undefined);
  projects.push('a');
  await host.refresh(); deliver();
  open(view); targets(view);
  assert.notEqual(target(view).targetVersion, '1.5.0');
});
