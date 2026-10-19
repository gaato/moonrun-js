import { err, type HostErrorCode, ok, type Result } from '../ports/result.ts';
import {
  EPOLLERR,
  EPOLLHUP,
  EPOLLIN,
  EPOLLOUT,
  type Pollable,
  type ReadinessListener,
  WaitQueue,
} from './readiness.ts';

/** Linux's default pipe size (16 pages). */
export const PIPE_CAPACITY = 65536;
/** Writes up to this size are atomic. */
export const PIPE_BUF = 4096;

/**
 * An anonymous pipe with Linux semantics, as a byte ring buffer.
 *
 * - read: data → up to the request; empty with a writer → `EAGAIN`; empty without → 0 (EOF).
 * - write: no reader → `EPIPE`; otherwise needs room for `min(len, PIPE_BUF)` bytes or fails
 *   with `EAGAIN`, then writes as much as fits.
 * - poll: the read end is `IN` with data and `HUP` without writers; the write end is `OUT`
 *   while at least `PIPE_BUF` bytes are free and `ERR` without readers.
 * - wakeups: every write wakes readers; a read that makes the pipe writable again wakes
 *   writers; closing an end wakes both sides.
 */
export class Pipe {
  readonly #buffer = new Uint8Array(PIPE_CAPACITY);
  #start = 0;
  #length = 0;
  #readerOpen = true;
  #writerOpen = true;
  readonly readWaiters = new WaitQueue();
  readonly writeWaiters = new WaitQueue();

  get buffered(): number {
    return this.#length;
  }

  get readerOpen(): boolean {
    return this.#readerOpen;
  }

  get writerOpen(): boolean {
    return this.#writerOpen;
  }

  read(dst: Uint8Array): Result<number, HostErrorCode> {
    if (dst.length === 0) {
      return ok(0);
    }
    if (this.#length === 0) {
      return this.#writerOpen ? err('EAGAIN') : ok(0);
    }
    const wasWritable = this.#writable();
    const n = Math.min(dst.length, this.#length);
    const first = Math.min(n, PIPE_CAPACITY - this.#start);
    dst.set(this.#buffer.subarray(this.#start, this.#start + first), 0);
    if (first < n) {
      dst.set(this.#buffer.subarray(0, n - first), first);
    }
    this.#start = (this.#start + n) % PIPE_CAPACITY;
    this.#length -= n;
    if (!wasWritable && this.#writable()) {
      this.writeWaiters.wake(EPOLLOUT);
    }
    return ok(n);
  }

  write(src: Uint8Array): Result<number, HostErrorCode> {
    if (!this.#readerOpen) {
      return err('EPIPE');
    }
    if (src.length === 0) {
      return ok(0);
    }
    const free = PIPE_CAPACITY - this.#length;
    if (free < Math.min(src.length, PIPE_BUF)) {
      return err('EAGAIN');
    }
    const n = Math.min(src.length, free);
    const end = (this.#start + this.#length) % PIPE_CAPACITY;
    const first = Math.min(n, PIPE_CAPACITY - end);
    this.#buffer.set(src.subarray(0, first), end);
    if (first < n) {
      this.#buffer.set(src.subarray(first, n), 0);
    }
    this.#length += n;
    this.readWaiters.wake(EPOLLIN);
    return ok(n);
  }

  closeReader(): void {
    if (this.#readerOpen) {
      this.#readerOpen = false;
      this.readWaiters.wake(0);
      this.writeWaiters.wake(0);
    }
  }

  closeWriter(): void {
    if (this.#writerOpen) {
      this.#writerOpen = false;
      this.readWaiters.wake(0);
      this.writeWaiters.wake(0);
    }
  }

  readerPoll(): number {
    return (this.#length > 0 ? EPOLLIN : 0) | (this.#writerOpen ? 0 : EPOLLHUP);
  }

  writerPoll(): number {
    return (this.#writable() ? EPOLLOUT : 0) | (this.#readerOpen ? 0 : EPOLLERR);
  }

  #writable(): boolean {
    return PIPE_CAPACITY - this.#length >= PIPE_BUF;
  }
}

export type PipeSide = 'read' | 'write';

/**
 * One end of a pipe, i.e. an open file description. It is shared by its
 * Resource Handle and by Jobs that acquired it; the end closes when the last
 * holder releases it, as an fd held by an in-flight syscall stays open.
 */
export class PipeEnd implements Pollable {
  readonly pipe: Pipe;
  readonly side: PipeSide;
  /** `O_NONBLOCK`; set at creation or by poll registration. */
  nonblocking: boolean;
  #holders = 1;

  constructor(pipe: Pipe, side: PipeSide, nonblocking: boolean) {
    this.pipe = pipe;
    this.side = side;
    this.nonblocking = nonblocking;
  }

  get open(): boolean {
    return this.#holders > 0;
  }

  retain(): void {
    this.#holders++;
  }

  release(): void {
    if (this.#holders === 0) {
      return;
    }
    this.#holders--;
    if (this.#holders === 0) {
      if (this.side === 'read') {
        this.pipe.closeReader();
      } else {
        this.pipe.closeWriter();
      }
    }
  }

  read(dst: Uint8Array): Result<number, HostErrorCode> {
    return this.side === 'read' ? this.pipe.read(dst) : err('EBADF');
  }

  write(src: Uint8Array): Result<number, HostErrorCode> {
    return this.side === 'write' ? this.pipe.write(src) : err('EBADF');
  }

  poll(): number {
    return this.side === 'read' ? this.pipe.readerPoll() : this.pipe.writerPoll();
  }

  watch(listener: ReadinessListener): () => void {
    return (this.side === 'read' ? this.pipe.readWaiters : this.pipe.writeWaiters).watch(listener);
  }
}

/** A fresh pipe's read and write ends. */
export function makePipe(readNonblocking: boolean, writeNonblocking: boolean): [PipeEnd, PipeEnd] {
  const pipe = new Pipe();
  return [new PipeEnd(pipe, 'read', readNonblocking), new PipeEnd(pipe, 'write', writeNonblocking)];
}
