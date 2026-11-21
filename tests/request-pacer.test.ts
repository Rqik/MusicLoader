import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HLS_REQUEST_INTERVAL_MS, RequestPacer } from '../src/features/downloads/lib/request-pacer';

function fixture() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 0;
  const pacer = new RequestPacer({
    now: () => now,
    schedule(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return () => { timers.delete(id); };
    },
  });
  function advance(ms: number) {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  }
  function wakeEarly(ms: number) {
    now += ms;
    const due = [...timers][0];
    assert.ok(due);
    timers.delete(due[0]);
    due[1].callback();
  }
  return { pacer, advance, wakeEarly, now: () => now, timers };
}

describe('HLS request pacing', () => {
  it('starts queued requests at least 300 ms apart while allowing responses to overlap', async () => {
    assert.equal(HLS_REQUEST_INTERVAL_MS, 300);
    const clock = fixture();
    const starts: number[] = [];
    const complete: Array<() => void> = [];
    const start = () => clock.pacer.start(new AbortController().signal, () => {
      starts.push(clock.now());
      return new Promise<void>((resolve) => { complete.push(resolve); });
    });
    const requests = [start(), start(), start()];
    assert.deepEqual(starts, [0]);
    clock.advance(299);
    assert.deepEqual(starts, [0]);
    clock.advance(1);
    assert.deepEqual(starts, [0, 300]);
    clock.advance(300);
    assert.deepEqual(starts, [0, 300, 600]);
    for (const finish of complete) finish();
    await Promise.all(requests);
    assert.equal(clock.timers.size, 0);
  });

  it('keeps the interval across separate batches and starts immediately after an idle period', async () => {
    const clock = fixture();
    const signal = new AbortController().signal;
    const starts: number[] = [];
    const start = () => clock.pacer.start(signal, async () => { starts.push(clock.now()); });
    await start();
    clock.advance(100);
    const next = start();
    clock.advance(199);
    assert.deepEqual(starts, [0]);
    clock.advance(1);
    await next;
    clock.advance(1_000);
    await start();
    assert.deepEqual(starts, [0, 300, 1_300]);
    assert.equal(clock.timers.size, 0);
  });

  it('rechecks the clock after an early timer callback', async () => {
    const clock = fixture();
    const signal = new AbortController().signal;
    const starts: number[] = [];
    await clock.pacer.start(signal, async () => { starts.push(clock.now()); });
    const pending = clock.pacer.start(signal, async () => { starts.push(clock.now()); });
    clock.wakeEarly(299.5);
    assert.deepEqual(starts, [0]);
    clock.advance(1);
    await pending;
    assert.deepEqual(starts, [0, 300.5]);
  });

  it('removes cancelled queued requests without starting them or consuming a later slot', async () => {
    const clock = fixture();
    const starts: number[] = [];
    await clock.pacer.start(new AbortController().signal, async () => { starts.push(clock.now()); });
    const cancelled = new AbortController();
    const rejected = assert.rejects(clock.pacer.start(cancelled.signal, async () => { assert.fail('Cancelled request started'); }), { name: 'AbortError' });
    const next = clock.pacer.start(new AbortController().signal, async () => { starts.push(clock.now()); });
    clock.advance(100);
    cancelled.abort();
    await rejected;
    clock.advance(200);
    await next;
    assert.deepEqual(starts, [0, 300]);
    assert.equal(clock.timers.size, 0);
  });

  it('cleans the last pending timer on cancellation and rejects an already aborted signal', async () => {
    const clock = fixture();
    await clock.pacer.start(new AbortController().signal, async () => {});
    const controller = new AbortController();
    const rejected = assert.rejects(clock.pacer.start(controller.signal, async () => assert.fail('Cancelled request started')), { name: 'AbortError' });
    assert.equal(clock.timers.size, 1);
    controller.abort();
    await rejected;
    assert.equal(clock.timers.size, 0);
    await assert.rejects(clock.pacer.start(controller.signal, async () => assert.fail('Aborted request started')), { name: 'AbortError' });
    assert.equal(clock.timers.size, 0);
  });

  it('keeps pacing after a request fails without retrying it', async () => {
    const clock = fixture();
    const signal = new AbortController().signal;
    await assert.rejects(clock.pacer.start(signal, async () => { throw new Error('Network failure'); }), /Network failure/);
    const pending = clock.pacer.start(signal, async () => clock.now());
    clock.advance(300);
    assert.equal(await pending, 300);
  });
});
