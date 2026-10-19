import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makePipe, PIPE_BUF, PIPE_CAPACITY, Pipe } from '../../src/kernel/pipe.ts';
import { EPOLLERR, EPOLLHUP, EPOLLIN, EPOLLOUT } from '../../src/kernel/readiness.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('Pipe', () => {
  it('reads what was written, then EAGAIN, then EOF after the writer closes', () => {
    const pipe = new Pipe();
    expect(pipe.write(bytes(1, 2, 3))).toEqual({ ok: true, value: 3 });
    const dst = new Uint8Array(2);
    expect(pipe.read(dst)).toEqual({ ok: true, value: 2 });
    expect([...dst]).toEqual([1, 2]);
    expect(pipe.read(dst)).toEqual({ ok: true, value: 1 });
    expect(pipe.read(dst)).toEqual({ ok: false, error: 'EAGAIN' });
    pipe.closeWriter();
    expect(pipe.read(dst)).toEqual({ ok: true, value: 0 });
  });

  it('drains buffered data before reporting EOF', () => {
    const pipe = new Pipe();
    pipe.write(bytes(9));
    pipe.closeWriter();
    const dst = new Uint8Array(4);
    expect(pipe.read(dst)).toEqual({ ok: true, value: 1 });
    expect(pipe.read(dst)).toEqual({ ok: true, value: 0 });
  });

  it('fails writes with EPIPE once the reader is gone', () => {
    const pipe = new Pipe();
    pipe.closeReader();
    expect(pipe.write(bytes(1))).toEqual({ ok: false, error: 'EPIPE' });
    expect(pipe.writerPoll() & EPOLLERR).toBe(EPOLLERR);
  });

  it('keeps small writes atomic and fills large writes partially', () => {
    const pipe = new Pipe();
    expect(pipe.write(new Uint8Array(PIPE_CAPACITY - 100))).toEqual({
      ok: true,
      value: PIPE_CAPACITY - 100,
    });
    // 200 <= PIPE_BUF bytes do not fit into 100 free bytes: nothing is written.
    expect(pipe.write(new Uint8Array(200))).toEqual({ ok: false, error: 'EAGAIN' });
    expect(pipe.writerPoll() & EPOLLOUT).toBe(0);
    const big = new Pipe();
    big.write(new Uint8Array(PIPE_CAPACITY - PIPE_BUF));
    expect(big.write(new Uint8Array(3 * PIPE_BUF))).toEqual({ ok: true, value: PIPE_BUF });
  });

  it('wakes readers on writes and writers when room returns', () => {
    const pipe = new Pipe();
    const reads: number[] = [];
    const writes: number[] = [];
    pipe.readWaiters.watch((mask) => reads.push(mask));
    pipe.writeWaiters.watch((mask) => writes.push(mask));
    pipe.write(new Uint8Array(PIPE_CAPACITY));
    expect(reads).toEqual([EPOLLIN]);
    pipe.read(new Uint8Array(10));
    expect(writes).toEqual([]);
    pipe.read(new Uint8Array(PIPE_BUF));
    expect(writes).toEqual([EPOLLOUT]);
    pipe.closeWriter();
    expect(reads).toEqual([EPOLLIN, 0]);
    expect(pipe.readerPoll()).toBe(EPOLLIN | EPOLLHUP);
  });

  it('closes an end only when its last holder releases it', () => {
    const [reader, writer] = makePipe(true, true);
    reader.retain();
    reader.release();
    expect(writer.write(bytes(1)).ok).toBe(true);
    reader.release();
    expect(writer.write(bytes(1))).toEqual({ ok: false, error: 'EPIPE' });
    expect(reader.write(bytes(1))).toEqual({ ok: false, error: 'EBADF' });
  });

  type Op =
    | { readonly kind: 'write'; readonly size: number }
    | { readonly kind: 'read'; readonly size: number }
    | { readonly kind: 'close-writer' }
    | { readonly kind: 'close-reader' };

  it('matches a byte-queue model', () => {
    const op: fc.Arbitrary<Op> = fc.oneof(
      {
        weight: 4,
        arbitrary: fc.record({ kind: fc.constant('write'), size: fc.nat(3 * PIPE_BUF) }),
      },
      {
        weight: 4,
        arbitrary: fc.record({ kind: fc.constant('read'), size: fc.nat(3 * PIPE_BUF) }),
      },
      { weight: 1, arbitrary: fc.constant({ kind: 'close-writer' } as const) },
      { weight: 1, arbitrary: fc.constant({ kind: 'close-reader' } as const) },
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const pipe = new Pipe();
        const model: number[] = [];
        let readerOpen = true;
        let writerOpen = true;
        let counter = 0;
        for (const o of ops) {
          switch (o.kind) {
            case 'write': {
              if (!writerOpen) {
                break;
              }
              const data = Uint8Array.from({ length: o.size }, () => counter++ & 0xff);
              const r = pipe.write(data);
              const free = PIPE_CAPACITY - model.length;
              if (!readerOpen) {
                expect(r).toEqual({ ok: false, error: 'EPIPE' });
              } else if (o.size === 0) {
                expect(r).toEqual({ ok: true, value: 0 });
              } else if (free < Math.min(o.size, PIPE_BUF)) {
                expect(r).toEqual({ ok: false, error: 'EAGAIN' });
              } else {
                const n = Math.min(o.size, free);
                expect(r).toEqual({ ok: true, value: n });
                model.push(...data.subarray(0, n));
              }
              break;
            }
            case 'read': {
              if (!readerOpen) {
                break;
              }
              const dst = new Uint8Array(o.size);
              const r = pipe.read(dst);
              if (o.size === 0) {
                expect(r).toEqual({ ok: true, value: 0 });
              } else if (model.length === 0) {
                expect(r).toEqual(
                  writerOpen ? { ok: false, error: 'EAGAIN' } : { ok: true, value: 0 },
                );
              } else {
                const expected = model.splice(0, o.size);
                expect(r).toEqual({ ok: true, value: expected.length });
                expect([...dst.subarray(0, expected.length)]).toEqual(expected);
              }
              break;
            }
            case 'close-writer':
              pipe.closeWriter();
              writerOpen = false;
              break;
            case 'close-reader':
              pipe.closeReader();
              readerOpen = false;
              break;
          }
          expect(pipe.buffered).toBe(model.length);
          expect((pipe.readerPoll() & EPOLLIN) !== 0).toBe(model.length > 0);
          expect((pipe.readerPoll() & EPOLLHUP) !== 0).toBe(!writerOpen);
          expect((pipe.writerPoll() & EPOLLOUT) !== 0).toBe(
            PIPE_CAPACITY - model.length >= PIPE_BUF,
          );
          expect((pipe.writerPoll() & EPOLLERR) !== 0).toBe(!readerOpen);
        }
      }),
    );
  });
});
