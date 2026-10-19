import { EPOLLIN, type Pollable, type ReadinessListener, WaitQueue } from './readiness.ts';

/** Signal notifications set the top bit of a completion id. */
const SIGNAL_FLAG = 0x8000_0000;

/**
 * The Thread-Pool Completion Source (moonrun `ThreadPoolCompletionNotifier`).
 *
 * Holds finished Job ids and coalesced Run signals until the guest drains them
 * with `fetch_completion`. It is level-triggered: readable while anything is
 * pending. Signals are drained before job ids, lowest signal first.
 */
export class CompletionSource implements Pollable {
  readonly #jobs: number[] = [];
  #signals = 0;
  readonly #waiters = new WaitQueue();

  /** Publishes a finished Job's completion id. */
  notify(completionId: number): void {
    this.#jobs.push(completionId | 0);
    this.#waiters.wake(EPOLLIN);
  }

  /** Records a delivered signal (bit index = signal number); repeated signals coalesce. */
  notifySignal(signal: number): void {
    this.#signals = (this.#signals | (1 << signal)) >>> 0;
    this.#waiters.wake(EPOLLIN);
  }

  discardSignals(): void {
    this.#signals = 0;
  }

  /** Removes up to `max` entries: signals as `signal | 0x80000000`, then job ids. */
  fetch(max: number): number[] {
    const out: number[] = [];
    while (out.length < max && this.#signals !== 0) {
      const signal = 31 - Math.clz32(this.#signals & -this.#signals);
      this.#signals = (this.#signals & ~(1 << signal)) >>> 0;
      out.push(signal | SIGNAL_FLAG | 0);
    }
    const count = Math.min(max - out.length, this.#jobs.length);
    out.push(...this.#jobs.splice(0, count));
    return out;
  }

  get pending(): number {
    return this.#jobs.length;
  }

  poll(): number {
    return this.#jobs.length > 0 || this.#signals !== 0 ? EPOLLIN : 0;
  }

  watch(listener: ReadinessListener): () => void {
    return this.#waiters.watch(listener);
  }
}
