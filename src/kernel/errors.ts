import type { HostErrorCode } from '../ports/result.ts';

/**
 * Failures of the async kernel, shaped like moonrun's `AsyncHostError`. The ABI
 * renders them either as `Error("moonbitlang/async.<sym> failed: <Debug>")` or as
 * `-1` plus a Linux errno; the kernel never deals in numbers.
 */
export type AsyncError =
  | { readonly kind: 'fault' }
  | { readonly kind: 'inval' }
  | { readonly kind: 'io' }
  | { readonly kind: 'badf' }
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'native'; readonly code: HostErrorCode };

export const FAULT: AsyncError = { kind: 'fault' };
export const INVAL: AsyncError = { kind: 'inval' };
export const IO: AsyncError = { kind: 'io' };
export const BADF: AsyncError = { kind: 'badf' };
export const PERMISSION_DENIED: AsyncError = { kind: 'permission-denied' };

export function native(code: HostErrorCode): AsyncError {
  return { kind: 'native', code };
}

/** The OS error a failure stands for, as moonrun's `AsyncHostError::errno`. */
export function errorCode(error: AsyncError): HostErrorCode {
  switch (error.kind) {
    case 'fault':
      return 'EFAULT';
    case 'inval':
      return 'EINVAL';
    case 'io':
      return 'EIO';
    case 'badf':
      return 'EBADF';
    case 'permission-denied':
      return 'EACCES';
    case 'native':
      return error.code;
  }
}
