import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const component = readFileSync(
  join(process.cwd(), 'webview/src/components/UpgradeTargetSelector.tsx'),
  'utf8'
);

test('the target selector is registry-backed and has no free-text version entry', () => {
  assert.match(component, /<select/);
  assert.match(component, /optgroup label="Stable releases"/);
  assert.match(component, /optgroup label="Prereleases \(review carefully\)"/);
  assert.match(component, /onChange=\{\(event\) => onChange\(event\.currentTarget\.value\)\}/);
  assert.doesNotMatch(component, /Enter another version|Exact published version|manualVersion|<input/);
  assert.doesNotMatch(component, /onAnalyzeUpgrade/);
});

test('target labels distinguish publisher-declared LTS from the latest stable fallback', () => {
  assert.match(component, /return 'Publisher LTS'/);
  assert.match(component, /return 'Latest stable'/);
  assert.match(component, /Starts on the version shown on the dashboard/);
  assert.match(component, /return 'Security fix'/);
  assert.doesNotMatch(component, /return 'LTS'/);
});

test('loading published choices preserves the row target and explicit picker choices', () => {
  const app = readFileSync(join(process.cwd(), 'webview/src/App.tsx'), 'utf8');
  assert.match(app, /setSelectedManageTarget\(row\.upgradeTo\)/);
  const choicesArrived = app.slice(app.indexOf("if (incoming.status === 'upgrade-targets')"), app.indexOf("if (incoming.status === 'upgrade-targets-error')"));
  assert.doesNotMatch(choicesArrived, /setSelectedManageTarget/);
});
