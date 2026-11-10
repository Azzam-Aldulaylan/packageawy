import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync('webview/src/snapshotRender.ts', 'utf8');
const javaScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { createSnapshotRenderTracker } = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
);

function webview(enabled = true) {
  let nextId = 1;
  const pending = new Map();
  const messages = [];
  const frames = {
    request: callback => { const id = nextId++; pending.set(id, callback); return id; },
    cancel: id => pending.delete(id),
  };
  const mount = () => createSnapshotRenderTracker(enabled, message => messages.push(message), frames);
  return {
    messages, mount, schedule: mount(),
    frame() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    get pendingCount() { return pending.size; },
  };
}

test('a committed snapshot is acknowledged after its second frame, once per distinct generatedAt', () => {
  const view = webview();
  let measured = 0;
  view.schedule('first', () => measured++);
  assert.deepEqual(view.messages, []);
  view.frame();
  assert.deepEqual(view.messages, []);
  assert.equal(measured, 0);
  view.frame();
  assert.deepEqual(view.messages, [{ type: 'rendered', generatedAt: 'first' }]);
  assert.equal(measured, 1);
  for (const generatedAt of ['first', 'second', 'first']) {
    view.schedule(generatedAt);
    view.frame(); view.frame();
  }
  assert.deepEqual(view.messages.map(message => message.generatedAt), ['first', 'second']);
});

for (const elapsedFrames of [0, 1]) {
  test(`cleanup cancels a superseded snapshot after ${elapsedFrames} frames`, () => {
    const view = webview();
    let measured = false;
    const cleanup = view.schedule('superseded', () => { measured = true; });
    if (elapsedFrames === 1) view.frame();
    cleanup();
    assert.equal(view.pendingCount, 0);
    view.schedule('replacement');
    view.frame(); view.frame();
    assert.equal(measured, false);
    assert.deepEqual(view.messages, [{ type: 'rendered', generatedAt: 'replacement' }]);
    view.schedule('superseded');
    view.frame(); view.frame();
    assert.equal(view.messages.at(-1).generatedAt, 'superseded', 'cancellation does not mark a snapshot acknowledged');
  });
}

test('a webview reload acknowledges a warm replay with its original generatedAt again', () => {
  const view = webview();
  const generatedAt = '2020-01-01T00:00:00.000Z';
  view.schedule(generatedAt);
  view.frame(); view.frame();
  const reloaded = view.mount();
  reloaded(generatedAt);
  view.frame(); view.frame();
  assert.deepEqual(view.messages, [
    { type: 'rendered', generatedAt }, { type: 'rendered', generatedAt },
  ]);
});

test('the flag disables acknowledgements while keeping the existing render measurement', () => {
  const view = webview(false);
  view.schedule('silent');
  assert.equal(view.pendingCount, 0);
  let measured = false;
  view.schedule('measured', () => { measured = true; });
  view.frame(); view.frame();
  assert.equal(measured, true);
  assert.deepEqual(view.messages, []);
});
