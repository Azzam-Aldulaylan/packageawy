/**
 * The vulnerability-check queue for offered versions must never stall: one
 * job that throws (for example a publish that fails) used to reject the
 * shared queue, so every later check silently skipped its work.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateAdvisories } from '../out/host/updateAdvisories.js';

const ok = () => ({ status: 200, headers: {}, body: '{}', wireBytes: 2 });
function memory(report) {
  let posts = 0;
  const m = new UpdateAdvisories({ post: async () => { posts += 1; return ok(); } }, () => true, report);
  return { m, posts: () => posts };
}
const pair = (version) => [{ name: 'pkg', version }];

test('a publish that throws does not stop later checks, and its result stays owed', async () => {
  const reported = [];
  const { m, posts } = memory((error) => reported.push(error));
  await m.enrich(pair('1.0.0'), () => true, () => { throw new Error('post failed'); });
  assert.equal(reported.length, 1, 'the failure is reported, not thrown');
  // Same version again: already checked, so no new request, but still owed to whoever asks.
  const retried = [];
  await m.enrich(pair('1.0.0'), () => true, (r) => retried.push(r));
  assert.equal(posts(), 1, 'no second request for a result already fetched');
  assert.equal(retried.length, 1, 'the result whose publish failed is delivered on the next ask');
  const again = [];
  await m.enrich(pair('1.0.0'), () => true, (r) => again.push(r));
  assert.equal(again.length, 0, 'delivered once, not repeatedly');
  const later = [];
  await m.enrich(pair('2.0.0'), () => true, (r) => later.push(r));
  assert.equal(posts(), 2, 'later jobs still run');
  assert.equal(later.length, 1);
});

test('a throwing wanted() releases its claim so the version can be checked later', async () => {
  const { m, posts } = memory(() => {});
  await m.enrich(pair('1.0.0'), () => true, () => {}, () => { throw new Error('wanted broke'); });
  assert.equal(posts(), 0);
  const published = [];
  await m.enrich(pair('1.0.0'), () => true, (r) => published.push(r));
  assert.equal(posts(), 1, 'the released version is checked by the next caller');
  assert.equal(published.length, 1);
});

test('a reporter that throws cannot break the queue', async () => {
  const { m, posts } = memory(() => { throw new Error('reporter broke'); });
  await m.enrich(pair('1.0.0'), () => true, () => { throw new Error('post failed'); });
  await m.enrich(pair('2.0.0'), () => true, () => {});
  assert.equal(posts(), 2);
});

test('an old job finishing after clear() does not disturb a new claim on the same version', async () => {
  const releases = [];
  let posts = 0;
  const m = new UpdateAdvisories({ post: () => { posts += 1; return new Promise((resolve) => { releases.push(resolve); }); } }, () => true, () => {});
  const old = m.enrich(pair('1.0.0'), () => true, () => { throw new Error('post failed'); });
  await new Promise((resolve) => setImmediate(resolve));
  m.clear(true);
  const published = [];
  const fresh = m.enrich(pair('1.0.0'), () => true, (r) => published.push(r));
  releases[0](ok());
  await old;
  await new Promise((resolve) => setImmediate(resolve));
  releases[1](ok());
  await fresh;
  assert.equal(posts, 2, 'the new claim ran its own check');
  assert.equal(published.length, 1, 'and delivered it');
  assert.deepEqual(m.results().map((r) => r.version), ['1.0.0']);
});

test('a job failing just as clear() runs does not release the new claim on the same version', async () => {
  // Reachable order: wanted() throws, and before the job's catch runs, the
  // panel clears and a new caller claims the same version. Releasing that
  // claim would let a third caller send a duplicate request.
  const releases = [];
  let posts = 0;
  const m = new UpdateAdvisories({ post: () => { posts += 1; return new Promise((resolve) => { releases.push(resolve); }); } }, () => true, () => {});
  let fresh;
  const failing = m.enrich(pair('1.0.0'), () => true, () => {}, () => {
    queueMicrotask(() => {
      m.clear(true);
      fresh = m.enrich(pair('1.0.0'), () => true, () => {});
    });
    throw new Error('wanted broke');
  });
  await failing;
  await new Promise((resolve) => setImmediate(resolve));
  const third = m.enrich(pair('1.0.0'), () => true, () => {});
  // Answer every request as it arrives until both jobs finish (the queue runs them one at a time).
  let done = false;
  const all = Promise.all([fresh, third]).then(() => { done = true; });
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    while (releases.length > 0) releases.shift()(ok());
  }
  await all;
  assert.equal(posts, 1, 'the third caller reuses the new claim instead of sending its own request');
});
