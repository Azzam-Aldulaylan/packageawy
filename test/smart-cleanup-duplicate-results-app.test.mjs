import assert from 'node:assert/strict';
import test from 'node:test';
import { appHarness } from './helpers/app-harness.mjs';

for (const metadataFirst of [true, false]) test(`duplicate cleanup results preserve review selection with metadata first ${metadataFirst}`, t => {
  const view = appHarness(t);
  const names = ['lodash', 'react'];
  view.event({ status: 'ready', data: {
    rows: names.map(name => ({ name, current: '1.0.0', range: '^1.0.0', wanted: '1.0.0', latest: '1.0.0',
      dev: false, optional: false, advisories: [], worstSeverity: null, upgradeTo: null, upgradeReason: null })),
    generatedAt: 'before', availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] },
    project: { id: 'project', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
    extensionVersion: 'test', builtAt: 'test', hygieneFindings: [],
  } });
  view.find('Dashboard').props.onOpenSmartCleanup();
  view.render();
  const requestId = view.sent.findLast(m => m.type === 'analyze-smart-cleanup-metadata').requestId;
  const result = { status: 'cleanup-result', analyzedAt: new Date().toISOString(),
    cacheExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    findings: names.map(packageName => ({ packageName, kind: 'likely-unused', confidence: 'high', severity: 'info',
      summary: 'No usage found.', evidence: { kind: 'likely-unused', reason: 'No usage found.', scannedFileCount: 1, truncated: false } })),
  };
  const metadata = { status: 'smart-cleanup-metadata-result', requestId, findings: [], unavailablePackages: [], capability: { executionSupported: true } };
  view.event(result);
  const impact = view.sent.findLast(m => m.type === 'analyze-removal-impact');
  if (metadataFirst) view.event(metadata);
  view.event(structuredClone(result));
  view.event({ status: 'removal-impact-result', requestId: impact.requestId, packages: names, generatedAt: new Date().toISOString(),
    assessments: names.map(packageName => ({ packageName, usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } })),
  });
  if (!metadataFirst) view.event(metadata);
  const workspace = () => view.find('SmartCleanupWorkspace').props;
  assert.equal(workspace().state.phase, 'ready');
  workspace().dispatch({ type: 'toggle-safe-action', actionId: 'remove-direct:react' });
  view.render();
  assert.deepEqual([...workspace().state.selectedActionIds], ['remove-direct:lodash']);
  const selected = workspace().state.selectedActionIds;
  const sent = view.sent.length;
  view.event(structuredClone(result));
  view.event(metadata);
  view.event({ status: 'removal-impact-result', requestId: impact.requestId, packages: names, generatedAt: new Date().toISOString(),
    assessments: names.map(packageName => ({ packageName, usageId: 'usage', assessment: { status: 'low-risk', evidence: [] } })),
  });
  assert.equal(workspace().state.selectedActionIds, selected);
  assert.equal(view.sent.length, sent);
  for (const type of ['analyze-cleanup', 'analyze-smart-cleanup-metadata', 'analyze-removal-impact']) {
    assert.equal(view.sent.filter(m => m.type === type).length, 1, type);
  }
});
