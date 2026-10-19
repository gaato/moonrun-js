/**
 * Result values used by ports and domains. Only the ABI layer turns a failure
 * into a guest-visible convention (errno, status codes, or a thrown host error).
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Normalized host failure. `code` uses POSIX names; the ABI maps them to Linux numbers. */
export type HostErrorCode =
  | 'EPERM'
  | 'ENOENT'
  | 'EINTR'
  | 'EIO'
  | 'EBADF'
  | 'EAGAIN'
  | 'ENOMEM'
  | 'EACCES'
  | 'EFAULT'
  | 'EBUSY'
  | 'EEXIST'
  | 'EXDEV'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EINVAL'
  | 'EMFILE'
  | 'ENOSPC'
  | 'ESPIPE'
  | 'EROFS'
  | 'EPIPE'
  | 'ENAMETOOLONG'
  | 'ENOSYS'
  | 'ENOTEMPTY'
  | 'ELOOP'
  | 'ENOTSUP'
  | 'EADDRINUSE'
  | 'EADDRNOTAVAIL'
  | 'ENETUNREACH'
  | 'ECONNABORTED'
  | 'ECONNRESET'
  | 'ENOTCONN'
  | 'ETIMEDOUT'
  | 'ECONNREFUSED'
  | 'EHOSTUNREACH'
  | 'EALREADY'
  | 'EINPROGRESS'
  | 'ECANCELED'
  | 'ESRCH'
  | 'ECHILD'
  | 'ENXIO'
  | 'ENODEV'
  | 'ENFILE'
  | 'ETXTBSY'
  | 'EFBIG'
  | 'EMLINK'
  | 'ENOLCK'
  | 'EOVERFLOW'
  | 'EDQUOT'
  | 'ENOTSOCK'
  | 'EDESTADDRREQ'
  | 'EMSGSIZE'
  | 'EPROTOTYPE'
  | 'ENOPROTOOPT'
  | 'EPROTONOSUPPORT'
  | 'EAFNOSUPPORT'
  | 'ENETDOWN'
  | 'ENETRESET'
  | 'ENOBUFS'
  | 'EISCONN'
  | 'ESHUTDOWN'
  | 'EHOSTDOWN';

export interface HostError {
  readonly code: HostErrorCode;
  /** Human-readable detail, used only where moonrun surfaces OS messages. */
  readonly message?: string;
}

export function hostError(code: HostErrorCode, message?: string): HostError {
  return message === undefined ? { code } : { code, message };
}
