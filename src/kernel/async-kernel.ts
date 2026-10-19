import type { FilePort, HostFd } from '../ports/files.ts';
import type { DnsPort, NetPort } from '../ports/net.ts';
import type { ProcessPort, SignalPort } from '../ports/process.ts';
import { err, type HostErrorCode, ok, type Result } from '../ports/result.ts';
import type { StdioPort } from '../ports/stdio.ts';
import { CBuffers } from './c-buffers.ts';
import { CompletionSource } from './completion.ts';
import { type AsyncError, BADF, FAULT, INVAL, IO, native } from './errors.ts';
import {
  type FdKind,
  FileLocks,
  fdKindOfMode,
  fileKindCode,
  HostFile,
  inodeKey,
  STAT_DEVICE_ID,
  STAT_FILE_ID,
  STAT_FILE_KIND,
} from './file.ts';
import { lockOwner } from './fs-jobs.ts';
import { type Handle, Handles, HostKeys } from './handles.ts';
import { Inotify } from './inotify.ts';
import type { FilesystemPayload, JobPayload } from './job.ts';
import { KernelNetwork, type NetworkRequest } from './network.ts';
import { makePipe } from './pipe.ts';
import { Poller } from './poller.ts';
import { Children, ProcessInputs } from './process.ts';
import type { ProcessEnvironment } from './process-jobs.ts';
import { KernelProcesses, type ProcessOptions } from './processes.ts';
import { EPOLLIN, EPOLLOUT, EPOLLRDHUP } from './readiness.ts';
import { acquire, pollableOf, type Resource, ResourceTable, type StdioStream } from './resource.ts';
import type { Scheduler } from './scheduler.ts';
import { RunSignals } from './signals.ts';
import { type CancellationOutcome, ThreadPool } from './thread-pool.ts';

export type { FdKind } from './file.ts';

export interface AsyncKernelOptions {
  readonly stdio: StdioPort;
  readonly scheduler: Scheduler;
  /** `fstat` of a process standard stream. */
  readonly stdioKind: (stream: StdioStream) => Result<FdKind, AsyncError>;
  /** Host files for Filesystem Jobs. */
  readonly files: FilePort;
  /**
   * Host Filesystem authorization of a Filesystem Job before it runs (the seam for
   * `--policy`); allows everything when absent.
   */
  readonly authorizeFilesystem?: (payload: FilesystemPayload) => AsyncError | undefined;
  /** Sockets. */
  readonly net: NetPort;
  /** Name resolution for getaddrinfo Jobs. */
  readonly dns: DnsPort;
  /**
   * Host Network authorization (the seam for `--policy`, moonrun `HostNetwork::check_*`);
   * allows everything when absent.
   */
  readonly authorizeNetwork?: (request: NetworkRequest) => AsyncError | undefined;
  /** Addresses of a getaddrinfo result the guest fetched (for the policy's resolved rules). */
  readonly recordResolved?: (host: string, addresses: readonly Uint8Array[]) => void;
  /** Child processes and their policy seams; without it spawning fails with `ENOSYS`. */
  readonly process?: ProcessOptions;
  /** OS signal capture for the guest's cancellation signals; none when absent. */
  readonly osSignals?: SignalPort;
}

/** A host without child processes. */
const NO_PROCESSES: ProcessPort = {
  spawn: () => Promise.resolve(err({ code: 'ENOSYS' })),
  kill: () => err({ code: 'ENOSYS' }),
  openPolicyTransfer: () => err({ code: 'ENOSYS' }),
  closeFd: () => {},
};

/** The thread pool's binding to one poll instance (moonrun `ThreadPoolRegistration`). */
interface PoolRegistration {
  readonly poll: Handle;
  readonly source: CompletionSource;
  readonly sourceHandle: Handle;
  readonly sourceResource: Resource;
}

function fileKind(kind: FdKind | undefined): number {
  return kind === undefined ? 0 : fileKindCode(kind);
}

function syscallError(e: unknown): AsyncError {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') {
    return native(e.code as HostErrorCode);
  }
  return IO;
}

/**
 * The Async Host of one Run: every `moonbitlang/async` object behind the shared
 * handle namespace, plus the per-run errno. It mirrors moonrun's `AsyncHost`
 * method by method; the ABI layer only decodes arguments and encodes results.
 */
export class AsyncKernel {
  readonly keys = new HostKeys();
  readonly resources: ResourceTable;
  readonly cBuffers: CBuffers;
  readonly pool: ThreadPool;
  readonly network: KernelNetwork;
  readonly signals: RunSignals;
  /** Child processes (moonrun `HostProcess`). */
  readonly processes: KernelProcesses;
  /** `flock` locks of this Run. */
  readonly locks = new FileLocks();
  readonly #lockKeys = new WeakMap<object, string>();
  #nextLockKey = 0;
  /** `errno` as `os_error/get_errno` reports it. */
  errno = 0;
  /** The TLS family's handle table (moonrun `tls_connections`), counted by {@link leakSummary}. */
  tlsConnections: { readonly size: number } = { size: 0 };
  readonly #polls: Handles<Poller>;
  readonly #options: AsyncKernelOptions;
  #currentEventPoll: Handle | undefined;
  #registration: PoolRegistration | undefined;

  constructor(options: AsyncKernelOptions) {
    this.#options = options;
    // Construction order fixes the reserved handle values (invalid, stdin, stdout, stderr).
    this.resources = new ResourceTable(this.keys);
    this.cBuffers = new CBuffers(this.keys);
    this.#polls = new Handles(this.keys, 'poll');
    const authorize = options.authorizeFilesystem ?? (() => undefined);
    this.signals = new RunSignals(options.osSignals);
    const processOptions = options.process;
    const processEnvironment: ProcessEnvironment = {
      port: processOptions?.port ?? NO_PROCESSES,
      children: new Children(),
      authorizeSpawn: processOptions?.authorizeSpawn,
      inheritance: processOptions?.inheritance,
      authority: processOptions?.authority,
    };
    this.pool = new ThreadPool(this.keys, {
      processes: processEnvironment,
      scheduler: options.scheduler,
      stdio: options.stdio,
      files: options.files,
      dns: options.dns,
      locks: this.locks,
      cBuffers: this.cBuffers,
      adoptFile: (fd, path) => this.#adoptFile(fd, path),
      lockKeyOf: (owner) => this.#lockKeyOf(owner),
      authorize,
    });
    this.processes = new KernelProcesses(
      new ProcessInputs(this.keys),
      this.resources,
      this.pool,
      this.signals,
      () => ({
        registered: this.#registration !== undefined,
        source: this.#registration?.source,
      }),
      processEnvironment,
    );
    this.network = new KernelNetwork(this.keys, this.resources, this.pool, this.cBuffers, {
      net: options.net,
      ...(options.authorizeNetwork === undefined ? {} : { authorize: options.authorizeNetwork }),
      ...(options.recordResolved === undefined ? {} : { recordResolved: options.recordResolved }),
    });
  }

  get scheduler(): Scheduler {
    return this.#options.scheduler;
  }

  // ----- event bus -----

  pollCreate(): Handle {
    return this.#polls.insert(new Poller(this.#options.scheduler));
  }

  pollDestroy(handle: Handle): Result<void, AsyncError> {
    const poller = this.#polls.remove(handle);
    if (poller === undefined) {
      return err(BADF);
    }
    if (this.#currentEventPoll === handle) {
      this.#currentEventPoll = undefined;
    }
    if (this.#registration?.poll === handle) {
      this.#unregisterPool(this.#registration);
    }
    poller.close();
    return ok(undefined);
  }

  /** `event_bus/try_register`: 1 registered, 0 not pollable, error otherwise. */
  pollRegister(bus: Handle, fd: Handle, readOnly: boolean): Result<0 | 1, AsyncError> {
    const registered = this.#register(bus, fd, readOnly);
    if (!registered.ok) {
      return registered;
    }
    return ok(registered.value ? 1 : 0);
  }

  /** The pre-tri-state `event_bus/register`: an unpollable resource is `EPERM`. */
  pollRegisterLegacy(bus: Handle, fd: Handle, readOnly: boolean): Result<void, AsyncError> {
    const registered = this.#register(bus, fd, readOnly);
    if (!registered.ok) {
      return registered;
    }
    return registered.value ? ok(undefined) : err(native('EPERM'));
  }

  pollWait(bus: Handle, timeoutMs: number): Result<number | Promise<number>, AsyncError> {
    const poller = this.#polls.get(bus);
    if (poller === undefined) {
      return err(BADF);
    }
    const count = poller.wait(timeoutMs);
    if (typeof count === 'number') {
      this.#currentEventPoll = bus;
      return ok(count);
    }
    return ok(
      count.then((n) => {
        this.#currentEventPoll = bus;
        return n;
      }),
    );
  }

  /** `event_bus/get_event`: the event's index in the last wait of `bus`. */
  pollGetEvent(bus: Handle, index: number): Result<bigint, AsyncError> {
    const poller = this.#polls.get(bus);
    if (poller === undefined || this.#currentEventPoll !== bus) {
      return err(BADF);
    }
    return index < poller.events.length ? ok(BigInt(index)) : err(FAULT);
  }

  /** The event at `event` (an index) of the last wait: its user data and epoll bits. */
  event(event: bigint): Result<{ readonly data: bigint; readonly events: number }, AsyncError> {
    if (event > 0xffff_ffffn) {
      return err(FAULT);
    }
    const current = this.#currentEventPoll;
    const poller = current === undefined ? undefined : this.#polls.get(current);
    if (poller === undefined) {
      return err(BADF);
    }
    const found = poller.events[Number(event)];
    return found === undefined ? err(FAULT) : ok(found);
  }

  // ----- thread pool -----

  initThreadPool(bus: Handle): Result<Handle, AsyncError> {
    const poller = this.#polls.get(bus);
    if (poller === undefined) {
      return err(BADF);
    }
    if (this.#registration !== undefined) {
      return err(INVAL);
    }
    const source = new CompletionSource();
    const sourceResource: Resource = { kind: 'completion-source', source };
    const sourceHandle = this.resources.insert(sourceResource);
    // Level-triggered: readable for as long as completions are pending.
    poller.register(sourceResource, source, EPOLLIN, 'level', sourceHandle);
    this.#registration = { poll: bus, source, sourceHandle, sourceResource };
    return ok(sourceHandle);
  }

  destroyThreadPool(): void {
    this.signals.stop();
    this.pool.destroyWorkers();
    if (this.#registration !== undefined) {
      this.#unregisterPool(this.#registration);
    }
  }

  spawnWorker(completionId: number, job: Handle): Result<Handle, AsyncError> {
    const registration = this.#registration;
    if (registration === undefined) {
      return err(BADF);
    }
    return this.pool.spawnWorker(completionId, job, { kind: 'pool', source: registration.source });
  }

  spawnWorkerWithPipe(
    completionId: number,
    job: Handle,
    writer: Handle,
  ): Result<Handle, AsyncError> {
    const resource = this.resources.get(writer);
    if (!resource.ok) {
      return resource;
    }
    const value = resource.value;
    if (value.kind !== 'pipe' || !value.asyncWriter) {
      return err(INVAL);
    }
    return this.pool.spawnWorker(completionId, job, { kind: 'pipe', writer: value.end });
  }

  cancelWorkerWithRetry(worker: Handle): Result<CancellationOutcome, AsyncError> {
    const registration = this.#registration;
    if (registration === undefined) {
      return err(BADF);
    }
    return this.pool.cancelWithRetry(worker, registration.source);
  }

  /** `fetch_completion/unix`: up to `max` completion ids (signals first). */
  fetchCompletion(source: Handle, max: number): Result<number[], AsyncError> {
    const registration = this.#registration;
    if (registration === undefined || registration.sourceHandle !== source) {
      return err(BADF);
    }
    return ok(max === 0 ? [] : registration.source.fetch(max));
  }

  /** `start_signal_handler`: needs the thread pool's Completion Source. */
  startSignalHandler(): Result<void, AsyncError> {
    if (this.#registration === undefined) {
      return err(BADF);
    }
    return this.signals.start(this.#registration.source);
  }

  /** Makes a Job over a resource, acquiring it for the Job's lifetime. */
  insertResourceJob(
    fd: Handle,
    make: (resource: Resource) => JobPayload,
  ): Result<Handle, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    return ok(this.pool.insertJob(make(acquire(resource.value))));
  }

  // ----- resources -----

  stdHandle(id: number): Result<Handle, AsyncError> {
    if (id !== 0 && id !== 1 && id !== 2) {
      return err(INVAL);
    }
    return ok(this.resources.stdioHandle(id));
  }

  /** `fd_util/pipe`: a read and a write handle; async ends start nonblocking. */
  pipe(readAsync: boolean, writeAsync: boolean): [Handle, Handle] {
    const [reader, writer] = makePipe(readAsync, writeAsync);
    return [
      this.resources.insert({ kind: 'pipe', end: reader, asyncWriter: false }),
      this.resources.insert({ kind: 'pipe', end: writer, asyncWriter: writeAsync }),
    ];
  }

  closeFd(fd: Handle): Result<void, AsyncError> {
    const resource = this.resources.remove(fd);
    if (!resource.ok) {
      return resource;
    }
    this.processes.closed(fd, resource.value);
    for (const [, poller] of this.#polls.entries()) {
      poller.unregister(resource.value);
    }
    if (this.#registration?.sourceHandle === fd) {
      this.#unregisterPool(this.#registration);
    }
    return ok(undefined);
  }

  kindOfFd(fd: Handle): Result<FdKind, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const value = resource.value;
    switch (value.kind) {
      case 'stdio':
        return this.#options.stdioKind(value.stream);
      case 'pipe':
      case 'completion-source':
        return ok('pipe');
      case 'file': {
        const stat = this.#options.files.fstat(value.file.fd);
        return stat.ok ? ok(fdKindOfMode(stat.value.mode)) : err(native(stat.error.code));
      }
      case 'inotify':
      case 'process':
        // An anonymous inode: `st_mode` has no file type.
        return ok('unknown');
      case 'socket':
        return ok('socket');
      case 'invalid':
        return err(BADF);
    }
  }

  setCloexec(fd: Handle): Result<void, AsyncError> {
    const resource = this.resources.get(fd);
    return resource.ok ? ok(undefined) : resource;
  }

  /** `io/read/unix`: one nonblocking `read(2)`. */
  read(fd: Handle, dst: Uint8Array): Result<number, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const value = resource.value;
    switch (value.kind) {
      case 'pipe': {
        // A blocking end would block the whole Run in moonrun; report EAGAIN instead.
        const r = value.end.read(dst);
        return r.ok ? r : err(native(r.error));
      }
      case 'stdio':
        if (value.stream !== 0) {
          return err(native('EBADF'));
        }
        try {
          return ok(this.#options.stdio.readStdin(dst));
        } catch (e) {
          return err(syscallError(e));
        }
      case 'completion-source':
        return err(native('EAGAIN'));
      case 'file': {
        const r = this.#options.files.read(value.file.fd, dst);
        return r.ok ? r : err(native(r.error.code));
      }
      case 'inotify':
      case 'process':
        return err(INVAL);
      case 'socket':
        return value.socket.read(dst);
      case 'invalid':
        return err(BADF);
    }
  }

  /** `io/write/unix`: one nonblocking `write(2)`; stdio bypasses the line-buffered print path. */
  write(fd: Handle, src: Uint8Array): Result<number, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const value = resource.value;
    switch (value.kind) {
      case 'pipe': {
        const r = value.end.write(src);
        return r.ok ? r : err(native(r.error));
      }
      case 'stdio':
        try {
          if (value.stream === 1) {
            this.#options.stdio.writeStdout(src);
          } else if (value.stream === 2) {
            this.#options.stdio.writeStderr(src);
          } else {
            return err(native('EBADF'));
          }
          return ok(src.length);
        } catch (e) {
          return err(syscallError(e));
        }
      case 'completion-source':
        return err(native('EBADF'));
      case 'file': {
        const r = this.#options.files.write(value.file.fd, src);
        return r.ok ? r : err(native(r.error.code));
      }
      case 'inotify':
      case 'process':
        return err(INVAL);
      case 'socket':
        return value.socket.write(src);
      case 'invalid':
        return err(BADF);
    }
  }

  // ----- filesystem -----

  /** `open_job_get_fd`: publishes the opened file once; later calls return the same handle. */
  openJobFd(job: Handle): Result<Handle, AsyncError> {
    const result = this.#openResult(job);
    if (!result.ok) {
      return result;
    }
    const opened = result.value.opened;
    if (opened.state === 'published') {
      return ok(opened.handle);
    }
    const handle = this.resources.insert({ kind: 'file', file: opened.file });
    result.value.opened = { state: 'published', handle };
    return ok(handle);
  }

  /**
   * The compat open getters read the packed identity slot: zero when the property
   * was requested but unavailable, `Inval` when not requested.
   */
  openJobProperty(job: Handle, property: 'kind' | 'dev' | 'ino'): Result<bigint, AsyncError> {
    const result = this.#openResult(job);
    if (!result.ok) {
      return result;
    }
    const payload = this.pool.job(job);
    if (!payload.ok || payload.value.payload.kind !== 'open') {
      return err(BADF);
    }
    const mask = payload.value.payload.request.mask;
    const stat = result.value.stat;
    switch (property) {
      case 'kind':
        return mask & STAT_FILE_KIND ? ok(BigInt(fileKind(stat.kind))) : err(INVAL);
      case 'dev':
        return mask & STAT_DEVICE_ID ? ok(stat.deviceId ?? 0n) : err(INVAL);
      case 'ino':
        return mask & STAT_FILE_ID ? ok(stat.fileId ?? 0n) : err(INVAL);
    }
  }

  #openResult(job: Handle) {
    const found = this.pool.job(job);
    if (!found.ok) {
      return found;
    }
    const payload = found.value.payload;
    if (payload.kind !== 'open') {
      return err(BADF);
    }
    return payload.result === undefined ? err(INVAL) : ok(payload.result);
  }

  /** `fs/try_lock_file`: a `LOCK_NB` flock; a conflict is `EWOULDBLOCK`. */
  tryLockFile(fd: Handle, exclusive: boolean): Result<void, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const key = this.#lockKey(resource.value);
    if (!key.ok) {
      return key;
    }
    return this.locks.tryLock(key.value, lockOwner(resource.value), exclusive)
      ? ok(undefined)
      : err(native('EAGAIN'));
  }

  unlockFile(fd: Handle): Result<void, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const key = this.#lockKey(resource.value);
    if (!key.ok) {
      return key;
    }
    this.locks.unlock(key.value, lockOwner(resource.value));
    return ok(undefined);
  }

  /** `fs/inotify/create`. */
  inotifyCreate(): Handle {
    return this.resources.insert({ kind: 'inotify', inotify: new Inotify(this.#options.files) });
  }

  inotify(fd: Handle): Result<Inotify, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    return resource.value.kind === 'inotify' ? ok(resource.value.inotify) : err(INVAL);
  }

  #lockKey(resource: Resource): Result<string, AsyncError> {
    let fd: HostFd | undefined;
    if (resource.kind === 'file') {
      if (resource.file.lockKey !== undefined) {
        return ok(resource.file.lockKey);
      }
      fd = resource.file.fd;
    } else if (resource.kind === 'stdio') {
      fd = resource.stream as HostFd;
    }
    if (fd === undefined) {
      return ok(this.#lockKeyOf(lockOwner(resource)));
    }
    const stat = this.#options.files.fstat(fd);
    if (!stat.ok) {
      return err(native(stat.error.code));
    }
    const key = inodeKey(stat.value);
    if (resource.kind === 'file') {
      resource.file.lockKey = key;
    }
    return ok(key);
  }

  #lockKeyOf(owner: object): string {
    let key = this.#lockKeys.get(owner);
    if (key === undefined) {
      key = `object:${this.#nextLockKey++}`;
      this.#lockKeys.set(owner, key);
    }
    return key;
  }

  #adoptFile(fd: HostFd, path: string): HostFile {
    return new HostFile(fd, path, (file) => {
      this.locks.releaseOwner(file);
      this.#options.files.close(file.fd);
    });
  }

  // ----- lifecycle -----

  /** Run teardown: stop Workers and timers, close polls and guest-owned resources. */
  teardown(): void {
    this.destroyThreadPool();
    this.processes.children.teardown();
    for (const [handle] of [...this.#polls.entries()]) {
      this.pollDestroy(handle);
    }
    this.resources.closeAll();
    this.#options.scheduler.dispose();
  }

  /** Live async state, for `MOONBIT_ASYNC_CHECK_FD_LEAK` (moonrun `leak_summary`). */
  leakSummary(): string | undefined {
    const leaks: string[] = [];
    const add = (name: string, count: number): void => {
      if (count !== 0) {
        leaks.push(`${name}=${count}`);
      }
    };
    add('c_buffers', this.cBuffers.size);
    add('addr_infos', this.network.addrInfoCount);
    add('jobs', this.pool.jobCount);
    add('polls', this.#polls.size);
    for (const [name, count] of this.processes.inputs.leakCounts()) {
      add(name, count);
    }
    if (this.#registration !== undefined) {
      leaks.push('completion_notifier=1', 'completion_source=1');
    }
    add('tls_connections', this.tlsConnections.size);
    add('resources', this.resources.ownedCount - (this.#registration === undefined ? 0 : 1));
    add('workers', this.pool.workerCount);
    return leaks.length === 0 ? undefined : leaks.join(', ');
  }

  #register(bus: Handle, fd: Handle, readOnly: boolean): Result<boolean, AsyncError> {
    const resource = this.resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const poller = this.#polls.get(bus);
    if (poller === undefined) {
      return err(BADF);
    }
    const source = pollableOf(resource.value);
    if (source === undefined) {
      return ok(false);
    }
    if (resource.value.kind === 'pipe') {
      // epoll registration makes the descriptor nonblocking (moonrun `poll_register`).
      resource.value.end.nonblocking = true;
    }
    const interest = (readOnly ? EPOLLIN : EPOLLIN | EPOLLOUT) | EPOLLRDHUP;
    const added = poller.register(resource.value, source, interest, 'edge', fd);
    return added.ok ? ok(true) : err(native(added.error));
  }

  #unregisterPool(registration: PoolRegistration): void {
    this.signals.detachFrom(registration.source);
    this.#registration = undefined;
    this.resources.remove(registration.sourceHandle);
    for (const [, poller] of this.#polls.entries()) {
      poller.unregister(registration.sourceResource);
    }
  }
}
