import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as React from 'react';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ['webview/src/App.tsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'hooks', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hooks' }));
    builder.onLoad({ filter: /.*/, namespace: 'hooks' }, () => ({ contents: 'module.exports = globalThis.__react;' }));
  } }],
});

/** Executes the real App and its effects. Child props stay inspectable as React elements. */
export function appHarness(t) {
  let cursor = 0, dirty = false, tree, reloads = 0;
  const slots = [], effects = [], sent = [], listeners = new Map();
  const frames = new Map();
  let frameId = 0;
  const changed = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, update => {
        const next = typeof update === 'function' ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useReducer(reducer, initial, init) {
      const [value, set] = hooks.useState(() => init ? init(initial) : initial);
      return [value, action => set(previous => reducer(previous, action))];
    },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useMemo(factory, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const window = {
    location: { origin: 'https://webview.test', reload: () => reloads++ },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  const module = { exports: {} };
  const warnings = [];
  const context = vm.createContext({
    module, exports: module.exports, require, __react: { ...React, ...hooks },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    window, document: { body: { dataset: {} } }, performance, setTimeout, clearTimeout,
    console: { ...console, warn: (...args) => warnings.push(args) },
    acquireVsCodeApi: () => ({ postMessage: message => sent.push(message), getState() {}, setState() {} }),
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 30, 'App effects settled');
      cursor = 0; dirty = false;
      tree = module.exports.App();
      while (effects.length) effects.shift()();
    } while (dirty);
    return tree;
  }
  let mounted = true;
  function unmount() {
    if (!mounted) return;
    mounted = false;
    for (const slot of slots) slot?.cleanup?.();
  }
  t.after(unmount);
  render();
  function collect(node) {
    if (node == null || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(collect);
    return [node, ...collect(node.props?.children)];
  }
  return {
    sent, warnings, window, render, unmount, elements: () => collect(tree),
    get tree() { return tree; }, get reloads() { return reloads; },
    find: name => collect(tree).find(element => element.type?.name === name),
    event(data, props = {}) { listeners.get('message')({ data, origin: '', source: null, ...props }); render(); },
    paint() {
      for (let frame = 0; frame < 2; frame++) {
        const pending = [...frames.values()]; frames.clear();
        pending.forEach(callback => callback());
      }
      render();
    },
  };
}
