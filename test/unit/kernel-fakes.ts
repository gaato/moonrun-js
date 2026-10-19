import type { Scheduler, Timer } from '../../src/kernel/scheduler.ts';
import type { StdioPort } from '../../src/ports/stdio.ts';

interface PendingTimer {
  readonly at: number;
  readonly seq: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/** A scheduler driven by hand: time moves only through {@link advance}. */
export class FakeScheduler implements Scheduler {
  time = 0;
  #seq = 0;
  #timers: PendingTimer[] = [];
  keptAlive = 0;
  disposed = false;

  now(): number {
    return this.time;
  }

  setTimer(ms: number, callback: () => void): Timer {
    const timer: PendingTimer = {
      at: this.time + ms,
      seq: this.#seq++,
      callback,
      cancelled: false,
    };
    this.#timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  macrotask(): Promise<void> {
    return Promise.resolve();
  }

  keepAlive(): Timer {
    this.keptAlive++;
    return {
      cancel: () => {
        this.keptAlive--;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.#timers = [];
  }

  get pendingTimers(): number {
    return this.#timers.filter((t) => !t.cancelled).length;
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = this.#timers
        .filter((t) => !t.cancelled && t.at <= until)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) {
        break;
      }
      due.cancelled = true;
      this.time = due.at;
      due.callback();
    }
    this.time = until;
  }
}

/** A stdio port that records output and serves stdin from a fixed buffer. */
export function memoryStdio(stdin: Uint8Array = new Uint8Array()): StdioPort & {
  readonly out: number[];
  readonly err: number[];
} {
  let offset = 0;
  const out: number[] = [];
  const errOut: number[] = [];
  return {
    out,
    err: errOut,
    writeStdout: (bytes) => {
      out.push(...bytes);
    },
    writeStderr: (bytes) => {
      errOut.push(...bytes);
    },
    readStdin: (buffer) => {
      const n = Math.min(buffer.length, stdin.length - offset);
      buffer.set(stdin.subarray(offset, offset + n));
      offset += n;
      return n;
    },
    readStdinAsync: (buffer) => {
      const n = Math.min(buffer.length, stdin.length - offset);
      buffer.set(stdin.subarray(offset, offset + n));
      offset += n;
      return Promise.resolve(n);
    },
  };
}

/** Settles pending promise callbacks. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
