import type { AsyncError } from './errors.ts';
import type { FileTimes, HostFile, StatValues } from './file.ts';
import type { Handle } from './handles.ts';
import type { Child } from './process.ts';
import type { Resource } from './resource.ts';
import type { SigwaitSink } from './signals.ts';

/** A validated generic-stat request (moonrun `StatRequest`). */
export interface StatRequest {
  readonly mask: number;
  /** Bytes of the packed result: an 8-byte header plus the property slots. */
  readonly encodedLen: number;
}

/** The opened file of an open Job, until `open_job_get_fd` publishes it as a handle. */
export type OpenedFile =
  | { readonly state: 'unpublished'; readonly file: HostFile }
  | { readonly state: 'published'; readonly handle: Handle };

/** A realpath result: owned by the Job, then by a c_buffer the Job frees with itself. */
export type RealpathResult =
  | { readonly state: 'unpublished'; readonly bytes: Uint8Array }
  | { readonly state: 'published'; readonly handle: Handle };

/** Filesystem Jobs (moonrun `filesystem::Job`). Paths are host strings (UTF-8 on the OS side). */
export type FilesystemPayload =
  | {
      readonly kind: 'open';
      readonly path: string;
      readonly access: number;
      readonly create: number;
      readonly append: boolean;
      readonly sync: number;
      readonly mode: number;
      readonly request: StatRequest;
      result: { opened: OpenedFile; readonly stat: StatValues } | undefined;
    }
  | {
      readonly kind: 'fstatx';
      readonly resource: Resource;
      readonly request: StatRequest;
      result: StatValues | undefined;
    }
  | {
      readonly kind: 'statx';
      readonly parent: Resource | undefined;
      readonly path: string;
      readonly request: StatRequest;
      readonly follow: boolean;
      result: StatValues | undefined;
    }
  | {
      readonly kind: 'file-kind-by-path';
      readonly parent: Resource | undefined;
      readonly path: string;
      readonly follow: boolean;
    }
  | { readonly kind: 'file-size'; readonly resource: Resource; result: bigint }
  | { readonly kind: 'file-time'; readonly resource: Resource; result: FileTimes | undefined }
  | {
      readonly kind: 'file-time-by-path';
      readonly path: string;
      readonly follow: boolean;
      result: FileTimes | undefined;
    }
  | { readonly kind: 'access'; readonly path: string; readonly access: number }
  | { readonly kind: 'chmod'; readonly path: string; readonly mode: number }
  | { readonly kind: 'fsync'; readonly resource: Resource; readonly dataOnly: boolean }
  | { readonly kind: 'flock'; readonly resource: Resource; readonly exclusive: boolean }
  | { readonly kind: 'remove'; readonly path: string }
  | {
      readonly kind: 'rename';
      readonly from: string;
      readonly to: string;
      readonly replace: boolean;
    }
  | { readonly kind: 'symlink'; readonly target: string; readonly path: string }
  | { readonly kind: 'mkdir'; readonly path: string; readonly mode: number }
  | { readonly kind: 'rmdir'; readonly path: string }
  | {
      readonly kind: 'readdir';
      readonly resource: Resource;
      /** The leased c_buffer: restored when the Job completes or is freed. */
      readonly buffer: { readonly handle: Handle; readonly bytes: Uint8Array };
      readonly len: number;
      readonly restart: boolean;
    }
  | {
      readonly kind: 'inotify-add-watch';
      readonly resource: Resource;
      readonly path: string;
      readonly isDir: boolean;
    }
  | { readonly kind: 'realpath'; readonly path: string; result: RealpathResult | undefined };

/**
 * What a Job does. Inputs are copied out of guest memory when the Job is made;
 * outputs stay here until a `get_*_result` import copies them back (ADR 0004/0007).
 */
export type JobPayload =
  /** A Job whose construction failed: running it reports the error. */
  | { readonly kind: 'failed'; readonly error: AsyncError }
  /** `make_sleep_job`, for testing the pool. */
  | { readonly kind: 'sleep'; readonly ms: number }
  /** `make_read_job` on stdio, a pipe or a file; `position < 0` reads at the current offset. */
  | {
      readonly kind: 'stream-read';
      readonly console?: boolean;
      readonly resource: Resource;
      readonly len: number;
      readonly position: bigint;
      result: Uint8Array | undefined;
    }
  /** `make_write_job` on stdio, a pipe or a file. */
  | {
      readonly kind: 'stream-write';
      readonly console?: boolean;
      readonly resource: Resource;
      readonly data: Uint8Array;
      readonly position: bigint;
    }
  | FilesystemPayload
  | NetworkPayload
  | ProcessPayload
  | DomainPayload;

/**
 * Work a domain supplies (moonrun's SQLite `Job`). The kernel schedules it like any Job;
 * the domain owns its inputs, results and their release.
 */
export interface DomainWork {
  /** Runs on a Worker; `finish(ret)` is called once, possibly before `start` returns. */
  start(finish: (ret: number) => void): void;
  /** The Job left the table (freed, or finished after it was freed). */
  release(): void;
}

/** A Job whose `ret` is a domain status and whose results stay in `work`. */
export type DomainPayload = { readonly kind: 'domain'; readonly work: DomainWork };

/** A spawn Job's child until `spawn_job_get_result_handle` publishes it as a pidfd handle. */
export type SpawnResult =
  | { readonly state: 'unpublished'; readonly child: Child }
  | { readonly state: 'published'; readonly handle: Handle };

/** Process Jobs (moonrun `process::Job`) and the compat sigwait Job. */
export type ProcessPayload =
  | {
      readonly kind: 'spawn';
      readonly program: string;
      /** argv[0] included. */
      readonly argv: readonly string[];
      readonly env: readonly string[];
      /** stdin, stdout, stderr; `undefined` keeps the parent's stream. */
      readonly stdio: readonly [Resource | undefined, Resource | undefined, Resource | undefined];
      cwd: string | undefined;
      result: SpawnResult | undefined;
    }
  | {
      readonly kind: 'wait-for-process';
      /** The pidfd, or `undefined` for a `waitpid` on the pid. */
      readonly resource: Resource | undefined;
      /** The pid the policy tracked for the handle (host-derived, never from the guest). */
      readonly trackedPid: number | undefined;
      readonly pid: number;
    }
  | { readonly kind: 'sigwait'; readonly sink: SigwaitSink };

/** Network Jobs (moonrun `network::Job`). */
export type NetworkPayload =
  /** `make_bind_job`: the guest's address bytes, decoded when the Job runs. */
  | { readonly kind: 'bind'; readonly resource: Resource; readonly address: Uint8Array }
  /** `make_getaddrinfo_job`: the encoded addresses once it ran (empty after an `EAI_*` failure). */
  | { readonly kind: 'getaddrinfo'; readonly host: string; result: Uint8Array[] | undefined };

/** The common Job result envelope (`ret`, `err`) plus its payload. */
export class Job {
  ret = 0;
  err: AsyncError | undefined;
  readonly payload: JobPayload;

  constructor(payload: JobPayload) {
    this.payload = payload;
  }

  succeed(ret: number): void {
    this.ret = ret;
    this.err = undefined;
  }

  fail(error: AsyncError): void {
    this.ret = -1;
    this.err = error;
  }
}

/**
 * Where a Job's handle stands (moonrun `HostJobState`): `reserved` while a Worker
 * owns it, `result-ready` once the Worker handed the result back.
 */
export type JobSlot =
  | { readonly state: 'ready'; readonly job: Job }
  | { readonly state: 'reserved' }
  | { readonly state: 'result-ready'; readonly job: Job };
