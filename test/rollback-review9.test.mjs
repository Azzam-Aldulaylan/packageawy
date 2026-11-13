import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferred, until } from './helpers/dashboard-startup.mjs';
import { completedFixture, fault } from './helpers/completed-refresh.mjs';
import { withoutFsync } from './helpers/without-fsync.mjs';

withoutFsync();


function assertCurrent(f, messages = f.s.posted) {
  const snapshots = messages.filter(message => 'data' in message);
  const current = snapshots.at(-1);
  assert.equal(current?.status, 'ready');
  const react = current.data.rows.find(row => row.name === 'react');
  if (f.operation === 'upgrade') assert.equal(react?.current, '18.3.0');
  else assert.equal(react, undefined);
  for (const message of snapshots.filter(message => message.status === 'ready')) {
    const row = message.data.rows.find(row => row.name === 'react');
    assert.notEqual(row?.current, '18.2.0', 'old rows must never be replayed as current');
  }
}

for (const operation of ['removal', 'cleanup', 'upgrade']) {
  for (const code of ['EACCES', 'EMFILE']) {
    for (const retry of ['tick', 'refresh', 'ready', 'failed-ready']) {
      test(`${operation} completion ${code}: ${retry} reloads the invalidated snapshot`, async t => {
        const f = await completedFixture(t, operation);
        const injected = fault(t, f, code);
        await f.confirm();
        injected.reached();
        assert.equal(f.coordinator.mutationLocks.admissionClosed, false);
        assert.equal(f.messages.some(message => message.error?.code === 'OUTCOME_UNKNOWN'), false);
        assert.equal(f.s.current.runtimeFailed, false);
        assert.equal(f.s.current.controller, undefined);
        if (operation === 'cleanup' && ['tick', 'refresh'].includes(retry)) {
          // The retained restore point blocks these entry points until the
          // existing recovery flow ends. Leave its automatic reread pending
          // so the next timer/manual retry is the read under test.
          const recovery = f.coordinator.recovery;
          recovery.options.target = async () => f.coordinator.reservation.held.journal.storage.target;
          recovery.options.removed = async () => {};
          await recovery.start(true, null);
          await recovery.dismiss(true, false);
          assert.equal(f.coordinator.reservation.held, undefined);
          assert.equal(f.s.current.controller, undefined);
        }
        const start = f.s.posted.length;
        if (retry === 'tick') {
          f.s.current.onBackgroundTick();
          await until(() => f.s.current.controller?.isEligible());
        } else if (retry === 'refresh') {
          await f.s.refresh();
        } else {
          const find = f.s.platform.findFiles;
          const gate = deferred();
          const entered = deferred();
          let reads = 0;
          f.s.platform.findFiles = async search => {
            if (search.include === '**/package.json') {
              reads++;
              entered.resolve();
              await gate.promise;
              if (retry === 'failed-ready') throw Object.assign(new Error(`replay ${code}`), { code });
            }
            return find(search);
          };
          const replay = f.s.ready();
          // A ready handler that incorrectly skips disk must fail promptly.
          await Promise.race([entered.promise, replay]);
          assert.equal(reads, 1, 'ready replay must reread disk before presenting');
          assert.equal(f.s.posted.slice(start).some(message => message.status === 'loading'), true);
          assert.equal(f.s.current.controller, undefined, 'pending full load cannot restore the controller');
          assert.equal(f.s.posted.slice(start).some(message => message.status === 'ready'), false);
          gate.resolve();
          await replay;
          if (retry === 'failed-ready') {
            assert.equal(f.s.current.controller, undefined);
            assert.equal(f.s.posted.slice(start).some(message => message.status === 'ready'), false);
            assert.ok(f.s.posted.slice(start).some(message => message.status === 'fatal-error'));
            f.s.platform.findFiles = find;
            await f.s.ready();
          }
        }
        assertCurrent(f, f.s.posted.slice(start));
      });
    }
  }
}

for (const code of ['EACCES', 'EMFILE']) test(`fallback upgrade preserves a returned ${code} reload failure`, async t => {
  const f = await completedFixture(t, 'upgrade', true);
  const injected = fault(t, f, code, { fallback: true });
  await f.confirm();
  injected.reached();
  assert.equal(f.s.current.controller, undefined);
  const start = f.s.posted.length;
  await f.s.ready();
  assertCurrent(f, f.s.posted.slice(start));
});
