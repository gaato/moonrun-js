/** A cancellable pending callback. */
export interface Timer {
  cancel(): void;
}

/**
 * The JavaScript event loop as the kernel needs it. Injected per Run so tests can
 * drive time by hand; the default uses only ECMAScript/HTML globals (no `node:`).
 */
export interface Scheduler {
  /** Monotonic milliseconds. */
  now(): number;
  /** Runs `callback` after `ms` milliseconds; the pending timer keeps the host alive. */
  setTimer(ms: number, callback: () => void): Timer;
  /** Resolves after one macrotask, letting timers and host I/O callbacks run. */
  macrotask(): Promise<void>;
  /** Keeps the host process alive (e.g. while the guest waits without a timeout). */
  keepAlive(): Timer;
  /** Releases everything this scheduler holds open. */
  dispose(): void;
}

/** The part of `MessageChannel` the scheduler uses (typed structurally: no DOM lib here). */
interface Channel {
  readonly port1: { onmessage: ((event: unknown) => void) | null; close(): void };
  readonly port2: { postMessage(message: unknown): void };
}

/** A generous interval: only its existence matters. */
const KEEP_ALIVE_MS = 1 << 30;

/** `setImmediate` where the host has one (Node, Deno, Bun); typed structurally. */
const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;

/**
 * The global event loop. The guest yields a macrotask on every `wait(0)`, so a macrotask
 * must be cheap: `setTimeout(0)` is clamped to 1 ms in Node. Hosts with `setImmediate`
 * use it. A `MessageChannel` (the browser fallback) builds a `MessageEvent` per message,
 * and Node loads its web-platform modules on the first one, which used to stall the
 * guest just as its tests started.
 */
export class GlobalScheduler implements Scheduler {
  #channel: Channel | undefined;
  #pending: Array<() => void> = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #disposed = false;

  now(): number {
    return performance.now();
  }

  setTimer(ms: number, callback: () => void): Timer {
    const id = setTimeout(() => {
      this.#timers.delete(id);
      callback();
    }, ms);
    this.#timers.add(id);
    return {
      cancel: () => {
        clearTimeout(id);
        this.#timers.delete(id);
      },
    };
  }

  macrotask(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#pending.push(resolve);
    if (this.#pending.length === 1) {
      if (immediate === undefined) {
        this.#port().port2.postMessage(null);
      } else {
        immediate(() => this.#run());
      }
    }
    return promise;
  }

  #run(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  keepAlive(): Timer {
    const id = setInterval(() => {}, KEEP_ALIVE_MS);
    return { cancel: () => clearInterval(id) };
  }

  dispose(): void {
    this.#disposed = true;
    for (const id of this.#timers) {
      clearTimeout(id);
    }
    this.#timers.clear();
    this.#channel?.port1.close();
    this.#channel = undefined;
    const pending = this.#pending;
    this.#pending = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  #port(): Channel {
    if (this.#channel === undefined) {
      const channel: Channel = new MessageChannel() as unknown as Channel;
      channel.port1.onmessage = () => this.#run();
      this.#channel = channel;
    }
    return this.#channel;
  }
}
