import type { FileKind } from '../../ports/fs.ts';
import type { HostError, Result } from '../../ports/result.ts';
import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';
import { requestExit } from '../legacy/sys.ts';
import { GuestFault } from '../memory.ts';
import { fail, fromHostError, WasiErrno, WasiError } from './errno.ts';
import {
  DescriptorTable,
  FD_PREOPEN,
  FD_STDERR,
  FD_STDIN,
  FD_STDOUT,
  KNOWN_RIGHTS,
  RIGHT,
} from './fds.ts';
import { openFile } from './open.ts';
import { fileName } from './path.ts';
import { enforceBoundary, rejectFinalSymlink } from './sandbox.ts';

const IOVEC_SIZE = 8;
const DIRENT_SIZE = 24;
const U32_MAX = 0xffff_ffff;

const FDFLAG_APPEND = 1;
const KNOWN_FDFLAGS = 0x1f;
const SUPPORTED_FDFLAGS = FDFLAG_APPEND;
const OFLAG_CREAT = 1;
const OFLAG_DIRECTORY = 2;
const OFLAG_EXCL = 4;
const OFLAG_TRUNC = 8;
const KNOWN_OFLAGS = 0xf;
const LOOKUP_SYMLINK_FOLLOW = 1;
const KNOWN_LOOKUPFLAGS = LOOKUP_SYMLINK_FOLLOW;

const FILETYPE: Readonly<Record<FileKind, number>> = { other: 0, dir: 3, file: 4, symlink: 7 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cString(s: string): Uint8Array {
  return encoder.encode(`${s}\0`);
}

function knownBits(value: number, mask: number): void {
  if ((value & ~mask) !== 0) {
    fail(WasiErrno.INVAL);
  }
}

function knownRights(rights: bigint): void {
  if ((rights & ~KNOWN_RIGHTS) !== 0n) {
    fail(WasiErrno.INVAL);
  }
}

function dirent(index: number, name: Uint8Array, kind: FileKind): Uint8Array {
  const out = new Uint8Array(DIRENT_SIZE + name.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(index + 1), true);
  view.setUint32(16, name.length, true);
  view.setUint8(20, FILETYPE[kind]);
  out.set(name, DIRENT_SIZE);
  return out;
}

/** `wasi_snapshot_preview1`: the 18 functions moonrun registers (`v8/wasi.rs`, `wasi/mod.rs`). */
export const preview1: ImportFamily = (ctx) => {
  const { memory, stdio } = ctx;
  const files = ctx.host.files;
  const cwd = ctx.host.fs.cwd();
  const table = new DescriptorTable(files, cwd.ok ? cwd.value : undefined);
  ctx.onTeardown(() => {
    for (const fd of table.hostFds()) {
      files.close(fd);
    }
  });
  const argv = [ctx.moduleName, ...ctx.args].map(cString);

  /** Runs `body` the way moonrun's adapters do: errno 0 on success, FAULT on bad guest memory. */
  const guard = (body: () => void): number => {
    try {
      body();
      return WasiErrno.SUCCESS;
    } catch (e) {
      if (e instanceof WasiError) {
        return e.errno;
      }
      if (e instanceof GuestFault) {
        return WasiErrno.FAULT;
      }
      throw e;
    }
  };
  // moonrun borrows guest memory before doing anything else, so an import called
  // before `memory` is bound (e.g. from the start function) fails with FAULT.
  const withMemory = (body: () => void): number => (memory.bound ? guard(body) : WasiErrno.FAULT);

  const iovec = (iovs: number, index: number): readonly [number, number] => {
    const at = iovs + index * IOVEC_SIZE;
    return [memory.u32(at), memory.u32(at + 4)];
  };

  const writeU32 = (ptr: number, value: number): void => {
    if (value > U32_MAX) {
      fail(WasiErrno.FAULT);
    }
    memory.setU32(ptr, value);
  };

  const writeTable = (values: readonly Uint8Array[], pointers: number, bytes: number): void => {
    let cursor = bytes;
    values.forEach((value, i) => {
      writeU32(pointers + i * 4, cursor);
      memory.write(cursor, value);
      cursor += value.length;
    });
  };

  const tableSizes = (values: readonly Uint8Array[], countPtr: number, sizePtr: number): void => {
    writeU32(countPtr, values.length);
    writeU32(
      sizePtr,
      values.reduce((n, v) => n + v.length, 0),
    );
  };

  const environ = (): Uint8Array[] => ctx.host.env.entries().map(([k, v]) => cString(`${k}=${v}`));

  const readPath = (ptr: number, len: number): string => {
    const bytes = memory.view(ptr, len);
    if (bytes.includes(0)) {
      fail(WasiErrno.INVAL);
    }
    return decoder.decode(bytes);
  };

  /** Path of a single entry to create or remove; `Path::file_name` must exist. */
  const entryPath = (ptr: number, len: number): string => {
    const path = readPath(ptr, len);
    if (fileName(path) === undefined) {
      fail(WasiErrno.NOTCAPABLE);
    }
    return path;
  };

  const resolveParentOnly = (dirfd: number, path: string): string => {
    const r = table.resolve(dirfd, path);
    enforceBoundary(files, r.boundaryRoot, r.hostPath, { kind: 'parent-only' });
    return r.hostPath;
  };

  const check = <T>(r: Result<T, HostError>): T => (r.ok ? r.value : fail(fromHostError(r.error)));

  const stdioWrite = (fd: number, iovs: number, iovsLen: number): number => {
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const [ptr, len] = iovec(iovs, i);
      const bytes = memory.view(ptr, len);
      try {
        if (fd === FD_STDOUT) {
          stdio.writeStdout(bytes);
        } else {
          stdio.writeStderr(bytes);
        }
      } catch {
        fail(WasiErrno.IO);
      }
      total += len;
    }
    if (fd === FD_STDOUT) {
      try {
        stdio.flushStdout();
      } catch {
        fail(WasiErrno.IO);
      }
    }
    return total;
  };

  const fileWrite = (fd: number, iovs: number, iovsLen: number): number => {
    const file = table.file(fd);
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const [ptr, len] = iovec(iovs, i);
      let rest = memory.view(ptr, len);
      // Rust `write_all`: retry short writes; a zero-byte write is an IO error.
      while (rest.length > 0) {
        const n = check(files.write(file.fd, rest));
        if (n === 0) {
          fail(WasiErrno.IO);
        }
        rest = rest.subarray(n);
      }
      total += len;
    }
    return total;
  };

  const readInto = (
    iovs: number,
    iovsLen: number,
    read: (buffer: Uint8Array) => number,
  ): number => {
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const [ptr, len] = iovec(iovs, i);
      if (len === 0) {
        continue;
      }
      const n = read(memory.view(ptr, len));
      total += n;
      if (n < len) {
        break;
      }
    }
    return total;
  };

  const readStdin = (buffer: Uint8Array): number => {
    try {
      return stdio.readStdin(buffer);
    } catch {
      return fail(WasiErrno.IO);
    }
  };

  const pathOpen = (
    dirfd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    openedFdPtr: number,
  ): void => {
    knownBits(dirflags, KNOWN_LOOKUPFLAGS);
    knownBits(oflags, KNOWN_OFLAGS);
    knownBits(fdflags, KNOWN_FDFLAGS);
    if ((fdflags & ~SUPPORTED_FDFLAGS) !== 0) {
      fail(WasiErrno.NOTSUP);
    }
    knownRights(rightsBase);
    knownRights(rightsInheriting);
    const create = (oflags & (OFLAG_CREAT | OFLAG_EXCL)) !== 0;
    table.requireRight(dirfd, RIGHT.PATH_OPEN);
    if (create) {
      table.requireRight(dirfd, RIGHT.PATH_CREATE_FILE);
    }
    if ((oflags & OFLAG_TRUNC) !== 0) {
      table.requireRight(dirfd, RIGHT.PATH_FILESTAT_SET_SIZE);
    }
    const inheritable = table.rightsInheriting(dirfd);
    if ((rightsBase & ~inheritable) !== 0n || (rightsInheriting & ~inheritable) !== 0n) {
      fail(WasiErrno.NOTCAPABLE);
    }
    const path = readPath(pathPtr, pathLen);
    const { hostPath, boundaryRoot } = table.resolve(dirfd, path);
    enforceBoundary(files, boundaryRoot, hostPath, {
      kind: 'follow-final',
      allowMissingFinal: create,
    });
    if ((dirflags & LOOKUP_SYMLINK_FOLLOW) === 0) {
      rejectFinalSymlink(files, hostPath);
    }
    const rights = { rightsBase, rightsInheriting };
    let fd: number;
    if ((oflags & OFLAG_DIRECTORY) !== 0) {
      if ((oflags & (OFLAG_CREAT | OFLAG_EXCL | OFLAG_TRUNC)) !== 0) {
        fail(WasiErrno.INVAL);
      }
      if (check(files.stat(hostPath)).kind !== 'dir') {
        fail(WasiErrno.NOTDIR);
      }
      fd = table.insert({ kind: 'dir', path: hostPath, ...rights });
    } else {
      const hostFd = openFile(files, hostPath, {
        read: (rightsBase & RIGHT.FD_READ) !== 0n,
        write: (rightsBase & RIGHT.FD_WRITE) !== 0n,
        append: (fdflags & FDFLAG_APPEND) !== 0,
        create,
        createNew: (oflags & OFLAG_EXCL) !== 0,
        truncate: (oflags & OFLAG_TRUNC) !== 0,
      });
      fd = table.insert({ kind: 'file', fd: hostFd, ...rights });
    }
    // A fault here leaves the descriptor open, as in moonrun.
    writeU32(openedFdPtr, fd);
  };

  const readdir = (fd: number, bufPtr: number, bufLen: number, cookie: bigint, usedPtr: number) => {
    table.requireRight(fd, RIGHT.FD_READDIR);
    const listed = files.readDir(table.dirPath(fd));
    if (!listed.ok) {
      fail(WasiErrno.IO);
    }
    const dot = { name: encoder.encode('.'), kind: 'dir' } as const;
    const dotdot = { name: encoder.encode('..'), kind: 'dir' } as const;
    const entries = [dot, dotdot, ...listed.value];
    const buf = memory.view(bufPtr, bufLen);
    let used = 0;
    const start = cookie > BigInt(entries.length) ? entries.length : Number(cookie);
    for (let i = start; i < entries.length && used < bufLen; i++) {
      const entry = entries[i];
      if (entry === undefined) {
        break;
      }
      const bytes = dirent(i, entry.name, entry.kind);
      const n = Math.min(bufLen - used, bytes.length);
      buf.set(bytes.subarray(0, n), used);
      used += n;
      if (n < bytes.length) {
        break;
      }
    }
    writeU32(usedPtr, used);
  };

  const readlink = (
    dirfd: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
    bufLen: number,
    usedPtr: number,
  ) => {
    table.requireRight(dirfd, RIGHT.PATH_READLINK);
    const hostPath = resolveParentOnly(dirfd, readPath(pathPtr, pathLen));
    const target = check(files.readLink(hostPath));
    const out = memory.view(bufPtr, bufLen);
    const used = Math.min(out.length, target.length);
    out.set(target.subarray(0, used));
    writeU32(usedPtr, used);
  };

  const rename = (
    oldFd: number,
    oldPtr: number,
    oldLen: number,
    newFd: number,
    newPtr: number,
    newLen: number,
  ) => {
    table.requireRight(oldFd, RIGHT.PATH_RENAME_SOURCE);
    table.requireRight(newFd, RIGHT.PATH_RENAME_TARGET);
    const oldPath = readPath(oldPtr, oldLen);
    const newPath = readPath(newPtr, newLen);
    for (const p of [oldPath, newPath]) {
      if (fileName(p) === undefined) {
        fail(WasiErrno.NOTCAPABLE);
      }
    }
    const from = table.resolve(oldFd, oldPath);
    const to = table.resolve(newFd, newPath);
    enforceBoundary(files, from.boundaryRoot, from.hostPath, { kind: 'parent-only' });
    enforceBoundary(files, to.boundaryRoot, to.hostPath, { kind: 'parent-only' });
    check(files.rename(from.hostPath, to.hostPath));
  };

  /** create_directory / remove_directory / unlink_file share one shape. */
  const entryOp =
    (right: bigint, op: (hostPath: string) => ReturnType<typeof files.rmdir>) =>
    (dirfd: number, pathPtr: number, pathLen: number): number =>
      withMemory(() => {
        table.requireRight(dirfd, right);
        check(op(resolveParentOnly(dirfd, entryPath(pathPtr, pathLen))));
      });

  return {
    args_get: fn(['u32', 'u32'], 'i32', (argvPtr, bufPtr) =>
      withMemory(() => writeTable(argv, argvPtr, bufPtr)),
    ),
    args_sizes_get: fn(['u32', 'u32'], 'i32', (argcPtr, sizePtr) =>
      withMemory(() => tableSizes(argv, argcPtr, sizePtr)),
    ),
    environ_get: fn(['u32', 'u32'], 'i32', (environPtr, bufPtr) =>
      withMemory(() => writeTable(environ(), environPtr, bufPtr)),
    ),
    environ_sizes_get: fn(['u32', 'u32'], 'i32', (countPtr, sizePtr) =>
      withMemory(() => tableSizes(environ(), countPtr, sizePtr)),
    ),
    random_get: fn(['u32', 'u32'], 'i32', (buf, len) =>
      withMemory(() => ctx.host.random.fill(memory.view(buf, len))),
    ),
    fd_read: fn(['i32', 'u32', 'u32', 'u32'], 'i32', (fd, iovs, iovsLen, nreadPtr) =>
      withMemory(() => {
        table.requireRight(fd, RIGHT.FD_READ);
        const file = fd > FD_STDERR ? table.file(fd) : undefined;
        const total =
          fd === FD_STDIN || file === undefined
            ? readInto(iovs, iovsLen, readStdin)
            : readInto(iovs, iovsLen, (b) => check(files.read(file.fd, b)));
        writeU32(nreadPtr, total);
      }),
    ),
    fd_write: fn(['i32', 'u32', 'u32', 'u32'], 'i32', (fd, iovs, iovsLen, nwrittenPtr) =>
      withMemory(() => {
        table.requireRight(fd, RIGHT.FD_WRITE);
        const total =
          fd === FD_STDOUT || fd === FD_STDERR
            ? stdioWrite(fd, iovs, iovsLen)
            : fileWrite(fd, iovs, iovsLen);
        writeU32(nwrittenPtr, total);
      }),
    ),
    fd_close: fn(['i32'], 'i32', (fd) =>
      guard(() => {
        const d = fd <= FD_PREOPEN ? undefined : table.remove(fd);
        if (d === undefined) {
          fail(WasiErrno.BADF);
        }
        if (d.kind === 'file') {
          files.close(d.fd);
        }
      }),
    ),
    fd_prestat_get: fn(['i32', 'u32'], 'i32', (fd, ptr) =>
      withMemory(() => {
        if (fd !== FD_PREOPEN) {
          fail(WasiErrno.BADF);
        }
        const prestat = memory.view(ptr, 8);
        prestat.fill(0);
        // pr_type = dir (0), pr_name_len = length of ".".
        prestat[4] = 1;
      }),
    ),
    fd_prestat_dir_name: fn(['i32', 'u32', 'u32'], 'i32', (fd, ptr, len) =>
      withMemory(() => {
        if (fd !== FD_PREOPEN) {
          fail(WasiErrno.BADF);
        }
        if (len < 1) {
          fail(WasiErrno.NAMETOOLONG);
        }
        memory.view(ptr, len).set(encoder.encode('.'));
      }),
    ),
    fd_readdir: fn(['i32', 'u32', 'u32', 'u64', 'u32'], 'i32', (fd, buf, len, cookie, usedPtr) =>
      withMemory(() => readdir(fd, buf, len, cookie, usedPtr)),
    ),
    path_open: fn(
      ['i32', 'i32', 'u32', 'u32', 'i32', 'u64', 'u64', 'i32', 'u32'],
      'i32',
      (...args) => withMemory(() => pathOpen(...args)),
    ),
    path_readlink: fn(['i32', 'u32', 'u32', 'u32', 'u32', 'u32'], 'i32', (...args) =>
      withMemory(() => readlink(...args)),
    ),
    path_rename: fn(['i32', 'u32', 'u32', 'i32', 'u32', 'u32'], 'i32', (...args) =>
      withMemory(() => rename(...args)),
    ),
    path_create_directory: fn(
      ['i32', 'u32', 'u32'],
      'i32',
      entryOp(RIGHT.PATH_CREATE_DIRECTORY, (p) => files.mkdir(p)),
    ),
    path_remove_directory: fn(
      ['i32', 'u32', 'u32'],
      'i32',
      entryOp(RIGHT.PATH_REMOVE_DIRECTORY, (p) => files.rmdir(p)),
    ),
    path_unlink_file: fn(
      ['i32', 'u32', 'u32'],
      'i32',
      entryOp(RIGHT.PATH_UNLINK_FILE, (p) => files.unlink(p)),
    ),
    // Codes that do not fit in i32 become 1 (`i32::try_from(code).unwrap_or(1)`).
    proc_exit: fn(['u32'], 'void', (code) => requestExit(ctx, code > 0x7fff_ffff ? 1 : code)),
  };
};
