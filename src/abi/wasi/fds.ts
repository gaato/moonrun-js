import type { FilePort, HostFd } from '../../ports/files.ts';
import { fail, WasiErrno } from './errno.ts';
import { join } from './path.ts';
import { canonicalize, ensureWithinRoot } from './sandbox.ts';

export const FD_STDIN = 0;
export const FD_STDOUT = 1;
export const FD_STDERR = 2;
export const FD_PREOPEN = 3;
const FD_DYNAMIC_START = 4;
const I32_MAX = 0x7fff_ffff;

export const RIGHT = {
  FD_READ: 1n << 1n,
  FD_WRITE: 1n << 6n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  FD_FILESTAT_GET: 1n << 21n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n,
} as const;
export const KNOWN_RIGHTS = (1n << 30n) - 1n;

const PREOPEN_RIGHTS =
  RIGHT.PATH_OPEN |
  RIGHT.PATH_CREATE_FILE |
  RIGHT.FD_READDIR |
  RIGHT.PATH_READLINK |
  RIGHT.PATH_RENAME_SOURCE |
  RIGHT.PATH_RENAME_TARGET |
  RIGHT.PATH_FILESTAT_GET |
  RIGHT.PATH_FILESTAT_SET_SIZE |
  RIGHT.PATH_CREATE_DIRECTORY |
  RIGHT.PATH_REMOVE_DIRECTORY |
  RIGHT.PATH_UNLINK_FILE |
  RIGHT.FD_FILESTAT_GET;

interface Rights {
  readonly rightsBase: bigint;
  readonly rightsInheriting: bigint;
}

/** A dynamic descriptor. Directories hold the path they were opened by, not an OS fd. */
export type Descriptor =
  | (Rights & { readonly kind: 'file'; readonly fd: HostFd })
  | (Rights & { readonly kind: 'dir'; readonly path: string });

export interface ResolvedPath {
  readonly hostPath: string;
  readonly boundaryRoot: string;
}

/**
 * Per-run descriptor table: stdio at 0-2, the single preopen `.` (the working
 * directory) at 3, and dynamic descriptors numbered from 4 and never reused.
 */
export class DescriptorTable {
  readonly #files: FilePort;
  readonly #preopenHostPath: string;
  readonly #preopenRealPath: string;
  readonly #entries = new Map<number, Descriptor>();
  #nextFd = FD_DYNAMIC_START;

  constructor(files: FilePort, cwd: string | undefined) {
    this.#files = files;
    this.#preopenHostPath = cwd ?? '.';
    const real = files.realpath(this.#preopenHostPath);
    this.#preopenRealPath = real.ok ? real.value : this.#preopenHostPath;
  }

  insert(descriptor: Descriptor): number {
    const fd = this.#nextFd;
    if (fd === I32_MAX) {
      fail(WasiErrno.FAULT);
    }
    this.#nextFd = fd + 1;
    this.#entries.set(fd, descriptor);
    return fd;
  }

  remove(fd: number): Descriptor | undefined {
    const d = this.#entries.get(fd);
    this.#entries.delete(fd);
    return d;
  }

  get(fd: number): Descriptor {
    return this.#entries.get(fd) ?? fail(WasiErrno.BADF);
  }

  file(fd: number): Descriptor & { readonly kind: 'file' } {
    const d = this.get(fd);
    return d.kind === 'file' ? d : fail(WasiErrno.BADF);
  }

  /** Open host files, for teardown. */
  hostFds(): HostFd[] {
    return [...this.#entries.values()].flatMap((d) => (d.kind === 'file' ? [d.fd] : []));
  }

  rightsBase(fd: number): bigint {
    switch (fd) {
      case FD_STDIN:
        return RIGHT.FD_READ | RIGHT.FD_FILESTAT_GET;
      case FD_STDOUT:
      case FD_STDERR:
        return RIGHT.FD_WRITE | RIGHT.FD_FILESTAT_GET;
      case FD_PREOPEN:
        return PREOPEN_RIGHTS;
      default:
        return this.get(fd).rightsBase;
    }
  }

  rightsInheriting(fd: number): bigint {
    switch (fd) {
      case FD_STDIN:
      case FD_STDOUT:
      case FD_STDERR:
        return 0n;
      case FD_PREOPEN:
        return KNOWN_RIGHTS;
      default:
        return this.get(fd).rightsInheriting;
    }
  }

  requireRight(fd: number, right: bigint): void {
    if ((this.rightsBase(fd) & right) !== right) {
      fail(WasiErrno.NOTCAPABLE);
    }
  }

  /** moonrun `dir_path_for_fd`: the directory's host path, checked to still be inside the preopen. */
  dirPath(fd: number): string {
    let path: string;
    if (fd === FD_PREOPEN) {
      path = this.#preopenHostPath;
    } else {
      const d = this.get(fd);
      path = d.kind === 'dir' ? d.path : fail(WasiErrno.BADF);
    }
    ensureWithinRoot(this.#preopenRealPath, canonicalize(this.#files, path));
    return path;
  }

  /** moonrun `resolve_path`: the boundary is the dirfd's own directory, not the preopen. */
  resolve(dirfd: number, path: string): ResolvedPath {
    const base = this.dirPath(dirfd);
    const boundaryRoot = canonicalize(this.#files, this.dirPath(dirfd));
    return { hostPath: path === '' ? base : join(base, path), boundaryRoot };
  }
}
