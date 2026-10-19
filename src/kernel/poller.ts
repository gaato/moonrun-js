import { err, ok, type Result } from '../ports/result.ts';
import { EPOLLERR, EPOLLHUP, type Pollable } from './readiness.ts';
import type { Scheduler, Timer } from './scheduler.ts';

/** moonrun's `EVENT_BUFFER_SIZE`. */
export const EVENT_BUFFER_SIZE = 1024;
/** Force a macrotask at least this often, so host callbacks are not starved by a busy guest. */
export const FORCED_YIELD_MS = 5;

export type Trigger = 'edge' | 'level';

export interface PollEvent {
  /** The registration's user data (a guest handle). */
  readonly data: bigint;
  /** epoll bits. */
  readonly events: number;
}

interface Registration {
  readonly source: Pollable;
  /** Requested bits plus `EPOLLERR | EPOLLHUP`, which epoll always reports. */
  readonly interest: number;
  readonly trigger: Trigger;
  readonly data: bigint;
  readonly unwatch: () => void;
}

interface Waiter {
  readonly wake: () => void;
}

/**
 * An `epoll` instance.
 *
 * Wakeups put a registration on the ready list (once); `wait` takes registrations
 * off the list in order, re-polls their source and reports the current bits, as
 * `ep_send_events` does: a registration whose source is no longer ready is dropped
 * silently, a level-triggered one goes back to the tail. Registration of an already
 * ready source queues it at once.
 */
export class Poller {
  readonly #scheduler: Scheduler;
  readonly #registrations = new Map<object, Registration>();
  /** Insertion-ordered ready list. */
  readonly #ready = new Set<Registration>();
  #events: PollEvent[] = [];
  #waiter: Waiter | undefined;
  #lastYield: number;
  #closed = false;

  constructor(scheduler: Scheduler) {
    this.#scheduler = scheduler;
    this.#lastYield = scheduler.now();
  }

  /** `EPOLL_CTL_ADD`; `id` is the identity of the open file (one registration each). */
  register(
    id: object,
    source: Pollable,
    interest: number,
    trigger: Trigger,
    data: bigint,
  ): Result<void, 'EEXIST'> {
    if (this.#registrations.has(id)) {
      return err('EEXIST');
    }
    const mask = interest | EPOLLERR | EPOLLHUP;
    let registration: Registration | undefined;
    const unwatch = source.watch((wakeMask) => {
      if (registration !== undefined && (wakeMask === 0 || (wakeMask & mask) !== 0)) {
        this.#queue(registration);
      }
    });
    registration = { source, interest: mask, trigger, data, unwatch };
    this.#registrations.set(id, registration);
    if ((source.poll() & mask) !== 0) {
      this.#queue(registration);
    }
    return ok(undefined);
  }

  /** `EPOLL_CTL_DEL`; unknown ids are ignored. Pending readiness of the registration is dropped. */
  unregister(id: object): void {
    const registration = this.#registrations.get(id);
    if (registration !== undefined) {
      registration.unwatch();
      this.#ready.delete(registration);
      this.#registrations.delete(id);
    }
  }

  has(id: object): boolean {
    return this.#registrations.has(id);
  }

  /** Events of the last completed wait. */
  get events(): readonly PollEvent[] {
    return this.#events;
  }

  /**
   * `epoll_wait`. Returns synchronously when events are pending; otherwise (and at
   * least every {@link FORCED_YIELD_MS}) returns a promise, so the guest suspends.
   * A zero timeout with nothing pending yields one macrotask before answering.
   */
  wait(timeoutMs: number): number | Promise<number> {
    if (this.#scheduler.now() - this.#lastYield < FORCED_YIELD_MS) {
      const count = this.#collect();
      if (count > 0) {
        return count;
      }
      if (timeoutMs === 0) {
        return this.#yield().then(() => this.#collect());
      }
      return this.#block(timeoutMs);
    }
    return this.#yield().then(() => {
      const count = this.#collect();
      return count > 0 || timeoutMs === 0 ? count : this.#block(timeoutMs);
    });
  }

  /** Detaches every registration and releases a pending waiter with no events. */
  close(): void {
    this.#closed = true;
    for (const registration of this.#registrations.values()) {
      registration.unwatch();
    }
    this.#registrations.clear();
    this.#ready.clear();
    this.#waiter?.wake();
  }

  #queue(registration: Registration): void {
    if (!this.#ready.has(registration)) {
      this.#ready.add(registration);
    }
    this.#waiter?.wake();
  }

  /** `ep_send_events`: report at most {@link EVENT_BUFFER_SIZE} ready registrations. */
  #collect(): number {
    const events: PollEvent[] = [];
    for (const registration of [...this.#ready]) {
      if (events.length >= EVENT_BUFFER_SIZE) {
        break;
      }
      this.#ready.delete(registration);
      const revents = registration.source.poll() & registration.interest;
      if (revents === 0) {
        continue;
      }
      events.push({ data: registration.data, events: revents });
      if (registration.trigger === 'level') {
        this.#ready.add(registration);
      }
    }
    this.#events = events;
    return events.length;
  }

  async #yield(): Promise<void> {
    await this.#scheduler.macrotask();
    this.#lastYield = this.#scheduler.now();
  }

  #block(timeoutMs: number): Promise<number> {
    const { promise, resolve } = Promise.withResolvers<number>();
    let timer: Timer | undefined;
    const finish = (count: number): void => {
      this.#waiter = undefined;
      timer?.cancel();
      this.#lastYield = this.#scheduler.now();
      resolve(count);
    };
    const waiter: Waiter = {
      wake: () => {
        if (this.#closed) {
          finish(0);
          return;
        }
        // Readiness may have been consumed again before we look; keep waiting then.
        if (this.#ready.size === 0) {
          return;
        }
        // Collect in a later microtask so a burst of wakeups is reported together.
        queueMicrotask(() => {
          if (this.#waiter !== waiter) {
            return;
          }
          const count = this.#collect();
          if (count > 0) {
            finish(count);
          }
        });
      },
    };
    this.#waiter = waiter;
    timer =
      timeoutMs < 0
        ? this.#scheduler.keepAlive()
        : this.#scheduler.setTimer(timeoutMs, () => {
            if (this.#waiter === waiter) {
              finish(this.#collect());
            }
          });
    return promise;
  }
}
