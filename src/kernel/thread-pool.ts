import { err, ok, type Result } from '../ports/result.ts';
import type { CBuffers } from './c-buffers.ts';
import type { CompletionSource } from './completion.ts';
import { type AsyncError, BADF, INVAL } from './errors.ts';
import { type Handle, Handles, type HostKeys } from './handles.ts';
import { Job, type JobPayload, type JobSlot } from './job.ts';
import { type Execution, type JobEnvironment, startJob } from './job-runner.ts';
import type { PipeEnd } from './pipe.ts';
import { relinquish } from './resource.ts';

/** What the pool needs besides the Job environment: c_buffer leases and published results. */
export interface PoolEnvironment extends JobEnvironment {
  readonly cBuffers: CBuffers;
}

/** Where a Worker announces finished Jobs (moonrun `WorkerCompletionDestination`). */
export type CompletionTarget =
  | { readonly kind: 'pool'; readonly source: CompletionSource }
  /** `spawn_worker_with_pipe`: 4-byte little-endian ids written to an async pipe. */
  | { readonly kind: 'pipe'; readonly writer: PipeEnd };

/** The 0/1/2 protocol of `cancel_worker_with_retry`. */
export type CancellationOutcome = 'retry-later' | 'need-wait' | 'job-finished';

interface Assignment {
  readonly completionId: number;
  readonly jobHandle: Handle;
  readonly job: Job;
}

/**
 * A Worker's lifecycle. `running` owns a Job; `waiting` has published its last
 * completion and waits for `wake_worker`; `stopped` was freed (a Job that could not
 * be interrupted may still finish, and its result is still handed back).
 */
type WorkerState =
  | {
      readonly kind: 'running';
      readonly assignment: Assignment;
      execution: Execution | undefined;
    }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'stopped'; readonly finishing: Assignment | undefined };

class Worker {
  state: WorkerState;
  /** A Job assigned by an early wake while another one runs. */
  queued: Assignment | undefined;
  readonly target: CompletionTarget;

  constructor(assignment: Assignment, target: CompletionTarget) {
    this.state = { kind: 'running', assignment, execution: undefined };
    this.target = target;
  }
}

/**
 * Jobs and Workers of one Run (moonrun `JobTable` + `InstanceWorkers`).
 *
 * Workers run Jobs on the JavaScript event loop instead of threads: a Job either
 * finishes inside the call that starts it or completes from a host callback
 * (timer, pipe readiness). Completion order is "publish the result, mark the
 * Worker waiting, then notify", so a completion id never names an unfinished Job.
 */
export class ThreadPool {
  readonly #jobs: Handles<JobSlot>;
  readonly #workers: Handles<Worker>;
  readonly #env: PoolEnvironment;
  /** Payloads whose resource holds and buffer leases already ended. */
  readonly #settled = new WeakSet<JobPayload>();

  constructor(keys: HostKeys, env: PoolEnvironment) {
    this.#jobs = new Handles(keys, 'job');
    this.#workers = new Handles(keys, 'worker');
    this.#env = env;
  }

  insertJob(payload: JobPayload): Handle {
    return this.#jobs.insert({ state: 'ready', job: new Job(payload) });
  }

  /** A Job the guest may inspect: not while a Worker owns it. */
  job(handle: Handle): Result<Job, AsyncError> {
    const slot = this.#jobs.get(handle);
    return slot !== undefined && slot.state !== 'reserved' ? ok(slot.job) : err(BADF);
  }

  freeJob(handle: Handle): Result<void, AsyncError> {
    const slot = this.#jobs.remove(handle);
    if (slot === undefined) {
      return err(BADF);
    }
    if (slot.state !== 'reserved') {
      this.#discard(slot.job.payload);
    }
    return ok(undefined);
  }

  /**
   * Ends what a Job holds once it has run (moonrun drops the Job's `ResourceRef` after
   * `run` and restores the readdir buffer lease with the result).
   */
  #settle(payload: JobPayload): void {
    if (this.#settled.has(payload)) {
      return;
    }
    this.#settled.add(payload);
    releasePayload(payload, this.#env.cBuffers);
  }

  /** A Job leaves the table: its holds, its unclaimed results and its published c_buffer. */
  #discard(payload: JobPayload): void {
    this.#settle(payload);
    switch (payload.kind) {
      case 'open':
        if (payload.result?.opened.state === 'unpublished') {
          payload.result.opened.file.release();
          payload.result = undefined;
        }
        return;
      case 'realpath':
        // Native realpath frees the resolved path in the Job finalizer.
        if (payload.result?.state === 'published') {
          this.#env.cBuffers.free(payload.result.handle);
        }
        return;
      default:
        return;
    }
  }

  /** `run_job`: runs a Job on the guest's own thread. */
  runJob(handle: Handle): Result<void, AsyncError> {
    const job = this.#take(handle);
    if (!job.ok) {
      return job;
    }
    startJob(job.value, this.#env, () => {
      this.#settle(job.value.payload);
      this.#restore(handle, job.value);
    });
    return ok(undefined);
  }

  spawnWorker(
    completionId: number,
    jobHandle: Handle,
    target: CompletionTarget,
  ): Result<Handle, AsyncError> {
    const job = this.#take(jobHandle);
    if (!job.ok) {
      return job;
    }
    const assignment = { completionId, jobHandle, job: job.value };
    const worker = new Worker(assignment, target);
    if (target.kind === 'pipe') {
      target.writer.retain();
    }
    const handle = this.#workers.insert(worker);
    this.#run(worker, assignment);
    return ok(handle);
  }

  wakeWorker(
    workerHandle: Handle,
    completionId: number,
    jobHandle: Handle,
  ): Result<void, AsyncError> {
    const worker = this.#workers.get(workerHandle);
    if (worker === undefined) {
      return err(BADF);
    }
    const job = this.#take(jobHandle);
    if (!job.ok) {
      return job;
    }
    const assignment = { completionId, jobHandle, job: job.value };
    switch (worker.state.kind) {
      case 'waiting':
        this.#run(worker, assignment);
        return ok(undefined);
      case 'running': {
        const displaced = worker.queued;
        worker.queued = assignment;
        if (displaced !== undefined) {
          this.#restoreUnrun(displaced);
        }
        return ok(undefined);
      }
      case 'stopped':
        this.#restoreUnrun(assignment);
        return ok(undefined);
    }
  }

  workerEnterIdle(workerHandle: Handle): Result<void, AsyncError> {
    const worker = this.#workers.get(workerHandle);
    if (worker === undefined) {
      return err(BADF);
    }
    const queued = worker.queued;
    worker.queued = undefined;
    if (queued !== undefined) {
      this.#restoreUnrun(queued);
    }
    return ok(undefined);
  }

  freeWorker(workerHandle: Handle): Result<void, AsyncError> {
    const worker = this.#workers.remove(workerHandle);
    if (worker === undefined) {
      return err(BADF);
    }
    this.#stop(worker);
    return ok(undefined);
  }

  /** `cancel_worker_with_retry`: 2 once the current Job's result is published. */
  cancelWithRetry(
    workerHandle: Handle,
    source: CompletionSource,
  ): Result<CancellationOutcome, AsyncError> {
    const worker = this.#workers.get(workerHandle);
    if (worker === undefined) {
      return err(BADF);
    }
    if (worker.target.kind === 'pipe') {
      // A supplied pipe carries finished ids only and cannot route retries.
      return err(INVAL);
    }
    if (worker.target.source !== source) {
      return err(BADF);
    }
    if (worker.state.kind !== 'running') {
      return ok('job-finished');
    }
    worker.state.execution?.interrupt();
    return ok('need-wait');
  }

  /** The compat `cancel_worker`: no completion check, and no retry notifications. */
  cancel(workerHandle: Handle): Result<CancellationOutcome, AsyncError> {
    const worker = this.#workers.get(workerHandle);
    if (worker === undefined) {
      return err(BADF);
    }
    if (worker.state.kind !== 'running') {
      return ok('need-wait');
    }
    worker.state.execution?.interrupt();
    return ok('retry-later');
  }

  /** Stops every Worker (thread pool destruction or Run teardown). */
  destroyWorkers(): void {
    for (const worker of this.#workers.takeAll()) {
      this.#stop(worker);
    }
  }

  get workerCount(): number {
    return this.#workers.size;
  }

  get jobCount(): number {
    return this.#jobs.size;
  }

  #take(handle: Handle): Result<Job, AsyncError> {
    const slot = this.#jobs.get(handle);
    if (slot?.state !== 'ready') {
      return err(BADF);
    }
    this.#jobs.set(handle, { state: 'reserved' });
    return ok(slot.job);
  }

  /** Hands a finished Job back; a Job freed while running is discarded. */
  #restore(handle: Handle, job: Job): void {
    if (this.#jobs.get(handle)?.state === 'reserved') {
      this.#jobs.set(handle, { state: 'result-ready', job });
    } else {
      this.#discard(job.payload);
    }
  }

  #restoreUnrun(assignment: Assignment): void {
    if (this.#jobs.get(assignment.jobHandle)?.state === 'reserved') {
      this.#jobs.set(assignment.jobHandle, { state: 'ready', job: assignment.job });
    } else {
      this.#discard(assignment.job.payload);
    }
  }

  #run(worker: Worker, assignment: Assignment): void {
    const state: WorkerState = { kind: 'running', assignment, execution: undefined };
    worker.state = state;
    const execution = startJob(assignment.job, this.#env, () => this.#finish(worker, assignment));
    if (worker.state === state) {
      state.execution = execution;
    }
  }

  #finish(worker: Worker, assignment: Assignment): void {
    this.#settle(assignment.job.payload);
    this.#restore(assignment.jobHandle, assignment.job);
    const stopped = worker.state.kind === 'stopped';
    if (stopped) {
      worker.state = { kind: 'stopped', finishing: undefined };
    } else {
      worker.state = { kind: 'waiting' };
    }
    const next = stopped ? undefined : worker.queued;
    worker.queued = undefined;
    this.#notify(worker, assignment.completionId, stopped);
    if (next !== undefined) {
      this.#run(worker, next);
    }
  }

  #notify(worker: Worker, completionId: number, stopped: boolean): void {
    const target = worker.target;
    switch (target.kind) {
      case 'pool':
        // As in moonrun, a pool Worker still reports a Job that finishes after free_worker.
        target.source.notify(completionId);
        return;
      case 'pipe':
        if (!stopped) {
          writeCompletion(target.writer, completionId, () => worker.state.kind === 'stopped');
        }
        return;
    }
  }

  /** moonrun `free_worker`: cancel, return a queued Job unrun, let the current one finish. */
  #stop(worker: Worker): void {
    const queued = worker.queued;
    worker.queued = undefined;
    if (queued !== undefined) {
      this.#restoreUnrun(queued);
    }
    const state = worker.state;
    if (state.kind === 'running') {
      worker.state = { kind: 'stopped', finishing: state.assignment };
      state.execution?.interrupt();
    } else {
      worker.state = { kind: 'stopped', finishing: undefined };
    }
    if (worker.target.kind === 'pipe') {
      worker.target.writer.release();
    }
  }
}

/** Ends a Job's holds on the resources its payload acquired and returns its buffer lease. */
function releasePayload(payload: JobPayload, cBuffers: CBuffers): void {
  switch (payload.kind) {
    case 'stream-read':
    case 'stream-write':
    case 'fstatx':
    case 'file-size':
    case 'file-time':
    case 'fsync':
    case 'flock':
    case 'inotify-add-watch':
    case 'bind':
      relinquish(payload.resource);
      return;
    case 'readdir':
      relinquish(payload.resource);
      cBuffers.restore(payload.buffer.handle, payload.buffer.bytes);
      return;
    case 'statx':
    case 'file-kind-by-path':
      if (payload.parent !== undefined) {
        relinquish(payload.parent);
      }
      return;
    case 'failed':
    case 'sleep':
    case 'open':
    case 'file-time-by-path':
    case 'access':
    case 'chmod':
    case 'remove':
    case 'rename':
    case 'symlink':
    case 'mkdir':
    case 'rmdir':
    case 'realpath':
    case 'getaddrinfo':
      return;
  }
}

/** `PipeCompletionNotifier::notify`: an atomic 4-byte write, waiting for room if needed. */
function writeCompletion(writer: PipeEnd, completionId: number, stopping: () => boolean): void {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, completionId, true);
  const attempt = (): boolean => {
    const r = writer.write(bytes);
    return r.ok || r.error !== 'EAGAIN';
  };
  if (attempt()) {
    return;
  }
  const unwatch = writer.watch(() => {
    if (stopping() || attempt()) {
      unwatch();
    }
  });
}
