import type { AsyncError } from './errors.ts';
import type { FileTimes, HostFile, StatValues } from './file.ts';
import type { Handle } from './handles.ts';
import type { Resource } from './resource.ts';

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
      readonly resource: Resource;
      readonly len: number;
      readonly position: bigint;
      result: Uint8Array | undefined;
    }
  /** `make_write_job` on stdio, a pipe or a file. */
  | {
      readonly kind: 'stream-write';
      readonly resource: Resource;
      readonly data: Uint8Array;
      readonly position: bigint;
    }
  | FilesystemPayload;

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
