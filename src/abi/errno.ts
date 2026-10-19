import type { HostError, HostErrorCode } from '../ports/result.ts';

/** Linux errno numbers (asm-generic, x86-64 and aarch64 agree on all of these). */
export const LINUX_ERRNO: Readonly<Record<HostErrorCode, number>> = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EMFILE: 24,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EPIPE: 32,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENOTSUP: 95,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETUNREACH: 101,
  ECONNABORTED: 103,
  ECONNRESET: 104,
  ENOTCONN: 107,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EHOSTUNREACH: 113,
  EALREADY: 114,
  EINPROGRESS: 115,
  ECANCELED: 125,
};

/** glibc `strerror` texts, which is what Rust's `io::Error` prints for an OS error. */
const STRERROR: Readonly<Record<HostErrorCode, string>> = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  ESRCH: 'No such process',
  EINTR: 'Interrupted system call',
  EIO: 'Input/output error',
  EBADF: 'Bad file descriptor',
  ECHILD: 'No child processes',
  EAGAIN: 'Resource temporarily unavailable',
  ENOMEM: 'Cannot allocate memory',
  EACCES: 'Permission denied',
  EFAULT: 'Bad address',
  EBUSY: 'Device or resource busy',
  EEXIST: 'File exists',
  EXDEV: 'Invalid cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  EMFILE: 'Too many open files',
  ENOSPC: 'No space left on device',
  ESPIPE: 'Illegal seek',
  EROFS: 'Read-only file system',
  EPIPE: 'Broken pipe',
  ENAMETOOLONG: 'File name too long',
  ENOSYS: 'Function not implemented',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  ENOTSUP: 'Operation not supported',
  EADDRINUSE: 'Address already in use',
  EADDRNOTAVAIL: 'Cannot assign requested address',
  ENETUNREACH: 'Network is unreachable',
  ECONNABORTED: 'Software caused connection abort',
  ECONNRESET: 'Connection reset by peer',
  ENOTCONN: 'Transport endpoint is not connected',
  ETIMEDOUT: 'Connection timed out',
  ECONNREFUSED: 'Connection refused',
  EHOSTUNREACH: 'No route to host',
  EALREADY: 'Operation already in progress',
  EINPROGRESS: 'Operation now in progress',
  ECANCELED: 'Operation canceled',
};

function isKnown(code: string): code is HostErrorCode {
  return Object.hasOwn(LINUX_ERRNO, code);
}

/** The errno of a host error; codes outside the table (Node-internal ones) read as `EIO`. */
export function errnoOf(code: string): number {
  return isKnown(code) ? LINUX_ERRNO[code] : LINUX_ERRNO.EIO;
}

/** Linux `strerror` text, e.g. `No such file or directory`. */
export function strerror(code: string): string {
  return isKnown(code) ? STRERROR[code] : STRERROR.EIO;
}

/** Rust `io::Error` Display for an OS error: `No such file or directory (os error 2)`. */
export function rustIoErrorText(error: HostError): string {
  return `${strerror(error.code)} (os error ${errnoOf(error.code)})`;
}
