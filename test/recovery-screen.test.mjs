import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../out/host/webviewProtocol.js';
const require = createRequire(import.meta.url);
const hooks = { slots: [], cursor: 0, deps: [], effects: [] };
globalThis.__recoveryHooks = hooks;
const reactUrl = pathToFileURL(require.resolve('react')).href;
const bundle = await build({ entryPoints: ['webview/src/components/RecoveryScreen.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'recovery-hooks', setup(plugin) {
    plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'recovery' }));
    plugin.onLoad({ filter: /.*/, namespace: 'recovery' }, () => ({ loader: 'js', contents: `
      export * from '${reactUrl}';
      const h = globalThis.__recoveryHooks;
      export const useRef = initial => ({ current: initial });
      export const useState = initial => {
        const i = h.cursor++;
        if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
        return [h.slots[i], next => h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next];
      };
      export const useEffect = (effect, deps) => {
        const i = h.cursor++;
        if (!h.deps[i] || deps.some((v, j) => v !== h.deps[i][j])) { h.deps[i] = deps; h.effects.push(effect); }
      };
    ` }));
    plugin.onResolve({ filter: /^react\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    plugin.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
  } }] });
const { RecoveryScreen } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const file = { id: '11111111-1111-4111-8111-111111111111', path: 'package-lock.json', existed: false, backup: 'absent', current: 'a'.repeat(64), backupPreview: '', currentPreview: 'current lockfile', progress: 'moved but not restored' };
function fixture(state = 'blocked') {
  hooks.slots = []; hooks.deps = [];
  const sent = []; let closed = 0;
  const props = { recovery: { state, message: 'Recovery is open. Review each file.', claim: null, canApply: state === 'open', canDismiss: false, files: [file] },
    send(message) { assert.equal(isWebviewToHostMessage(message), true); sent.push(message); }, close() { closed++; } };
  const render = () => { hooks.cursor = 0; hooks.effects = []; let tree = RecoveryScreen(props); if (hooks.effects.length) { hooks.effects.forEach(effect => effect()); hooks.cursor = 0; hooks.effects = []; tree = RecoveryScreen(props); } return tree; };
  return { props, sent, render, closed: () => closed };
}
function all(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => all(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
}
const button = (tree, text) => all(tree, node => node.type === 'button' && node.props.children === text)[0];
const input = (tree, type) => all(tree, node => node.type === 'input' && node.props.type === type);

test('recovery requires stopped confirmation, including Keep current, and warns of the running-install race', () => {
  const f = fixture(); let tree = f.render();
  const html = renderToStaticMarkup(tree);
  assert.match(html, /A running command could change files while they are being restored/);
  assert.match(html, /Check the task terminals in every editor/);
  assert.match(html, /other recovery sessions have stopped/);
  assert.equal(button(tree, 'Start recovery').props.disabled, true);
  input(tree, 'checkbox')[0].props.onChange({ target: { checked: true } }); tree = f.render();
  button(tree, 'Start recovery').props.onClick();
  assert.deepEqual(f.sent, [{ type: 'start-recovery', stopped: true, claim: null }]);
});

test('Keep current is the per-file default, and deletion approval is separate from Restore backup', () => {
  const f = fixture('open'); let tree = f.render();
  assert.deepEqual(input(tree, 'radio').map(node => node.props.checked), [true, false]);
  assert.match(renderToStaticMarkup(tree), /current lockfile/);
  assert.equal(input(tree, 'checkbox').length, 0);
  input(tree, 'radio')[1].props.onChange(); tree = f.render();
  assert.equal(button(tree, 'Apply file choices').props.disabled, true);
  input(tree, 'checkbox')[0].props.onChange({ target: { checked: true } }); tree = f.render();
  assert.equal(button(tree, 'Apply file choices').props.disabled, false);
  button(tree, 'Apply file choices').props.onClick();
  assert.deepEqual(f.sent[0].choices, [{ id: file.id, current: file.current, action: 'restore', approveDeletion: true }]);
});

test('reopening only shows progress, closing is separate, and incomplete dismissal requires approval', () => {
  const f = fixture('incomplete'); f.props.recovery.canDismiss = true; f.props.recovery.canApply = true;
  let tree = f.render();
  assert.match(renderToStaticMarkup(tree), /moved but not restored/);
  assert.deepEqual(f.sent, [], 'rendering does not resume saved choices');
  assert.ok(button(tree, 'Apply file choices'));
  assert.equal(button(tree, 'Confirm delete backup'), undefined);
  button(tree, 'Delete backup without restoring').props.onClick(); tree = f.render();
  assert.equal(button(tree, 'Confirm delete backup').props.disabled, true);
  input(tree, 'checkbox')[0].props.onChange({ target: { checked: true } }); tree = f.render();
  button(tree, 'Confirm delete backup').props.onClick();
  assert.deepEqual(f.sent, [{ type: 'dismiss-recovery', stopped: true, discardIncomplete: true }]);
  const next = fixture('completed'); next.props.recovery.canDismiss = true; tree = next.render();
  button(tree, 'Keep the backup for later').props.onClick();
  assert.equal(next.closed(), 1); assert.deepEqual(next.sent, []);
  assert.match(renderToStaticMarkup(tree), /Dependency changes stay paused until this backup is resolved/);
});

test('discovery failure offers a read-only retry without stopped confirmation or recovery actions', () => {
  const f = fixture('discovery-error');
  f.props.recovery.files = [];
  f.props.recovery.message = 'Could not check for backups. Retry discovery or Refresh.';
  assert.equal(isHostToWebviewMessage({ status: 'recovery', recovery: f.props.recovery }), true);
  const tree = f.render();
  assert.match(renderToStaticMarkup(tree), /Retry discovery or Refresh/);
  assert.equal(button(tree, 'Start recovery'), undefined);
  assert.equal(input(tree, 'checkbox').length, 0);
  button(tree, 'Retry discovery').props.onClick();
  assert.deepEqual(f.sent, [{ type: 'inspect-recovery' }]);
  assert.equal(button(f.render(), 'Retry discovery').props.disabled, true);
});

test('undo review explains its limits and keeps further changes available until claimed', () => {
  const f = fixture('undo-available');
  const tree = f.render();
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Restore the backed up dependency files to undo this change/);
  assert.match(html, /Restoring puts package.json and the lockfile back. It does not undo script side effects/);
  assert.match(html, /The next change replaces this backup/);
  assert.ok(button(tree, 'Review backup'));
  assert.doesNotMatch(html, /Start recovery|Dependency changes stay paused/);
});

test('the undo review keeps its title after claiming the backup', () => {
  const f = fixture('undo-available');
  f.render();
  f.props.recovery = { ...f.props.recovery, state: 'open', canApply: true };
  const html = renderToStaticMarkup(f.render());
  assert.match(html, />Undo cleanup<\/h1>/);
  assert.doesNotMatch(html, /Dependency recovery/);
});

test('Undo defaults to restore but still requires approval to remove a file created by the change', () => {
  const f = fixture('open'); f.props.recovery.undoOperation = 'cleanup';
  let tree = f.render();
  assert.deepEqual(input(tree, 'radio').map(node => node.props.checked), [false, true]);
  assert.equal(button(tree, 'Restore all files').props.disabled, true);
  assert.equal(button(tree, 'Apply file choices').props.disabled, true);
  input(tree, 'checkbox')[0].props.onChange({ target: { checked: true } }); tree = f.render();
  assert.equal(button(tree, 'Restore all files').props.disabled, false);
  button(tree, 'Restore all files').props.onClick();
  assert.deepEqual(f.sent[0].choices, [{ id: file.id, current: file.current, action: 'restore', approveDeletion: true }]);
});
