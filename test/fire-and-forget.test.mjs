/** fireAndForget: a background failure always reaches its handler, and the handler can never reject. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fireAndForget } from '../out/core/fireAndForget.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Fails the test if anything rejects without a handler while `run` is going. */
async function withoutUnhandledRejections(run) {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await run();
    await settle();
    await settle();
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(unhandled, [], 'nothing rejected unobserved');
}

function withConsoleError(replacement, run) {
  const original = console.error;
  console.error = replacement;
  return Promise.resolve(run()).finally(() => {
    console.error = original;
  });
}

test('a rejecting promise reaches the handler once', async () => {
  await withoutUnhandledRejections(async () => {
    const seen = [];
    const failure = new Error('boom');
    fireAndForget(Promise.reject(failure), (error) => {
      seen.push(error);
    });
    await settle();
    assert.deepEqual(seen, [failure]);
  });
});

test('a fulfilled promise never calls the handler', async () => {
  let called = false;
  fireAndForget(Promise.resolve('done'), () => {
    called = true;
  });
  await settle();
  assert.equal(called, false);
});

test('a bare thenable is observed like a promise', async () => {
  await withoutUnhandledRejections(async () => {
    const seen = [];
    const thenable = { then: (_onFulfilled, onRejected) => onRejected('thenable failure') };
    fireAndForget(thenable, (error) => {
      seen.push(error);
    });
    await settle();
    assert.deepEqual(seen, ['thenable failure']);
  });
});

test('a throwing handler is contained and reported without its message', async () => {
  const lines = [];
  await withConsoleError((line) => lines.push(String(line)), () => withoutUnhandledRejections(async () => {
    fireAndForget(Promise.reject(new Error('first')), () => {
      throw new Error('secret /home/user/.npmrc');
    });
    await settle();
  }));
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /secret|npmrc/);
});

test('a handler that returns a rejecting promise is contained', async () => {
  const lines = [];
  await withConsoleError((line) => lines.push(String(line)), () => withoutUnhandledRejections(async () => {
    // Cast through the type in real code; plain JavaScript here.
    fireAndForget(Promise.reject(new Error('first')), async () => {
      throw new Error('handler rejected');
    });
    await settle();
  }));
  assert.equal(lines.length, 1, 'the rejection was observed and reported once');
});

test('a throwing console is contained as well', async () => {
  await withConsoleError(() => {
    throw new Error('console is gone');
  }, () => withoutUnhandledRejections(async () => {
    fireAndForget(Promise.reject(new Error('first')), () => {
      throw new Error('handler failed');
    });
    fireAndForget(Promise.reject(new Error('second')), async () => {
      throw new Error('handler rejected');
    });
    await settle();
  }));
});
