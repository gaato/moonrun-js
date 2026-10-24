import { BADF, FAULT } from '../../kernel/errors.ts';
import type { CancellationOutcome } from '../../kernel/thread-pool.ts';
import { err, ok } from '../../ports/result.ts';
import { LINUX_ERRNO } from '../errno.ts';
import { type AsyncEnv, AsyncFailure, errnoOf, handle, status, unwrap } from './env.ts';
import { isFilesystem } from './fs.ts';
import { checkedAdd } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** `CancellationOutcome::as_i32`. */
function outcomeCode(outcome: CancellationOutcome): number {
  switch (outcome) {
    case 'retry-later':
      return 0;
    case 'need-wait':
      return 1;
    case 'job-finished':
      return 2;
  }
}

/** `thread_pool/*`: Jobs, Workers and the Completion Queue. */
export function threadPool(env: AsyncEnv) {
  const { kernel, memory } = env;
  const pool = kernel.pool;
  return {
    'thread_pool/init_thread_pool': (poll) => unwrap(kernel.initThreadPool(handle(poll))),
    'thread_pool/destroy_thread_pool': () => kernel.destroyThreadPool(),
    'thread_pool/job_get_ret': (job) => unwrap(pool.job(handle(job))).ret | 0,
    'thread_pool/job_get_err': (job) => {
      const error = unwrap(pool.job(handle(job))).err;
      return error === undefined ? 0 : errnoOf(error);
    },
    'thread_pool/free_job': (job) => unwrap(pool.freeJob(handle(job))),
    'thread_pool/run_job': {
      suspends: true,
      impl: (job) => new Promise<void>((resolve) => unwrap(pool.runJob(handle(job), resolve))),
    },
    'thread_pool/spawn_worker': (completionId, job) =>
      unwrap(kernel.spawnWorker(completionId, handle(job))),
    'thread_pool/spawn_worker_with_pipe': (completionId, job, writer) =>
      unwrap(kernel.spawnWorkerWithPipe(completionId, handle(job), handle(writer))),
    'thread_pool/wake_worker': (worker, completionId, job) =>
      unwrap(pool.wakeWorker(handle(worker), completionId, handle(job))),
    'thread_pool/worker_enter_idle': (worker) => unwrap(pool.workerEnterIdle(handle(worker))),
    'thread_pool/free_worker': (worker) => unwrap(pool.freeWorker(handle(worker))),
    'thread_pool/cancel_worker': (worker) => outcomeCode(unwrap(pool.cancel(handle(worker)))),
    'thread_pool/cancel_worker_with_retry': (worker) =>
      outcomeCode(unwrap(kernel.cancelWorkerWithRetry(handle(worker)))),
    'thread_pool/errno_is_cancelled': (errno) => (errno === LINUX_ERRNO.EINTR ? 1 : 0),
    'thread_pool/fetch_completion/unix': (source, dst, maxJobs) =>
      status(env, () => {
        const checked = kernel.fetchCompletion(handle(source), 0);
        if (!checked.ok || maxJobs === 0) {
          return checked.ok ? ok(0) : checked;
        }
        const bytes = maxJobs * 4;
        if (bytes > 0xffff_ffff) {
          return err(FAULT);
        }
        const view = memory.view(dst, bytes);
        const ids = unwrap(kernel.fetchCompletion(handle(source), maxJobs));
        const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
        ids.forEach((id, i) => {
          data.setInt32(i * 4, id, true);
        });
        return ok(ids.length * 4);
      }),
    'thread_pool/make_sleep_job': (durationMs) => pool.insertJob({ kind: 'sleep', ms: durationMs }),
    // Console jobs use UTF-16 units. Like upstream on Unix, running them
    // returns ENOSYS; construction still validates lengths and owns the fd.
    'thread_pool/make_read_console_job': (fd, len) => {
      const bytes = checkedAdd(len, len);
      return unwrap(
        kernel.insertResourceJob(handle(fd), (resource) => ({
          kind: 'stream-read',
          resource,
          len: bytes,
          position: -1n,
          result: undefined,
          console: true,
        })),
      );
    },
    'thread_pool/make_write_console_job': (fd, ptr, offset, len) => {
      unwrap(kernel.resources.get(handle(fd)));
      const data = memory.copyOut(
        checkedAdd(ptr, checkedAdd(offset, offset)),
        checkedAdd(len, len),
      );
      return unwrap(
        kernel.insertResourceJob(handle(fd), (resource) => ({
          kind: 'stream-write',
          resource,
          data,
          position: -1n,
          console: true,
        })),
      );
    },
    'thread_pool/get_read_console_result': (job, dst, offset, len) => {
      const found = unwrap(pool.job(handle(job)));
      const payload = found.payload;
      if (!isFilesystem(payload)) throw new AsyncFailure(BADF);
      if (found.err !== undefined) return;
      if (
        payload.kind !== 'stream-read' ||
        payload.console !== true ||
        payload.result === undefined
      ) {
        throw new AsyncFailure(BADF);
      }
      const target = checkedAdd(dst, checkedAdd(offset, offset));
      const bytes = checkedAdd(len, len);
      if (payload.result.length > bytes) throw new AsyncFailure(FAULT);
      memory.view(target, bytes).set(payload.result);
    },
    'thread_pool/make_read_job': (fd, len, position) =>
      unwrap(
        kernel.insertResourceJob(handle(fd), (resource) => ({
          kind: 'stream-read',
          resource,
          len,
          position,
          result: undefined,
        })),
      ),
    'thread_pool/make_write_job': (fd, ptr, offset, len, position) => {
      unwrap(kernel.resources.get(handle(fd)));
      const data = memory.copyOut(checkedAdd(ptr, offset), len);
      return unwrap(
        kernel.insertResourceJob(handle(fd), (resource) => ({
          kind: 'stream-write',
          resource,
          data,
          position,
        })),
      );
    },
    'thread_pool/get_read_result': (job, dst, offset, len) => {
      const found = unwrap(pool.job(handle(job)));
      const payload = found.payload;
      if (!isFilesystem(payload)) {
        throw new AsyncFailure(BADF);
      }
      if (found.err !== undefined) {
        return;
      }
      if (payload.kind !== 'stream-read' || payload.result === undefined) {
        throw new AsyncFailure(BADF);
      }
      const target = checkedAdd(dst, offset);
      if (payload.result.length > len) {
        throw new AsyncFailure(FAULT);
      }
      memory.view(target, len).set(payload.result);
    },
  } satisfies HandlerGroup;
}
