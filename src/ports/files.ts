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
  /** `O_DSYNC` (`data`) or `O_SYNC` (`full`). */
  readonly sync?: 'data' | 'full';
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
  /** Creation time; `0n` when the filesystem does not record it (statx without `STATX_BTIME`). */
  readonly birthtimeNs: bigint;
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
  /** Non-blocking variants for the async Filesystem Jobs. */
  readonly async: AsyncFilePort;
}

/** `access(2)` modes. */
export type AccessMode = 'exists' | 'read' | 'write' | 'execute';

/** A `linux_dirent64` entry as the async readdir Job packs it. */
export interface DirectoryRecord {
  readonly ino: bigint;
  /** Linux `d_type` (`DT_*`). */
  readonly type: number;
  /** Raw name bytes. */
  readonly name: Uint8Array;
}

/** A directory stream in OS order, without `.` and `..`. */
export interface DirectoryReader {
  /** The next entry, or `null` at the end. */
  next(): Promise<Result<DirectoryRecord | null, HostError>>;
  close(): void;
}

/**
 * One inotify-backed watch on a path (Node `fs.watch`): `change` stands for
 * `IN_MODIFY|IN_ATTRIB`, `rename` for every other event; `name` is the child
 * name, or the watched path's own base name for events on the watched inode.
 */
export type WatchListener = (event: 'change' | 'rename', name: string | null) => void;

export interface FileWatch {
  close(): void;
}

/**
 * Asynchronous fd-level and path-level primitives (one syscall each, run off the
 * JavaScript thread where the host can). Paths are passed to the OS verbatim and
 * relative ones resolve against the host's working directory.
 */
export interface AsyncFilePort {
  open(path: string, flags: OpenFlags): Promise<Result<HostFd, HostError>>;
  /** Opens without side effects for identity checks (`O_PATH` where the host has it). */
  openPath(path: string): Result<HostFd, HostError>;
  read(fd: HostFd, buffer: Uint8Array, position?: bigint): Promise<Result<number, HostError>>;
  write(fd: HostFd, bytes: Uint8Array, position?: bigint): Promise<Result<number, HostError>>;
  fsync(fd: HostFd, dataOnly: boolean): Promise<Result<void, HostError>>;
  fstat(fd: HostFd): Promise<Result<FileStat, HostError>>;
  /** `fstatat(dir ?? AT_FDCWD, path, follow ? 0 : AT_SYMLINK_NOFOLLOW)`. */
  statAt(
    dir: HostFd | undefined,
    path: string,
    follow: boolean,
  ): Promise<Result<FileStat, HostError>>;
  access(path: string, mode: AccessMode): Promise<Result<void, HostError>>;
  chmod(path: string, mode: number): Promise<Result<void, HostError>>;
  unlink(path: string): Promise<Result<void, HostError>>;
  rmdir(path: string): Promise<Result<void, HostError>>;
  mkdir(path: string, mode: number): Promise<Result<void, HostError>>;
  rename(from: string, to: string): Promise<Result<void, HostError>>;
  symlink(target: string, path: string): Promise<Result<void, HostError>>;
  /** `realpath(3)` as raw bytes. */
  realpath(path: string): Promise<Result<Uint8Array, HostError>>;
  /** A fresh stream over the directory open at `fd`. */
  openDirectory(fd: HostFd): Promise<Result<DirectoryReader, HostError>>;
  watch(path: string, listener: WatchListener): Result<FileWatch, HostError>;
}
