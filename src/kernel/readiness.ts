/** Linux `epoll` event bits (the kernel speaks epoll; the ABI encodes them for the guest). */
export const EPOLLIN = 0x001;
export const EPOLLOUT = 0x004;
export const EPOLLERR = 0x008;
export const EPOLLHUP = 0x010;
export const EPOLLRDHUP = 0x2000;

/** A readiness change; listeners receive the epoll mask of the wakeup (0 means "anything"). */
export type ReadinessListener = (mask: number) => void;

/**
 * Something whose readiness can be polled: the equivalent of a file's `poll`
 * operation plus its wait queue.
 */
export interface Pollable {
  /** Current readiness as epoll bits. */
  poll(): number;
  /** Subscribes to wakeups; returns the unsubscribe function. */
  watch(listener: ReadinessListener): () => void;
}

/** A wait queue: wakes every listener with the mask of the event. */
export class WaitQueue {
  readonly #listeners = new Set<ReadinessListener>();

  watch(listener: ReadinessListener): () => void {
    // A listener object may subscribe more than once; wrap so each subscription is distinct.
    const entry: ReadinessListener = (mask) => listener(mask);
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  wake(mask: number): void {
    for (const listener of [...this.#listeners]) {
      listener(mask);
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}
