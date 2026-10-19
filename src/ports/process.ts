import type { HostError, Result } from './result.ts';

/** What one standard stream of a child is connected to (moonrun's posix_spawn file actions). */
export type ChildStdio =
  /** No file action: the child inherits the parent's descriptor. */
  | { readonly kind: 'inherit' }
  /** `dup2` of a host descriptor onto the stream. */
  | { readonly kind: 'fd'; readonly fd: number }
  /** A fresh host pipe whose parent side the kernel serves (its own pipes have no descriptor). */
  | { readonly kind: 'pipe' }
  /** stderr only: the same host pipe as a `pipe` stdout (`2>&1`), read through `stdout`. */
  | { readonly kind: 'stdout' };

/** A `posix_spawnp` request. Strings contain no NUL (the kernel rejects those first). */
export interface SpawnRequest {
  /** The program as the guest named it; without `/` it is looked up in the host's `PATH`. */
  readonly program: string;
  /** The complete argument vector, argv[0] included. */
  readonly argv: readonly string[];
  /** `KEY=VALUE` entries in order; for a repeated key the first entry wins (`getenv`). */
  readonly env: readonly string[];
  /** The child's working directory (`posix_spawn_file_actions_addchdir`); undefined inherits. */
  readonly cwd: string | undefined;
  readonly stdio: readonly [ChildStdio, ChildStdio, ChildStdio];
  /** Host descriptors the child receives as descriptors 3, 4, … (in order). */
  readonly extraFds: readonly number[];
}

/** The parent's side of a piped child stdin. */
export interface ChildInput {
  /** Queues bytes; false means the host buffer is full and `onDrain` will fire. */
  write(bytes: Uint8Array): boolean;
  onDrain(listener: () => void): void;
  /** Closes the parent's side (the child reads end of file). */
  end(): void;
  /** The pipe closed (child gone or our side ended or broken). */
  onClose(listener: () => void): void;
  destroy(): void;
}

/** The parent's side of a piped child stdout or stderr. */
export interface ChildOutput {
  onData(listener: (bytes: Uint8Array) => void): void;
  /** Stops `onData` until `resume` (backpressure). */
  pause(): void;
  resume(): void;
  /** End of file or failure: no more data. Fires once. */
  onEnd(listener: () => void): void;
  /** Closes the parent's side; a child writing afterwards gets `EPIPE`. */
  destroy(): void;
}

/** How a child terminated. */
export type ChildExit =
  | { readonly kind: 'exited'; readonly code: number }
  /** A Linux signal number. */
  | { readonly kind: 'signaled'; readonly signal: number };

export interface ChildProcess {
  readonly pid: number;
  /** Present exactly for the streams requested as `pipe`. */
  readonly stdin: ChildInput | undefined;
  readonly stdout: ChildOutput | undefined;
  readonly stderr: ChildOutput | undefined;
  /** Fires once, when the child terminates (it is already reaped by the host). */
  onExit(listener: (exit: ChildExit) => void): void;
  /** Lets the host process exit while the child still runs (Run teardown). */
  unref(): void;
}

/** Child processes of the host. */
export interface ProcessPort {
  /** Starts a child; fails with the errno `posix_spawnp` would report. */
  spawn(request: SpawnRequest): Promise<Result<ChildProcess, HostError>>;
  /** `kill(2)` with a Linux signal number (0 probes for existence). */
  kill(pid: number, signal: number): Result<void, HostError>;
  /**
   * The anonymous file carrying a policy to a `moonx` child (created, unlinked, positioned
   * at 0); the caller closes it with {@link closeFd} once the child holds its copy.
   */
  openPolicyTransfer(payload: Uint8Array): Result<number, HostError>;
  closeFd(fd: number): void;
}

/** OS signals of the host process. Signals are Linux numbers. */
export interface SignalPort {
  /** Captures `signal` (its default action no longer applies) until the returned function runs. */
  capture(signal: number, handler: () => void): () => void;
  /** Applies the default action of `signal` to this process (moonrun `apply_process_signal`). */
  raise(signal: number): void;
}
