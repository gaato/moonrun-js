import type { AsyncKernel } from '../../kernel/async-kernel.ts';
import { type AsyncError, errorCode, FAULT } from '../../kernel/errors.ts';
import { asHandle, type Handle } from '../../kernel/handles.ts';
import { err, ok, type Result } from '../../ports/result.ts';
import type { RunContext } from '../context.ts';
import { LINUX_ERRNO } from '../errno.ts';
import { GuestFault, type GuestMemory } from '../memory.ts';

/** What `moonbitlang/async` handlers work with during one run. */
export interface AsyncEnv {
  readonly ctx: RunContext;
  readonly kernel: AsyncKernel;
  readonly memory: GuestMemory;
}

/**
 * A failure to be reported as moonrun reports an `AsyncHostError` from an import:
 * the builder rethrows it as `Error("moonbitlang/async.<sym> failed: <Debug>")`.
 */
export class AsyncFailure extends Error {
  readonly error: AsyncError;

  constructor(error: AsyncError) {
    super(debugOf(error));
    this.name = 'AsyncFailure';
    this.error = error;
  }
}

/** The Linux errno a failure is recorded as. */
export function errnoOf(error: AsyncError): number {
  return LINUX_ERRNO[errorCode(error)];
}

/** Rust `{:?}` of `AsyncHostError`. */
export function debugOf(error: AsyncError): string {
  switch (error.kind) {
    case 'fault':
      return 'Fault';
    case 'inval':
      return 'Inval';
    case 'io':
      return 'Io';
    case 'badf':
      return 'Badf';
    case 'permission-denied':
      return 'PermissionDenied';
    case 'native':
      return `Native(${LINUX_ERRNO[error.code]})`;
  }
}

/** The value of a successful result; a failure becomes a host error of the import. */
export function unwrap<T>(result: Result<T, AsyncError>): T {
  if (!result.ok) {
    throw new AsyncFailure(result.error);
  }
  return result.value;
}

/** Runs a guest-memory access, turning an out-of-range access into `Fault`. */
export function guest<T>(access: () => T): Result<T, AsyncError> {
  try {
    return ok(access());
  } catch (e) {
    if (e instanceof GuestFault) {
      return err(FAULT);
    }
    throw e;
  }
}

/** Records `error` as the run's errno and returns moonrun's `-1`. */
export function fail(env: AsyncEnv, error: AsyncError): -1 {
  env.kernel.errno = errnoOf(error);
  return -1;
}

/**
 * The `i32` convention for OS-shaped imports: the value on success, `-1` with
 * errno on failure. Guest-memory faults count as `EFAULT`.
 */
export function status(env: AsyncEnv, operation: () => Result<number, AsyncError>): number {
  let result: Result<number, AsyncError>;
  try {
    result = operation();
  } catch (e) {
    if (e instanceof GuestFault) {
      return fail(env, FAULT);
    }
    if (e instanceof AsyncFailure) {
      return fail(env, e.error);
    }
    throw e;
  }
  return result.ok ? result.value : fail(env, result.error);
}

/** `0` or `-1` with errno. */
export function zeroOrMinusOne(env: AsyncEnv, operation: () => Result<void, AsyncError>): number {
  return status(env, () => {
    const result = operation();
    return result.ok ? ok(0) : result;
  });
}

/** A u64 argument as a handle. */
export function handle(raw: bigint): Handle {
  return asHandle(raw);
}

export function bool(value: number): boolean {
  return value !== 0;
}
