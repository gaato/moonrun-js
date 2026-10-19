import type { HostError } from '../../ports/result.ts';

/** WASI preview1 errno values used by moonrun (`wasi/mod.rs`). */
export const WasiErrno = {
  SUCCESS: 0,
  ACCES: 2,
  AGAIN: 6,
  BADF: 8,
  EXIST: 20,
  FAULT: 21,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  NAMETOOLONG: 37,
  NOENT: 44,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  PIPE: 64,
  NOTCAPABLE: 76,
} as const;

export type WasiErrno = (typeof WasiErrno)[keyof typeof WasiErrno];

/** Unwinds a WASI call with an errno; caught at the import boundary. */
export class WasiError extends Error {
  readonly errno: WasiErrno;

  constructor(errno: WasiErrno) {
    super(`wasi errno ${errno}`);
    this.name = 'WasiError';
    this.errno = errno;
  }
}

export function fail(errno: WasiErrno): never {
  throw new WasiError(errno);
}

/**
 * moonrun's `io_error_to_errno`, which goes through Rust's `ErrorKind`: only these
 * kinds are mapped and every other OS error (ELOOP, ENAMETOOLONG, EXDEV, ...) is IO.
 */
export function fromHostError(error: HostError): WasiErrno {
  switch (error.code) {
    case 'ENOENT':
      return WasiErrno.NOENT;
    case 'EACCES':
    case 'EPERM':
      return WasiErrno.ACCES;
    case 'EEXIST':
      return WasiErrno.EXIST;
    case 'EINVAL':
      return WasiErrno.INVAL;
    case 'ENOTDIR':
      return WasiErrno.NOTDIR;
    case 'EISDIR':
      return WasiErrno.ISDIR;
    case 'ENOTEMPTY':
      return WasiErrno.NOTEMPTY;
    case 'EAGAIN':
      return WasiErrno.AGAIN;
    case 'EPIPE':
      return WasiErrno.PIPE;
    default:
      return WasiErrno.IO;
  }
}
