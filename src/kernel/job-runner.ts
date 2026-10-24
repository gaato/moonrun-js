import type { FilePort, HostFd } from '../ports/files.ts';
import type { DnsPort } from '../ports/net.ts';
import type { HostErrorCode } from '../ports/result.ts';
import type { StdioPort } from '../ports/stdio.ts';
import { type AsyncError, BADF, INVAL, IO, native } from './errors.ts';
import type { FileLocks, HostFile } from './file.ts';
import { startFilesystemJob } from './fs-jobs.ts';
import type { FilesystemPayload, Job } from './job.ts';
import { startNetworkJob } from './net-jobs.ts';
import type { PipeEnd } from './pipe.ts';
import { type ProcessEnvironment, startProcessJob } from './process-jobs.ts';
import type { Scheduler, Timer } from './scheduler.ts';
import type { Socket } from './socket.ts';

/** What running Jobs may use. */
export interface JobEnvironment {
  readonly scheduler: Scheduler;
  readonly stdio: StdioPort;
  readonly files: FilePort;
  /** Name resolution for getaddrinfo Jobs. */
  readonly dns: DnsPort;
  readonly locks: FileLocks;
  /** Wraps a descriptor an open Job produced; the Run closes it with its last holder. */
  adoptFile(fd: HostFd, path: string): HostFile;
  /** A lock identity for a resource without a host descriptor. */
  lockKeyOf(owner: object): string;
  /**
   * Host Filesystem authorization (moonrun `filesystem::Job::check_policy`), consulted
   * before a Filesystem Job touches the host; `undefined` allows it.
   */
  authorize(payload: FilesystemPayload): AsyncError | undefined;
  /** Child processes, their policy and the bridges of their streams. */
  readonly processes: ProcessEnvironment;
}

/** A started Job. `done` is called exactly once, possibly before `startJob` returns. */
export interface Execution {
  /**
   * The cancellation signal (moonrun's `SIGUSR2` to the worker thread). A blocked
   * operation completes now (sleep with success, I/O with `EINTR`) and true is
   * returned; false means the operation cannot be interrupted and will finish later.
   */
  interrupt(): boolean;
}

const FINISHED: Execution = { interrupt: () => false };
const EINTR = native('EINTR');

/** Maps an exception from a synchronous port call to the error a syscall would give. */
function thrownError(e: unknown): AsyncError {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') {
    // Unknown codes surface as EIO when the ABI turns them into numbers.
    return native(e.code as HostErrorCode);
  }
  return IO;
}

/** Starts `job` (moonrun `run_host_job`), writing `ret`/`err` and its payload result. */
export function startJob(job: Job, env: JobEnvironment, done: () => void): Execution {
  job.succeed(0);
  const payload = job.payload;
  switch (payload.kind) {
    case 'failed':
      job.fail(payload.error);
      done();
      return FINISHED;
    case 'sleep':
      return sleep(job, payload.ms, env.scheduler, done);
    case 'stream-read':
      if (payload.console === true) {
        job.fail(native('ENOSYS'));
        done();
        return FINISHED;
      }
      return streamRead(job, payload, env, done);
    case 'stream-write':
      if (payload.console === true) {
        job.fail(native('ENOSYS'));
        done();
        return FINISHED;
      }
      return streamWrite(job, payload, env, done);
    case 'bind':
    case 'getaddrinfo':
      return startNetworkJob(job, payload, env.dns, done);
    case 'spawn':
    case 'wait-for-process':
    case 'sigwait':
      return startProcessJob(job, payload, env.processes, done);
    case 'domain':
      // A domain's work runs to completion; it cannot be interrupted (moonrun SQLite Jobs).
      payload.work.start((ret) => {
        job.succeed(ret);
        done();
      });
      return FINISHED;
    default:
      return startFilesystemJob(job, payload, env, done);
  }
}

/** `read_job_worker`/`write_job_worker` on an opened file: `read`/`pread`, `write`/`pwrite`. */
function fileIo(
  job: Job,
  done: () => void,
  io: () => Promise<{ ok: true; value: number } | { ok: false; error: { code: HostErrorCode } }>,
  onRead?: (n: number) => void,
): Execution {
  io().then(
    (r) => {
      if (r.ok) {
        onRead?.(r.value);
        job.succeed(r.value);
      } else {
        job.fail(native(r.error.code));
      }
      done();
    },
    () => {
      job.fail(IO);
      done();
    },
  );
  // Regular-file I/O completes regardless of a cancellation signal (D14 for FIFOs).
  return FINISHED;
}

/** `sleep_job_worker`: `nanosleep` outside a cancellable region, so a signal ends it early. */
function sleep(job: Job, ms: number, scheduler: Scheduler, done: () => void): Execution {
  let timer: Timer | undefined = scheduler.setTimer(Math.max(0, ms), () => {
    timer = undefined;
    done();
  });
  return {
    interrupt: () => {
      if (timer === undefined) {
        return false;
      }
      timer.cancel();
      timer = undefined;
      job.succeed(0);
      done();
      return true;
    },
  };
}

type ReadPayload = Extract<Job['payload'], { kind: 'stream-read' }>;
type WritePayload = Extract<Job['payload'], { kind: 'stream-write' }>;

function streamRead(job: Job, payload: ReadPayload, env: JobEnvironment, done: () => void) {
  const resource = payload.resource;
  if (resource.kind === 'file') {
    const buffer = new Uint8Array(payload.len);
    const position = payload.position >= 0n ? payload.position : undefined;
    return fileIo(
      job,
      done,
      () => env.files.async.read(resource.file.fd, buffer, position),
      (n) => {
        payload.result = buffer.subarray(0, n);
      },
    );
  }
  if (resource.kind === 'stdio' && payload.position >= 0n) {
    // `pread` on the process stream: a regular file supports it, a pipe or terminal is ESPIPE.
    const buffer = new Uint8Array(payload.len);
    return fileIo(
      job,
      done,
      () => env.files.async.read(resource.stream as HostFd, buffer, payload.position),
      (n) => {
        payload.result = buffer.subarray(0, n);
      },
    );
  }
  // Kernel streams have no offset: pread/pwrite on them fail with ESPIPE.
  if (payload.position >= 0n) {
    job.fail(native('ESPIPE'));
    done();
    return FINISHED;
  }
  switch (resource.kind) {
    case 'stdio':
      if (resource.stream !== 0) {
        job.fail(BADF);
        done();
        return FINISHED;
      }
      return stdinRead(job, payload, env, done);
    case 'pipe':
      return pipeRead(job, payload, resource.end, done);
    case 'socket':
      return socketIo(job, resource.socket, done, (socket) => {
        const buffer = new Uint8Array(payload.len);
        const r = socket.read(buffer);
        if (r.ok) {
          payload.result = buffer.subarray(0, r.value);
        }
        return r;
      });
    case 'inotify':
    case 'process':
      job.fail(INVAL);
      done();
      return FINISHED;
    case 'invalid':
    case 'completion-source':
      job.fail(BADF);
      done();
      return FINISHED;
  }
}

/** How long a nonblocking stdin without data waits before reading again (moonrun polls). */
const STDIN_RETRY_MS = 5;

/**
 * `read_from_native_file` on fd 0: one `read` in the host's I/O pool, so the Run keeps going
 * while stdin blocks. A nonblocking stdin without data (`EAGAIN`) is read again after a short
 * wait, and only that wait can be interrupted (`EINTR`); a started read cannot, so a
 * cancellation waits for it and the guest still receives its bytes (D7).
 */
function stdinRead(job: Job, payload: ReadPayload, env: JobEnvironment, done: () => void) {
  const buffer = new Uint8Array(payload.len);
  let retry: Timer | undefined;
  let finished = false;
  const attempt = (): void => {
    retry = undefined;
    env.stdio.readStdinAsync(buffer).then(
      (n) => {
        payload.result = buffer.subarray(0, n);
        job.succeed(n);
        finished = true;
        done();
      },
      (e: unknown) => {
        const error = thrownError(e);
        if (error.kind === 'native' && error.code === 'EAGAIN') {
          retry = env.scheduler.setTimer(STDIN_RETRY_MS, attempt);
          return;
        }
        job.fail(error);
        finished = true;
        done();
      },
    );
  };
  attempt();
  return {
    interrupt: () => {
      if (finished || retry === undefined) {
        return false;
      }
      retry.cancel();
      retry = undefined;
      finished = true;
      job.fail(EINTR);
      done();
      return true;
    },
  };
}

/**
 * A blocking socket `read`/`write` from a worker thread: retried on every
 * readiness change until it stops reporting `EAGAIN` (cancellable).
 */
function socketIo(
  job: Job,
  socket: Socket,
  done: () => void,
  io: (socket: Socket) => { ok: true; value: number } | { ok: false; error: AsyncError },
): Execution {
  let unwatch: (() => void) | undefined;
  const attempt = (): boolean => {
    const r = io(socket);
    if (!r.ok && r.error.kind === 'native' && r.error.code === 'EAGAIN') {
      return false;
    }
    if (r.ok) {
      job.succeed(r.value);
    } else {
      job.fail(r.error);
    }
    return true;
  };
  if (attempt()) {
    done();
    return FINISHED;
  }
  unwatch = socket.watch(() => {
    if (unwatch !== undefined && attempt()) {
      unwatch();
      unwatch = undefined;
      done();
    }
  });
  return {
    interrupt: () => {
      if (unwatch === undefined) {
        return false;
      }
      unwatch();
      unwatch = undefined;
      job.fail(EINTR);
      done();
      return true;
    },
  };
}

/** A blocking `read`: waits (cancellably) until data or end of file. */
function pipeRead(job: Job, payload: ReadPayload, end: PipeEnd, done: () => void): Execution {
  const buffer = new Uint8Array(payload.len);
  let unwatch: (() => void) | undefined;
  const attempt = (): boolean => {
    const r = end.read(buffer);
    if (!r.ok && r.error === 'EAGAIN') {
      return false;
    }
    if (r.ok) {
      payload.result = buffer.subarray(0, r.value);
      job.succeed(r.value);
    } else {
      job.fail(native(r.error));
    }
    return true;
  };
  if (attempt()) {
    done();
    return FINISHED;
  }
  unwatch = end.watch(() => {
    if (unwatch !== undefined && attempt()) {
      unwatch();
      unwatch = undefined;
      done();
    }
  });
  return {
    interrupt: () => {
      if (unwatch === undefined) {
        return false;
      }
      unwatch();
      unwatch = undefined;
      job.fail(EINTR);
      done();
      return true;
    },
  };
}

function streamWrite(job: Job, payload: WritePayload, env: JobEnvironment, done: () => void) {
  const resource = payload.resource;
  if (resource.kind === 'file') {
    const position = payload.position >= 0n ? payload.position : undefined;
    return fileIo(job, done, () => env.files.async.write(resource.file.fd, payload.data, position));
  }
  if (resource.kind === 'stdio' && payload.position >= 0n) {
    // `pwrite` on the process stream: a regular file supports it, a pipe or terminal is ESPIPE.
    return fileIo(job, done, () =>
      env.files.async.write(resource.stream as HostFd, payload.data, payload.position),
    );
  }
  // Kernel streams have no offset: pread/pwrite on them fail with ESPIPE.
  if (payload.position >= 0n) {
    job.fail(native('ESPIPE'));
    done();
    return FINISHED;
  }
  switch (resource.kind) {
    case 'stdio': {
      try {
        if (resource.stream === 1) {
          env.stdio.writeStdout(payload.data);
          job.succeed(payload.data.length);
        } else if (resource.stream === 2) {
          env.stdio.writeStderr(payload.data);
          job.succeed(payload.data.length);
        } else {
          job.fail(BADF);
        }
      } catch (e) {
        job.fail(thrownError(e));
      }
      done();
      return FINISHED;
    }
    case 'pipe':
      return pipeWrite(job, payload, resource.end, done);
    case 'socket':
      return socketIo(job, resource.socket, done, (socket) => socket.write(payload.data));
    case 'inotify':
    case 'process':
      job.fail(INVAL);
      done();
      return FINISHED;
    case 'invalid':
    case 'completion-source':
      job.fail(BADF);
      done();
      return FINISHED;
  }
}

/**
 * A `write` from a worker thread: on a blocking end it does not return before
 * everything is written (or the reader goes away); on a nonblocking end it waits
 * for room once and returns what fitted, like `write_to_native_file`'s poll loop.
 */
function pipeWrite(job: Job, payload: WritePayload, end: PipeEnd, done: () => void): Execution {
  const data = payload.data;
  let written = 0;
  let unwatch: (() => void) | undefined;
  const attempt = (): boolean => {
    for (;;) {
      const r = end.write(data.subarray(written));
      if (!r.ok) {
        if (r.error === 'EAGAIN') {
          return false;
        }
        if (written > 0) {
          job.succeed(written);
        } else {
          job.fail(native(r.error));
        }
        return true;
      }
      written += r.value;
      if (written >= data.length || end.nonblocking) {
        job.succeed(written);
        return true;
      }
    }
  };
  if (attempt()) {
    done();
    return FINISHED;
  }
  unwatch = end.watch(() => {
    if (unwatch !== undefined && attempt()) {
      unwatch();
      unwatch = undefined;
      done();
    }
  });
  return {
    interrupt: () => {
      if (unwatch === undefined) {
        return false;
      }
      unwatch();
      unwatch = undefined;
      if (written > 0) {
        job.succeed(written);
      } else {
        job.fail(EINTR);
      }
      done();
      return true;
    },
  };
}
