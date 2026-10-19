import type { ProcessPort } from '../ports/process.ts';
import { err, ok, type Result } from '../ports/result.ts';
import type { CompletionSource } from './completion.ts';
import { type AsyncError, BADF, INVAL, native } from './errors.ts';
import type { Handle } from './handles.ts';
import type { ProcessPayload } from './job.ts';
import type { ChildAuthorityPort, Children, ProcessInputs, SpawnInputs } from './process.ts';
import type { ProcessEnvironment } from './process-jobs.ts';
import { acquire, type Resource, type ResourceTable, relinquish } from './resource.ts';
import { type RunSignals, SigwaitSink } from './signals.ts';
import type { ThreadPool } from './thread-pool.ts';

/** The process half of the Async Host's options. */
export interface ProcessOptions {
  readonly port: ProcessPort;
  /** `ProcessPolicy::allows_unix`; absent without a process policy. */
  readonly authorizeSpawn?:
    | ((program: string, argv: readonly string[]) => AsyncError | undefined)
    | undefined;
  /** The policy a `moonx` child inherits; absent without a policy. */
  readonly inheritance?: (() => Uint8Array | undefined) | undefined;
  /** Child provenance; present exactly under a process policy. */
  readonly authority?: ChildAuthorityPort | undefined;
}

/** The guest's three stdio slots of a spawn Job (`undefined`: the parent's stream). */
type SpawnStdio = readonly [Resource | undefined, Resource | undefined, Resource | undefined];

/** A pool that can spawn: moonrun's `thread_pool_child_signal_mask` needs a registration. */
export interface PoolState {
  readonly registered: boolean;
  readonly source: CompletionSource | undefined;
}

/**
 * Child processes of the Async Host (moonrun `HostProcess` and the process methods of
 * `AsyncHost`): argv/env inputs, spawn and wait Jobs, pid handles and signals to children.
 */
export class KernelProcesses {
  readonly inputs: ProcessInputs;
  readonly environment: ProcessEnvironment;
  readonly #resources: ResourceTable;
  readonly #pool: ThreadPool;
  readonly #signals: RunSignals;
  readonly #state: () => PoolState;

  constructor(
    inputs: ProcessInputs,
    resources: ResourceTable,
    pool: ThreadPool,
    signals: RunSignals,
    state: () => PoolState,
    environment: ProcessEnvironment,
  ) {
    this.inputs = inputs;
    this.#resources = resources;
    this.#pool = pool;
    this.#signals = signals;
    this.#state = state;
    this.environment = environment;
  }

  get children(): Children {
    return this.environment.children;
  }

  get #authority(): ChildAuthorityPort | undefined {
    return this.environment.authority;
  }

  /** `optional_resource` for the three stdio slots; a failure drops what was acquired. */
  acquireStdio(handles: readonly [Handle, Handle, Handle]): Result<SpawnStdio, AsyncError> {
    const acquired: (Resource | undefined)[] = [];
    for (const h of handles) {
      if (h === this.#resources.invalidHandle) {
        acquired.push(undefined);
        continue;
      }
      const resource = this.#resources.get(h);
      if (!resource.ok) {
        for (const r of acquired) {
          if (r !== undefined) {
            relinquish(r);
          }
        }
        return resource;
      }
      acquired.push(acquire(resource.value));
    }
    return ok([acquired[0], acquired[1], acquired[2]]);
  }

  /** `thread_pool/spawn_job/unix` and the compat `make_spawn_job/unix`, after the inputs. */
  insertSpawnJob(
    inputs: SpawnInputs,
    program: string,
    stdio: SpawnStdio,
    cwd: string | undefined,
  ): Result<Handle, AsyncError> {
    if (!this.#state().registered) {
      // `thread_pool_child_signal_mask` without a thread pool.
      for (const r of stdio) {
        if (r !== undefined) {
          relinquish(r);
        }
      }
      return err(BADF);
    }
    return ok(
      this.#pool.insertJob({
        kind: 'spawn',
        program,
        argv: inputs.argv,
        env: inputs.env,
        stdio,
        cwd,
        result: undefined,
      }),
    );
  }

  /** `spawn_job/set_cwd`: only before the Job has been handed to a Worker. */
  setCwd(job: Handle, cwd: string): Result<void, AsyncError> {
    const found = this.#pool.readyJob(job);
    if (!found.ok) {
      return found;
    }
    const payload = found.value.payload;
    if (payload.kind !== 'spawn') {
      return err(BADF);
    }
    payload.cwd = cwd;
    return ok(undefined);
  }

  /** `get_spawn_job_result_handle`: publishes the child's pidfd once. */
  spawnResultHandle(job: Handle): Result<Handle, AsyncError> {
    const found = this.#pool.job(job);
    if (!found.ok) {
      return found;
    }
    const payload = found.value.payload;
    if (payload.kind !== 'spawn') {
      return err(BADF);
    }
    const result = payload.result;
    if (result === undefined) {
      payload.result = { state: 'published', handle: this.#resources.invalidHandle };
      return ok(this.#resources.invalidHandle);
    }
    if (result.state === 'published') {
      return ok(result.handle);
    }
    const handle = this.#resources.insert({ kind: 'process', child: result.child });
    this.#authority?.trackHandle(handle, found.value.ret);
    payload.result = { state: 'published', handle };
    return ok(handle);
  }

  /**
   * `open_pid_handle`: a pidfd for one of the Run's children. Other processes cannot be
   * waited for by the host, so they get the invalid handle, as on a kernel without
   * `pidfd_open` (errno cleared; the guest falls back to a wait Job), or `ESRCH` (D29).
   */
  openPidHandle(pid: number, setErrno: (errno: number) => void): Result<Handle, AsyncError> {
    const allowed = this.#checkOwned(pid);
    if (!allowed.ok) {
      return allowed;
    }
    const child = this.children.get(pid);
    if (child !== undefined) {
      const handle = this.#resources.insert({ kind: 'process', child });
      this.#authority?.trackHandle(handle, pid);
      return ok(handle);
    }
    const probe = pid > 0 ? this.environment.port.kill(pid, 0) : err({ code: 'ESRCH' as const });
    if (!probe.ok && probe.error.code === 'ESRCH') {
      return err(native('ESRCH'));
    }
    setErrno(0);
    return ok(this.#resources.invalidHandle);
  }

  /**
   * `get_process_result`: a nonblocking `waitid` on the pidfd (or `waitpid` on the pid for
   * the invalid handle). Success reaps the child.
   */
  processResult(handle: Handle, pid: number): Result<number, AsyncError> {
    let resource: Resource | undefined;
    if (handle !== this.#resources.invalidHandle) {
      const found = this.#resources.get(handle);
      if (!found.ok) {
        return found;
      }
      resource = found.value;
    }
    const authority = this.#authority;
    if (authority !== undefined) {
      const allowed = authority.checkFinish(pid, resource === undefined ? undefined : handle);
      if (!allowed.ok) {
        return allowed;
      }
    }
    let code: Result<number, AsyncError>;
    if (resource === undefined) {
      const child = this.children.get(pid);
      code = child === undefined ? err(native('ECHILD')) : child.tryReap();
    } else if (resource.kind === 'process') {
      code = resource.child.tryReap();
    } else {
      code = err(INVAL);
    }
    if (code.ok) {
      authority?.finishWait(pid);
    }
    return code;
  }

  /** `make_wait_for_process_job`. */
  insertWaitJob(handle: Handle, pid: number): Result<Handle, AsyncError> {
    let trackedPid: number | undefined;
    let resource: Resource | undefined;
    if (handle !== this.#resources.invalidHandle) {
      const authority = this.#authority;
      if (authority !== undefined) {
        const tracked = authority.handlePid(handle);
        if (!tracked.ok) {
          return tracked;
        }
        trackedPid = tracked.value;
      }
      const found = this.#resources.get(handle);
      if (!found.ok) {
        return found;
      }
      resource = acquire(found.value);
    }
    const payload: ProcessPayload = { kind: 'wait-for-process', resource, trackedPid, pid };
    return ok(this.#pool.insertJob(payload));
  }

  /** `process/terminate` (`kill(pid, signal)`) and `process/kill` (`SIGKILL`); errors are ignored. */
  signal(pid: number, signal: number): Result<void, AsyncError> {
    const allowed = this.#checkOwned(pid);
    if (!allowed.ok) {
      return allowed;
    }
    const child = this.children.get(pid);
    // A terminated child is a zombie until reaped: signalling it has no effect.
    if (child === undefined || child.running) {
      this.environment.port.kill(pid, signal);
    }
    return ok(undefined);
  }

  /** The compat `make_sigwait_job`: its own signal target until the Job ends. */
  insertSigwaitJob(signals: readonly number[]): Result<Handle, AsyncError> {
    const source = this.#state().source;
    if (source === undefined) {
      return err(BADF);
    }
    const sink = new SigwaitSink(signals, source);
    if (!sink.attach(this.#signals)) {
      return err(INVAL);
    }
    return ok(this.#pool.insertJob({ kind: 'sigwait', sink }));
  }

  /** A handle is closed: a pidfd no longer authorizes its pid. */
  closed(handle: Handle, resource: Resource): void {
    if (resource.kind === 'process') {
      this.#authority?.untrackHandle(handle);
    }
  }

  #checkOwned(pid: number): Result<void, AsyncError> {
    return this.#authority?.checkOwned(pid) ?? ok(undefined);
  }
}
