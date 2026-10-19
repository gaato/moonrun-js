import type { FileKind } from './fs.ts';
import type { HostError, Result } from './result.ts';

/** A host file descriptor owned by the run that opened it. */
export type HostFd = number & { readonly __brand: 'HostFd' };

/**
 * POSIX `open(2)` flags. `exclusive` implies `create`; `mode` defaults to 0o666.
 * Validation of flag combinations (as Rust's `OpenOptions` does) is the caller's job.
 */
export interface OpenFlags {
  readonly access: 'read' | 'write' | 'readWrite';
  readonly append: boolean;
  readonly create: boolean;
  readonly exclusive: boolean;
  readonly truncate: boolean;
  readonly directory?: boolean;
  readonly noFollow?: boolean;
  readonly mode?: number;
}

export interface DirEntry {
  /** Raw name bytes as returned by the OS. */
  readonly name: Uint8Array;
  /** From `d_type`, falling back to `lstat` (does not follow symlinks). */
  readonly kind: FileKind;
}

export interface FileStat {
  readonly kind: FileKind;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly rdev: bigint;
  readonly size: bigint;
  readonly blksize: bigint;
  readonly blocks: bigint;
  readonly atimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Synchronous fd-level file primitives (one syscall each, no path rewriting).
 * Paths are passed to the OS verbatim, so `..` is resolved physically; relative
 * paths are relative to the host's working directory.
 */
export interface FilePort {
  open(path: string, flags: OpenFlags): Result<HostFd, HostError>;
  close(fd: HostFd): Result<void, HostError>;
  /** One `read(2)`/`pread(2)`; `position` undefined means the current file offset. */
  read(fd: HostFd, buffer: Uint8Array, position?: bigint): Result<number, HostError>;
  /** One `write(2)`/`pwrite(2)`; may write fewer bytes than given. */
  write(fd: HostFd, bytes: Uint8Array, position?: bigint): Result<number, HostError>;
  fsync(fd: HostFd): Result<void, HostError>;
  fstat(fd: HostFd): Result<FileStat, HostError>;
  stat(path: string): Result<FileStat, HostError>;
  lstat(path: string): Result<FileStat, HostError>;
  /** Entries in OS order, without `.` and `..`. */
  readDir(path: string): Result<DirEntry[], HostError>;
  readLink(path: string): Result<Uint8Array, HostError>;
  symlink(target: string, path: string): Result<void, HostError>;
  rename(from: string, to: string): Result<void, HostError>;
  mkdir(path: string, mode?: number): Result<void, HostError>;
  rmdir(path: string): Result<void, HostError>;
  unlink(path: string): Result<void, HostError>;
  /** `realpath(3)`. */
  realpath(path: string): Result<string, HostError>;
}
