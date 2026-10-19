import { describe, expect, it } from 'vitest';
import { nodeFiles } from '../../src/hosts/node/files.ts';
import { AsyncKernel } from '../../src/kernel/async-kernel.ts';
import type { Handle } from '../../src/kernel/handles.ts';
import { unsupportedDns, unsupportedNet } from '../../src/kernel/net-unsupported.ts';
import { ok, type Result } from '../../src/ports/result.ts';
import { FakeScheduler, flush, memoryStdio } from './kernel-fakes.ts';

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) {
    throw new Error(`unexpected error ${JSON.stringify(r.error)}`);
  }
  return r.value;
}

function setup(stdin?: Uint8Array) {
  const scheduler = new FakeScheduler();
  const stdio = memoryStdio(stdin);
  const kernel = new AsyncKernel({
    stdio,
    scheduler,
    stdioKind: () => ok('pipe'),
    files: nodeFiles(),
    net: unsupportedNet,
    dns: unsupportedDns,
  });
  const bus = kernel.pollCreate();
  const source = value(kernel.initThreadPool(bus));
  return { scheduler, stdio, kernel, bus, source };
}

describe('thread pool', () => {
  it('needs an initialized pool and admits one registration', () => {
    const scheduler = new FakeScheduler();
    const kernel = new AsyncKernel({
      stdio: memoryStdio(),
      scheduler,
      stdioKind: () => ok('pipe'),
      files: nodeFiles(),
      net: unsupportedNet,
      dns: unsupportedDns,
    });
    const job = kernel.pool.insertJob({ kind: 'sleep', ms: 1 });
    expect(kernel.spawnWorker(0, job)).toEqual({ ok: false, error: { kind: 'badf' } });
    // The failed spawn did not consume the Job.
    expect(kernel.pool.job(job).ok).toBe(true);
    const bus = kernel.pollCreate();
    expect(kernel.initThreadPool(bus).ok).toBe(true);
    expect(kernel.initThreadPool(bus)).toEqual({ ok: false, error: { kind: 'inval' } });
  });

  it('publishes completions on a level-triggered source and re-arms after a partial fetch', async () => {
    const { scheduler, kernel, bus, source } = setup();
    const a = kernel.pool.insertJob({ kind: 'sleep', ms: 10 });
    const b = kernel.pool.insertJob({ kind: 'sleep', ms: 10 });
    value(kernel.spawnWorker(1, a));
    value(kernel.spawnWorker(2, b));
    // A Worker owns its Job until it finishes.
    expect(kernel.pool.job(a).ok).toBe(false);
    scheduler.advance(10);
    expect(kernel.pool.job(a).ok).toBe(true);
    // Time moved on, so this wait takes its forced macrotask first.
    expect(await value(kernel.pollWait(bus, 0))).toBe(1);
    expect(value(kernel.event(0n)).data).toBe(source);
    expect(value(kernel.fetchCompletion(source, 1))).toEqual([1]);
    // Still pending: the level-triggered source stays ready.
    expect(value(kernel.pollWait(bus, 0))).toBe(1);
    expect(value(kernel.fetchCompletion(source, 8))).toEqual([2]);
    await expect(value(kernel.pollWait(bus, 0))).resolves.toBe(0);
  });

  it('answers cancellation with the 0/1/2 protocol', () => {
    const { kernel, source } = setup();
    const job = kernel.pool.insertJob({ kind: 'sleep', ms: 1000 });
    const worker = value(kernel.spawnWorker(7, job));
    // A running sleep is interrupted like nanosleep by SIGUSR2: it finishes without error.
    expect(value(kernel.cancelWorkerWithRetry(worker))).toBe('need-wait');
    expect(value(kernel.pool.job(job)).err).toBeUndefined();
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([7]);
    // Every later completion check sees the published result.
    expect(value(kernel.cancelWorkerWithRetry(worker))).toBe('job-finished');
    expect(value(kernel.pool.cancel(worker))).toBe('need-wait');

    const next = kernel.pool.insertJob({ kind: 'sleep', ms: 1000 });
    value(kernel.pool.wakeWorker(worker, 8, next));
    expect(value(kernel.pool.cancel(worker))).toBe('retry-later');
  });

  it('interrupts a blocked pipe read with EINTR and keeps the reader open meanwhile', () => {
    const { kernel, source } = setup();
    const [reader, writer] = kernel.pipe(false, false);
    const job = value(
      kernel.insertResourceJob(reader, (resource) => ({
        kind: 'stream-read',
        resource,
        len: 16,
        position: -1n,
        result: undefined,
      })),
    );
    const worker = value(kernel.spawnWorker(3, job));
    // Closing the guest handle does not close the end a Job acquired.
    value(kernel.closeFd(reader));
    expect(value(kernel.write(writer, new Uint8Array(0)))).toBe(0);
    expect(value(kernel.cancelWorkerWithRetry(worker))).toBe('need-wait');
    const finished = value(kernel.pool.job(job));
    expect(finished.err).toEqual({ kind: 'native', code: 'EINTR' });
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([3]);
    // Freeing the Job releases the last hold on the read end.
    value(kernel.pool.freeJob(job));
    expect(kernel.write(writer, new Uint8Array(1))).toEqual({
      ok: false,
      error: { kind: 'native', code: 'EPIPE' },
    });
  });

  it('completes a blocking pipe read when data arrives', () => {
    const { kernel, source } = setup();
    const [reader, writer] = kernel.pipe(false, true);
    const job = value(
      kernel.insertResourceJob(reader, (resource) => ({
        kind: 'stream-read',
        resource,
        len: 4,
        position: -1n,
        result: undefined,
      })),
    );
    value(kernel.spawnWorker(5, job));
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([]);
    value(kernel.write(writer, new Uint8Array([1, 2, 3, 4, 5, 6])));
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([5]);
    const done = value(kernel.pool.job(job));
    expect(done.ret).toBe(4);
    expect(done.payload.kind === 'stream-read' && [...(done.payload.result ?? [])]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('writes the whole buffer on a blocking end, across reader progress', () => {
    const { kernel, source } = setup();
    const [reader, writer] = kernel.pipe(true, false);
    const data = new Uint8Array(100_000).fill(7);
    const job = value(
      kernel.insertResourceJob(writer, (resource) => ({
        kind: 'stream-write',
        resource,
        data,
        position: -1n,
      })),
    );
    value(kernel.spawnWorker(9, job));
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([]);
    let total = 0;
    const chunk = new Uint8Array(8192);
    while (total < data.length) {
      total += value(kernel.read(reader, chunk));
    }
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([9]);
    expect(value(kernel.pool.job(job)).ret).toBe(100_000);
  });

  it('returns a displaced early-woken Job unrun and discards results of freed Jobs', () => {
    const { scheduler, kernel, source } = setup();
    const first = kernel.pool.insertJob({ kind: 'sleep', ms: 10 });
    const second = kernel.pool.insertJob({ kind: 'sleep', ms: 10 });
    const third = kernel.pool.insertJob({ kind: 'sleep', ms: 10 });
    const worker = value(kernel.spawnWorker(1, first));
    value(kernel.pool.wakeWorker(worker, 2, second));
    value(kernel.pool.wakeWorker(worker, 3, third));
    // `second` was displaced by `third` and is Ready again.
    expect(value(kernel.pool.job(second)).ret).toBe(0);
    value(kernel.pool.freeJob(first));
    scheduler.advance(10);
    expect(kernel.pool.job(first).ok).toBe(false);
    scheduler.advance(10);
    expect(value(kernel.fetchCompletion(source, 8))).toEqual([1, 3]);
  });

  it('stops delivering to a destroyed pool', () => {
    const { kernel, bus, source } = setup();
    value(kernel.pollDestroy(bus));
    expect(kernel.fetchCompletion(source, 1)).toEqual({ ok: false, error: { kind: 'badf' } });
    expect(kernel.resources.get(source).ok).toBe(false);
    kernel.destroyThreadPool();
    const bus2 = kernel.pollCreate();
    expect(kernel.initThreadPool(bus2).ok).toBe(true);
  });

  it('notifies through an async pipe writer for spawn_worker_with_pipe', () => {
    const { kernel } = setup();
    const [reader, writer] = kernel.pipe(true, true);
    const [, blockingWriter] = kernel.pipe(false, false);
    const job = kernel.pool.insertJob({ kind: 'failed', error: { kind: 'io' } });
    expect(kernel.spawnWorkerWithPipe(1, job, blockingWriter)).toEqual({
      ok: false,
      error: { kind: 'inval' },
    });
    const worker = value(kernel.spawnWorkerWithPipe(0x0102_0304, job, writer));
    const out = new Uint8Array(8);
    expect(value(kernel.read(reader, out))).toBe(4);
    expect([...out.subarray(0, 4)]).toEqual([4, 3, 2, 1]);
    expect(value(kernel.pool.job(job)).err).toEqual({ kind: 'io' });
    expect(kernel.cancelWorkerWithRetry(worker)).toEqual({ ok: false, error: { kind: 'inval' } });
  });

  it('runs stdio stream Jobs against the stdio port', () => {
    const { kernel, stdio, source } = setup(new Uint8Array([65, 66]));
    const out = kernel.resources.stdioHandle(1);
    const write = value(
      kernel.insertResourceJob(out, (resource) => ({
        kind: 'stream-write',
        resource,
        data: new Uint8Array([104, 105]),
        position: -1n,
      })),
    );
    value(kernel.spawnWorker(1, write));
    expect(stdio.out).toEqual([104, 105]);
    const read = value(
      kernel.insertResourceJob(kernel.resources.stdioHandle(0), (resource) => ({
        kind: 'stream-read',
        resource,
        len: 10,
        position: -1n,
        result: undefined,
      })),
    );
    value(kernel.spawnWorker(2, read));
    expect(value(kernel.pool.job(read)).ret).toBe(2);
    expect(value(kernel.fetchCompletion(source, 4))).toEqual([1, 2]);
  });

  it('tears down timers, polls and resources', async () => {
    const { scheduler, kernel } = setup();
    const job: Handle = kernel.pool.insertJob({ kind: 'sleep', ms: 1000 });
    value(kernel.spawnWorker(1, job));
    kernel.pipe(true, true);
    kernel.teardown();
    await flush();
    expect(scheduler.pendingTimers).toBe(0);
    expect(scheduler.disposed).toBe(true);
    expect(kernel.leakSummary()).toBe('jobs=1');
  });
});
