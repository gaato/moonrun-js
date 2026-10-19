import type { ChildInput, ChildOutput } from '../../ports/process.ts';

const CAPACITY = 65536;
export interface ByteReader {
  read(buffer: Uint8Array): number;
  readAsync(buffer: Uint8Array, signal?: AbortSignal): Promise<number>;
}
export interface ByteWriter extends ChildInput {
  onDrain(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  ready(): Promise<void> | undefined;
  /** Own a writer while a process inherits this stream. */
  retain(): () => void;
}
function ioError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Finite or incremental stdin. Async reads wait; synchronous reads only consume available bytes. */
export class BrowserStdin implements ByteReader {
  readonly #chunks: Uint8Array[] = [];
  readonly #wake = new Set<() => void>();
  readonly #drains = new Set<() => void>();
  readonly #closes = new Set<() => void>();
  #offset = 0;
  #size = 0;
  #ended = false;
  #closed = false;
  readonly input: ChildInput = {
    write: (bytes) => this.#push(bytes),
    onDrain: (f) => {
      this.#drains.add(f);
    },
    onClose: (f) => {
      this.#closes.add(f);
      if (this.#closed) queueMicrotask(f);
    },
    end: () => this.end(),
    destroy: () => this.close(),
  };
  #push(bytes: Uint8Array): boolean {
    if (this.#ended || this.#closed) throw ioError('EPIPE');
    if (bytes.length > 0) {
      this.#chunks.push(bytes.slice());
      this.#size += bytes.length;
    }
    for (const wake of [...this.#wake]) wake();
    return this.#size < CAPACITY;
  }
  /** Resolves when the accepted buffer goes below 64 KiB. Await to respect backpressure. */
  async write(bytes: Uint8Array): Promise<void> {
    if (this.#push(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.#drains.delete(drain);
        this.#closes.delete(close);
      };
      const drain = (): void => {
        cleanup();
        resolve();
      };
      const close = (): void => {
        cleanup();
        reject(ioError('EPIPE'));
      };
      this.#drains.add(drain);
      this.#closes.add(close);
    });
  }
  end(): void {
    this.#ended = true;
    for (const wake of [...this.#wake]) wake();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.end();
    this.#chunks.length = 0;
    this.#size = 0;
    for (const close of [...this.#closes]) close();
  }
  read(buffer: Uint8Array): number {
    let n = 0;
    const wasFull = this.#size >= CAPACITY;
    while (n < buffer.length) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) break;
      const take = Math.min(buffer.length - n, chunk.length - this.#offset);
      buffer.set(chunk.subarray(this.#offset, this.#offset + take), n);
      n += take;
      this.#offset += take;
      this.#size -= take;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    if (wasFull && this.#size < CAPACITY)
      for (const drain of [...this.#drains]) queueMicrotask(drain);
    return n;
  }
  async readAsync(buffer: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted === true) throw ioError('EINTR');
    if (buffer.length === 0) return 0;
    while (this.#size === 0 && !this.#ended) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.#wake.delete(wake);
          signal?.removeEventListener('abort', abort);
        };
        const wake = (): void => {
          cleanup();
          resolve();
        };
        const abort = (): void => {
          cleanup();
          reject(ioError('EINTR'));
        };
        this.#wake.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return this.read(buffer);
  }
}

/** One host pipe. Kernel feedChild/drainChild provide the actual blocking pipe semantics. */
export class BrowserOutput implements ByteWriter, ChildOutput {
  readonly #chunks: Uint8Array[] = [];
  readonly #drains = new Set<() => void>();
  readonly #closes = new Set<() => void>();
  readonly #ends = new Set<() => void>();
  #data: ((bytes: Uint8Array) => void) | undefined;
  #paused = true;
  #scheduled = false;
  #closed = false;
  #finished = false;
  #active = false;
  #size = 0;
  #writers = 0;
  retain(): () => void {
    this.#writers++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--this.#writers === 0) this.end();
      }
    };
  }
  write(bytes: Uint8Array): boolean {
    if (this.#closed || this.#finished) throw ioError('EPIPE');
    if (bytes.length > 0) {
      this.#chunks.push(bytes.slice());
      this.#size += bytes.length;
    }
    this.#schedule();
    return this.#size < CAPACITY && !this.#paused;
  }
  ready(): Promise<void> | undefined {
    if (this.#closed) return Promise.reject(ioError('EPIPE'));
    if ((this.#size === 0 && !this.#active) || (!this.#paused && this.#size < CAPACITY))
      return undefined;
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.#drains.delete(drain);
        this.#closes.delete(close);
      };
      const drain = (): void => {
        cleanup();
        resolve();
      };
      const close = (): void => {
        cleanup();
        reject(ioError('EPIPE'));
      };
      this.#drains.add(drain);
      this.#closes.add(close);
    });
  }
  onDrain(f: () => void): () => void {
    this.#drains.add(f);
    return () => {
      this.#drains.delete(f);
    };
  }
  onClose(f: () => void): () => void {
    this.#closes.add(f);
    if (this.#closed) queueMicrotask(f);
    return () => {
      this.#closes.delete(f);
    };
  }
  onData(f: (bytes: Uint8Array) => void): void {
    this.#data = f;
    this.resume();
  }
  onEnd(f: () => void): void {
    this.#ends.add(f);
    this.#schedule();
  }
  pause(): void {
    this.#paused = true;
  }
  resume(): void {
    this.#active = false;
    this.#paused = false;
    this.#schedule();
  }
  end(): void {
    this.#finished = true;
    this.#schedule();
  }
  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#chunks.length = 0;
    this.#size = 0;
    for (const f of this.#closes) f();
    for (const f of this.#ends) f();
    this.#ends.clear();
  }
  #flowing(): boolean {
    return !this.#paused;
  }
  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      while (this.#flowing() && this.#data !== undefined) {
        const chunk = this.#chunks.shift();
        if (chunk === undefined) break;
        this.#size -= chunk.length;
        this.#active = true;
        this.#data(chunk);
        if (!this.#paused) this.#active = false;
      }
      if (!this.#paused && this.#size < CAPACITY) for (const f of [...this.#drains]) f();
      if (this.#finished && this.#chunks.length === 0 && !this.#paused) {
        for (const f of this.#ends) f();
        this.#ends.clear();
      }
    });
  }
}

/** A synchronous callback or memory-file writer never needs host buffering. */
export function callbackWriter(write: (bytes: Uint8Array) => void): ByteWriter {
  const closes = new Set<() => void>();
  let closed = false;
  return {
    ready: () => undefined,
    write: (bytes) => {
      if (closed) throw ioError('EPIPE');
      write(bytes);
      return true;
    },
    onDrain: () => () => {},
    onClose: (f) => {
      if (closed) queueMicrotask(f);
      else closes.add(f);
      return () => {
        closes.delete(f);
      };
    },
    end: () => {},
    destroy: () => {
      closed = true;
      for (const close of [...closes]) close();
      closes.clear();
    },
    retain: () => () => {},
  };
}
export interface BrowserIo {
  readonly stdin: ByteReader;
  readonly stdout: ByteWriter;
  readonly stderr: ByteWriter;
}
