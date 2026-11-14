import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Keep the real App message handler and callbacks. Replace only the hook
// scheduler so state transitions can run without an editor or a DOM renderer.
const hooks = { slots: [], cursor: 0, writes: [], effects: [],
  state(initial) {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [this.slots[index], value => {
      this.writes.push(index);
      this.slots[index] = typeof value === 'function' ? value(this.slots[index]) : value;
    }];
  }, ref(initial) {
    const index = this.cursor++;
    return this.slots[index] ??= { current: initial };
  } };
globalThis.__updateWarningHooks = hooks;
globalThis.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
let receive;
globalThis.window = { addEventListener: (event, listener) => { if (event === 'message') receive = listener; }, removeEventListener() {} };
globalThis.document = { body: { dataset: {} } };
const require = createRequire(import.meta.url);
const reactUrl = pathToFileURL(require.resolve('react')).href;
const bundle = await build({ entryPoints: ['webview/src/App.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'hook-scheduler', setup(plugin) {
    plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'test' }));
    plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ loader: 'js', contents: `
      export * from '${reactUrl}';
      const hooks = globalThis.__updateWarningHooks;
      export const useState = initial => hooks.state(initial);
      export const useRef = initial => hooks.ref(initial);
      export const useMemo = fn => fn();
      export const useCallback = fn => fn;
      export const useEffect = fn => { hooks.effects.push(fn); };
      export const useReducer = (reducer, initial) => { const [value, set] = hooks.state(initial); return [value, action => set(value => reducer(value, action))]; };
    ` }));
    plugin.onResolve({ filter: /^react\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    plugin.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
  } }] });
const { App } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function render() { hooks.cursor = 0; hooks.effects = []; return App(); }
function findProp(tree, prop) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (Array.isArray(tree)) return tree.map(child => findProp(child, prop)).find(value => value !== undefined);
  return tree.props?.[prop] ?? findProp(tree.props?.children, prop);
}
const context = { scanId: 1, projectId: 'fixture', sourceGeneration: 1, settingsGeneration: 0 };
const results = [{ name: 'app', version: '2.0.0', status: 'checked', count: 1, highestSeverity: 'high' }];
const data = { rows: [{ name: 'app', current: '1.0.0', latest: '2.0.0', wanted: '1.1.0', upgradeTo: '2.0.0', upgradeReason: 'update',
  dev: false, optional: false, range: '^1', advisories: [], worstSeverity: null }],
  project: { id: 'fixture', label: 'fixture', manifestPath: 'package.json' }, canChangeProject: false,
  availability: { updates: 'complete', advisories: 'complete', unavailableUpdatePackages: [] }, generatedAt: new Date().toISOString(),
  hygieneFindings: [], extensionVersion: 'test', builtAt: 'test', updateAdvisoryContext: context };

test('enrichment preserves open dialogs, reviews, picker selection and all other App state', () => {
  render();
  hooks.effects.find(effect => effect.toString().includes('addEventListener("message"'))();
  assert.equal(typeof receive, 'function');
  receive({ origin: '', source: null, data: { status: 'ready', data } });
  let tree = render();
  findProp(tree, 'onOpenManage')('app');
  tree = render();
  const upgrade = findProp(tree, 'upgrade');
  assert.equal(typeof upgrade.onAnalyze, 'function');
  upgrade.onAnalyze('2.0.0');
  tree = render();
  const selectTarget = findProp(tree, 'upgrade').onTargetChange;
  selectTarget('1.9.0');
  tree = render();
  assert.equal(findProp(tree, 'upgrade').targetVersion, '1.9.0');
  const before = [...hooks.slots];
  hooks.writes = [];
  receive({ origin: '', source: null, data: { status: 'update-advisories', context, results } });
  assert.deepEqual([...new Set(hooks.writes)], [0], 'only dashboard facts change');
  assert.deepEqual(hooks.slots[0].data.updateAdvisories, results);
  before.slice(1).forEach((value, index) => assert.equal(hooks.slots[index + 1], value));
  assert.equal(hooks.slots[0].data.generatedAt, data.generatedAt);
  for (const [field, value] of [['scanId', 2], ['projectId', 'other'], ['sourceGeneration', 2], ['settingsGeneration', 1]]) {
    const current = hooks.slots[0];
    receive({ origin: '', source: null, data: { status: 'update-advisories', context: { ...context, [field]: value }, results: [] } });
    assert.equal(hooks.slots[0], current, `stale ${field} is ignored`);
  }
  hooks.slots[0] = { status: 'ready', data: { ...data, availability: { ...data.availability, advisories: 'off' } } };
  const off = hooks.slots[0];
  receive({ origin: '', source: null, data: { status: 'update-advisories', context, results } });
  assert.equal(hooks.slots[0], off, 'Off never accepts warning results');
});
