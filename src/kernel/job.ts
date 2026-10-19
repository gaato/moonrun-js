import type { AsyncError } from './errors.ts';
import type { Resource } from './resource.ts';

/**
 * What a Job does. Inputs are copied out of guest memory when the Job is made;
 * outputs stay here until a `get_*_result` import copies them back (ADR 0004/0007).
 */
export type JobPayload =
  /** A Job whose construction failed: running it reports the error. */
  | { readonly kind: 'failed'; readonly error: AsyncError }
  /** `make_sleep_job`, for testing the pool. */
  | { readonly kind: 'sleep'; readonly ms: number }
  /** `make_read_job` on a stream (stdio or pipe); `position < 0` reads at the current offset. */
  | {
      readonly kind: 'stream-read';
      readonly resource: Resource;
      readonly len: number;
      readonly position: bigint;
      result: Uint8Array | undefined;
    }
  /** `make_write_job` on a stream. */
  | {
      readonly kind: 'stream-write';
      readonly resource: Resource;
      readonly data: Uint8Array;
      readonly position: bigint;
    };

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
