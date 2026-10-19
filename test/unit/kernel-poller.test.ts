import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EVENT_BUFFER_SIZE, FORCED_YIELD_MS, Poller } from '../../src/kernel/poller.ts';
import {
  EPOLLHUP,
  EPOLLIN,
  EPOLLOUT,
  type Pollable,
  WaitQueue,
} from '../../src/kernel/readiness.ts';
import { FakeScheduler, flush } from './kernel-fakes.ts';

/** A pollable whose readiness the test sets; `set` wakes like a file's wait queue. */
class Source implements Pollable {
  mask = 0;
  readonly queue = new WaitQueue();

  set(mask: number, wake = true): void {
    this.mask = mask;
    if (wake) {
      this.queue.wake(mask);
    }
  }

  poll(): number {
    return this.mask;
  }

  watch(listener: (mask: number) => void): () => void {
    return this.queue.watch(listener);
  }
}

function setup() {
  const scheduler = new FakeScheduler();
  const poller = new Poller(scheduler);
  return { scheduler, poller };
}

describe('Poller', () => {
  it('reports an already-ready source on registration, edge-triggered once', () => {
    const { poller } = setup();
    const source = new Source();
    source.set(EPOLLIN);
    expect(poller.register(source, source, EPOLLIN, 'edge', 7n).ok).toBe(true);
    expect(poller.wait(10)).toBe(1);
    expect(poller.events).toEqual([{ data: 7n, events: EPOLLIN }]);
    // Still readable, but no new edge.
    expect(poller.wait(0)).toBeInstanceOf(Promise);
  });

  it('re-reports a level-triggered source while it stays ready', () => {
    const { poller } = setup();
    const source = new Source();
    poller.register(source, source, EPOLLIN, 'level', 1n);
    source.set(EPOLLIN);
    expect(poller.wait(0)).toBe(1);
    expect(poller.wait(0)).toBe(1);
    source.set(0, false);
    expect(poller.wait(0)).toBeInstanceOf(Promise);
  });

  it('drops a queued registration whose readiness was consumed', async () => {
    const { poller } = setup();
    const source = new Source();
    poller.register(source, source, EPOLLIN, 'edge', 1n);
    source.set(EPOLLIN);
    source.set(0, false);
    await expect(poller.wait(0)).resolves.toBe(0);
  });

  it('ignores wakeups outside the interest but always reports HUP', () => {
    const { poller } = setup();
    const source = new Source();
    poller.register(source, source, EPOLLIN, 'edge', 1n);
    source.set(EPOLLOUT);
    expect(poller.wait(0)).toBeInstanceOf(Promise);
    source.set(EPOLLHUP);
    expect(poller.wait(0)).toBe(1);
    expect(poller.events[0]?.events).toBe(EPOLLHUP);
  });

  it('rejects a duplicate registration and forgets pending events on unregister', async () => {
    const { poller } = setup();
    const source = new Source();
    source.set(EPOLLIN);
    poller.register(source, source, EPOLLIN, 'edge', 1n);
    expect(poller.register(source, source, EPOLLIN, 'edge', 1n)).toEqual({
      ok: false,
      error: 'EEXIST',
    });
    poller.unregister(source);
    await expect(poller.wait(0)).resolves.toBe(0);
    source.set(EPOLLIN);
    await expect(poller.wait(0)).resolves.toBe(0);
  });

  it('caps one wait at the event buffer size and carries the rest over', () => {
    const { poller } = setup();
    const sources = Array.from({ length: EVENT_BUFFER_SIZE + 5 }, () => new Source());
    sources.forEach((source, i) => {
      source.set(EPOLLIN);
      poller.register(source, source, EPOLLIN, 'edge', BigInt(i));
    });
    expect(poller.wait(0)).toBe(EVENT_BUFFER_SIZE);
    expect(poller.events.at(-1)?.data).toBe(BigInt(EVENT_BUFFER_SIZE - 1));
    expect(poller.wait(0)).toBe(5);
    expect(poller.events[0]?.data).toBe(BigInt(EVENT_BUFFER_SIZE));
  });

  it('suspends until an edge, a timeout, or forever with the host kept alive', async () => {
    const { scheduler, poller } = setup();
    const source = new Source();
    poller.register(source, source, EPOLLIN, 'edge', 3n);

    const timed = poller.wait(50);
    expect(timed).toBeInstanceOf(Promise);
    scheduler.advance(50);
    await expect(timed).resolves.toBe(0);

    const forever = poller.wait(-1);
    expect(scheduler.keptAlive).toBe(1);
    await flush();
    source.set(EPOLLIN);
    await expect(forever).resolves.toBe(1);
    expect(scheduler.keptAlive).toBe(0);
    expect(scheduler.pendingTimers).toBe(0);
  });

  it('forces a macrotask after a few milliseconds without one', async () => {
    const { scheduler, poller } = setup();
    const source = new Source();
    poller.register(source, source, EPOLLIN, 'level', 3n);
    source.set(EPOLLIN);
    expect(poller.wait(0)).toBe(1);
    scheduler.advance(FORCED_YIELD_MS);
    const yielded = poller.wait(0);
    expect(yielded).toBeInstanceOf(Promise);
    await expect(yielded).resolves.toBe(1);
    expect(poller.wait(0)).toBe(1);
  });

  type Op =
    | { readonly kind: 'ready'; readonly source: number; readonly wake: boolean }
    | { readonly kind: 'idle'; readonly source: number }
    | { readonly kind: 'wait' };

  it('matches an ep_send_events model', async () => {
    const count = 4;
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant('ready'), source: fc.nat(count - 1), wake: fc.boolean() }),
      fc.record({ kind: fc.constant('idle'), source: fc.nat(count - 1) }),
      fc.constant({ kind: 'wait' } as const),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<'edge' | 'level'>('edge', 'level'), {
          minLength: count,
          maxLength: count,
        }),
        fc.array(op, { maxLength: 60 }),
        async (triggers, ops) => {
          const { poller } = setup();
          const sources = triggers.map(() => new Source());
          // Model: ordered ready list of indices.
          let ready: number[] = [];
          sources.forEach((source, i) => {
            poller.register(source, source, EPOLLIN, triggers[i] ?? 'edge', BigInt(i));
          });
          for (const o of ops) {
            switch (o.kind) {
              case 'ready':
                sources[o.source]?.set(EPOLLIN, o.wake);
                if (o.wake && !ready.includes(o.source)) {
                  ready.push(o.source);
                }
                break;
              case 'idle':
                sources[o.source]?.set(0, false);
                break;
              case 'wait': {
                const expected: number[] = [];
                const next: number[] = [];
                for (const i of ready) {
                  if ((sources[i]?.mask ?? 0) !== 0) {
                    expected.push(i);
                    if (triggers[i] === 'level') {
                      next.push(i);
                    }
                  }
                }
                ready = next;
                const got = await poller.wait(0);
                expect(got).toBe(expected.length);
                expect(poller.events.map((e) => Number(e.data))).toEqual(expected);
                break;
              }
            }
          }
        },
      ),
    );
  });
});
