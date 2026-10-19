import type { ChildExit, ChildInput, ChildOutput, ChildProcess } from '../ports/process.ts';
import { err, ok, type Result } from '../ports/result.ts';
import { type AsyncError, BADF, FAULT, INVAL, native } from './errors.ts';
import { type Handle, Handles, type HostKeys } from './handles.ts';
import type { PipeEnd } from './pipe.ts';
import { EPOLLIN, type Pollable, type ReadinessListener, WaitQueue } from './readiness.ts';

/**
 * Child-process provenance under a process policy (moonrun `ChildAuthorityState`). The
 * policy domain implements it; the kernel only consults it.
 */
export interface ChildAuthorityPort {
  trackSpawned(pid: number): void;
  checkOwned(pid: number): Result<void, AsyncError>;
  trackHandle(handle: bigint, pid: number): void;
  handlePid(handle: bigint): Result<number, AsyncError>;
  untrackHandle(handle: bigint): void;
  checkWait(
    hasHandle: boolean,
    trackedPid: number | undefined,
    pid: number,
  ): Result<void, AsyncError>;
  finishWait(pid: number): void;
  checkFinish(pid: number, handle: bigint | undefined): Result<void, AsyncError>;
  revokeUnclaimed(pid: number): void;
}

/** `moonutil::constants::is_moonx_executable` on Unix: the final component is `moonx` or `moonx.exe`. */
export function isMoonxExecutable(program: string): boolean {
  const name = program
    .split('/')
    .filter((p) => p !== '')
    .at(-1);
  return name === 'moonx' || name === 'moonx.exe';
}

/** moonrun's exit code of a child: the exit status, or the negated signal number. */
export function exitCode(exit: ChildExit): number {
  return exit.kind === 'exited' ? exit.code : -exit.signal;
}

type ChildState =
  | { readonly kind: 'running' }
  /** Terminated but not yet waited for by the guest (a zombie). */
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'reaped' };

/**
 * A child of the Run. The host reaps children by itself (libuv), so the zombie that
 * `waitpid` would collect is modelled here; it is also what a pidfd (`process` resource)
 * polls: readable once the child terminated.
 */
export class Child implements Pollable {
  readonly pid: number;
  readonly process: ChildProcess;
  #state: ChildState = { kind: 'running' };
  readonly #waiters = new WaitQueue();
  readonly #onReap: (child: Child) => void;

  constructor(pid: number, process: ChildProcess, onReap: (child: Child) => void) {
    this.pid = pid;
    this.process = process;
    this.#onReap = onReap;
    process.onExit((exit) => {
      if (this.#state.kind === 'running') {
        this.#state = { kind: 'exited', code: exitCode(exit) };
        this.#waiters.wake(EPOLLIN);
      }
    });
  }

  get running(): boolean {
    return this.#state.kind === 'running';
  }

  get reaped(): boolean {
    return this.#state.kind === 'reaped';
  }

  /** `waitid(..., WEXITED | WNOHANG)`: the code (reaping the child), `EAGAIN` or `ECHILD`. */
  tryReap(): Result<number, AsyncError> {
    switch (this.#state.kind) {
      case 'running':
        return err(native('EAGAIN'));
      case 'reaped':
        return err(native('ECHILD'));
      case 'exited': {
        const code = this.#state.code;
        this.#state = { kind: 'reaped' };
        this.#onReap(this);
        return ok(code);
      }
    }
  }

  poll(): number {
    return this.#state.kind === 'running' ? 0 : EPOLLIN;
  }

  watch(listener: ReadinessListener): () => void {
    return this.#waiters.watch(listener);
  }
}

/** The Run's children by pid (what `waitpid(pid, …)` can see). */
export class Children {
  readonly #byPid = new Map<number, Child>();
  readonly #bridges = new Set<() => void>();

  add(pid: number, process: ChildProcess): Child {
    const child = new Child(pid, process, (reaped) => {
      if (this.#byPid.get(reaped.pid) === reaped) {
        this.#byPid.delete(reaped.pid);
      }
    });
    this.#byPid.set(pid, child);
    return child;
  }

  /** An unreaped child with this pid. */
  get(pid: number): Child | undefined {
    return this.#byPid.get(pid);
  }

  /** Registers the teardown of a stream bridge. */
  addBridge(stop: () => void): () => void {
    this.#bridges.add(stop);
    return () => {
      this.#bridges.delete(stop);
    };
  }

  /** Run teardown: the Run's pipe ends close and live children no longer keep the host alive. */
  teardown(): void {
    for (const stop of [...this.#bridges]) {
      stop();
    }
    this.#bridges.clear();
    for (const child of this.#byPid.values()) {
      child.process.unref();
    }
  }
}

const CHUNK = 65536;

/**
 * A child's stdin fed from a kernel pipe read end (the child holds the read end until its
 * stdin closes): data is copied as it arrives, the host stream's backpressure pauses the
 * copy, and end of file ends the child's stdin.
 */
export function feedChild(children: Children, end: PipeEnd, input: ChildInput): void {
  end.retain();
  const buffer = new Uint8Array(CHUNK);
  let closed = false;
  let draining = false;
  let unwatch: (() => void) | undefined;
  const stop = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    unwatch?.();
    unwatch = undefined;
    unregister();
    end.release();
  };
  const unregister = children.addBridge(() => {
    stop();
    input.destroy();
  });
  const pump = (): void => {
    while (!closed && !draining) {
      const r = end.read(buffer);
      if (!r.ok) {
        if (r.error === 'EAGAIN') {
          unwatch ??= end.watch(() => {
            unwatch?.();
            unwatch = undefined;
            pump();
          });
          return;
        }
        input.end();
        stop();
        return;
      }
      if (r.value === 0) {
        input.end();
        stop();
        return;
      }
      if (!input.write(buffer.slice(0, r.value))) {
        draining = true;
        return;
      }
    }
  };
  input.onDrain(() => {
    draining = false;
    pump();
  });
  input.onClose(stop);
  pump();
}

/**
 * A child's stdout or stderr drained into a kernel pipe write end. A full pipe pauses the
 * host stream; a closed reader closes the host side, so the child's next write fails with
 * `EPIPE` as it would on the real pipe.
 */
export function drainChild(children: Children, end: PipeEnd, output: ChildOutput): void {
  end.retain();
  const pending: Uint8Array[] = [];
  let ended = false;
  let released = false;
  let unwatch: (() => void) | undefined;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    unwatch?.();
    unwatch = undefined;
    unregister();
    end.release();
  };
  const unregister = children.addBridge(() => {
    pending.length = 0;
    release();
    output.destroy();
  });
  const flush = (): void => {
    while (!released) {
      const chunk = pending[0];
      if (chunk === undefined) {
        break;
      }
      const r = end.write(chunk);
      if (!r.ok) {
        if (r.error === 'EAGAIN') {
          unwatch ??= end.watch(() => {
            unwatch?.();
            unwatch = undefined;
            flush();
          });
          return;
        }
        pending.length = 0;
        output.destroy();
        release();
        return;
      }
      if (r.value < chunk.length) {
        pending[0] = chunk.subarray(r.value);
      } else {
        pending.shift();
      }
    }
    if (ended) {
      release();
    } else if (!released) {
      output.resume();
    }
  };
  output.onData((chunk) => {
    if (released) {
      return;
    }
    pending.push(chunk);
    output.pause();
    flush();
  });
  output.onEnd(() => {
    ended = true;
    if (pending.length === 0) {
      release();
    }
  });
}

/** A legacy environment block slot (moonrun `LegacyProcessEnvEntry`). */
type LegacyEnvEntry =
  /** Copied from the host as `key=value`. */
  | { readonly kind: 'materialized'; readonly entry: string }
  | { readonly kind: 'added'; readonly key: string; readonly value: string };

/** The current ABI's environment (moonrun `ProcessEnvBuilder`). */
interface EnvBuilder {
  readonly extra: string[];
  readonly inherited: readonly string[];
}

/** `unix_process_env_entry`: a NUL in the key drops the entry, one in the value truncates it. */
function envEntry(key: string, value: string): string | undefined {
  if (key.includes('\0')) {
    return undefined;
  }
  const nul = value.indexOf('\0');
  return `${key}=${nul < 0 ? value : value.slice(0, nul)}`;
}

function materialize(entry: LegacyEnvEntry): string | undefined {
  return entry.kind === 'materialized' ? entry.entry : envEntry(entry.key, entry.value);
}

/**
 * `finish_process_env_builder` on Unix: the extra entries, then the inherited entries
 * whose `key=` prefix no extra entry has.
 */
export function finishEnv(builder: EnvBuilder): string[] {
  const extra = builder.extra;
  const inherited = builder.inherited.filter((entry) => {
    const eq = entry.indexOf('=');
    if (eq < 0) {
      return !extra.includes(entry);
    }
    const prefix = entry.slice(0, eq + 1);
    return !extra.some((e) => e.startsWith(prefix));
  });
  return [...extra, ...inherited];
}

/** `overwrite_process_env_var`. */
export function overwriteEnv(env: readonly string[], key: string, value: string): string[] {
  const entry = envEntry(key, value);
  return finishEnv({ extra: entry === undefined ? [] : [entry], inherited: env });
}

/** What a spawn Job consumes: the argument vector and the final environment. */
export interface SpawnInputs {
  readonly argv: string[];
  readonly env: string[];
}

/**
 * Argument arrays, legacy environment blocks and environment builders (moonrun
 * `process_argvs`, `process_envs`, `process_env_builders`). A spawn Job takes ownership of
 * the ones it is made from.
 */
export class ProcessInputs {
  readonly #argvs: Handles<(string | undefined)[]>;
  readonly #envs: Handles<(LegacyEnvEntry | undefined)[]>;
  readonly #builders: Handles<EnvBuilder>;

  constructor(keys: HostKeys) {
    this.#argvs = new Handles(keys, 'process-argv');
    this.#envs = new Handles(keys, 'process-env');
    this.#builders = new Handles(keys, 'process-env-builder');
  }

  insertArgv(len: number): Handle {
    return this.#argvs.insert(Array.from({ length: len }, () => undefined));
  }

  argvSet(handle: Handle, index: number, value: string): Result<void, AsyncError> {
    const argv = this.#argvs.get(handle);
    if (argv === undefined) {
      return err(BADF);
    }
    if (index >= argv.length) {
      return err(FAULT);
    }
    argv[index] = value;
    return ok(undefined);
  }

  /** `get_curr_env` (materialized `key=value` entries) and `allocate_env_block` (empty slots). */
  insertEnv(entries: readonly (string | undefined)[]): Handle {
    return this.#envs.insert(
      entries.map((entry) => (entry === undefined ? undefined : { kind: 'materialized', entry })),
    );
  }

  envLength(handle: Handle): Result<number, AsyncError> {
    const env = this.#envs.get(handle);
    return env === undefined ? err(BADF) : ok(env.length);
  }

  /** `write_env_block`: copies the snapshot `src` into `dst` from index 0 and consumes `src`. */
  transferEnv(dst: Handle, src: Handle): Result<void, AsyncError> {
    if (dst === src) {
      return err(INVAL);
    }
    if (this.#envs.get(dst) === undefined) {
      return err(BADF);
    }
    const source = this.#envs.remove(src);
    if (source === undefined) {
      return err(BADF);
    }
    const target = this.#envs.get(dst);
    if (target === undefined) {
      return err(BADF);
    }
    if (target.length < source.length) {
      return err(FAULT);
    }
    source.forEach((entry, i) => {
      target[i] = entry;
    });
    return ok(undefined);
  }

  envSet(handle: Handle, index: number, key: string, value: string): Result<void, AsyncError> {
    const env = this.#envs.get(handle);
    if (env === undefined) {
      return err(BADF);
    }
    if (index >= env.length) {
      return err(FAULT);
    }
    env[index] = { kind: 'added', key, value };
    return ok(undefined);
  }

  insertBuilder(inherited: readonly string[]): Handle {
    return this.#builders.insert({ extra: [], inherited });
  }

  builderAdd(handle: Handle, key: string, value: string): Result<void, AsyncError> {
    const builder = this.#builders.get(handle);
    if (builder === undefined) {
      return err(BADF);
    }
    const entry = envEntry(key, value);
    if (entry !== undefined) {
      builder.extra.push(entry);
    }
    return ok(undefined);
  }

  /** `take_process_spawn_inputs`: validates both before consuming either. */
  takeSpawnInputs(argvHandle: Handle, envHandle: Handle): Result<SpawnInputs, AsyncError> {
    const argv = this.#argvs.get(argvHandle);
    if (argv === undefined || this.#builders.get(envHandle) === undefined) {
      return err(BADF);
    }
    if (argv.some((a) => a === undefined)) {
      return err(INVAL);
    }
    this.#argvs.remove(argvHandle);
    const builder = this.#builders.remove(envHandle);
    if (builder === undefined) {
      return err(BADF);
    }
    return ok({ argv: argv as string[], env: finishEnv(builder) });
  }

  /**
   * `take_legacy_process_spawn_inputs`: the first `inherited` entries of the block are
   * the host snapshot, the rest are additions; both become one builder.
   */
  takeLegacySpawnInputs(
    argvHandle: Handle,
    envHandle: Handle,
    inherited: number,
  ): Result<SpawnInputs, AsyncError> {
    const argv = this.#argvs.get(argvHandle);
    if (argv === undefined) {
      return err(BADF);
    }
    const env = this.#envs.get(envHandle);
    if (env === undefined) {
      return err(BADF);
    }
    if (inherited > env.length || argv.some((a) => a === undefined) || env.includes(undefined)) {
      return err(INVAL);
    }
    this.#argvs.remove(argvHandle);
    this.#envs.remove(envHandle);
    const entries = env as LegacyEnvEntry[];
    const keep = (list: LegacyEnvEntry[]): string[] =>
      list.flatMap((e) => {
        const entry = materialize(e);
        return entry === undefined ? [] : [entry];
      });
    return ok({
      argv: argv as string[],
      env: finishEnv({
        extra: keep(entries.slice(inherited)),
        inherited: keep(entries.slice(0, inherited)),
      }),
    });
  }

  /** Live counts for the leak check, in moonrun's order. */
  leakCounts(): ReadonlyArray<readonly [string, number]> {
    return [
      ['process_argvs', this.#argvs.size],
      ['process_envs', this.#envs.size],
      ['process_env_builders', this.#builders.size],
    ];
  }
}
