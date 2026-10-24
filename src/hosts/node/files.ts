import * as fs from 'node:fs';
import { isatty } from 'node:tty';
import type {
  AccessMode,
  AsyncFilePort,
  DirEntry,
  DirectoryReader,
  DirectoryRecord,
  FilePort,
  FileStat,
  HostFd,
  OpenFlags,
} from '../../ports/files.ts';
import type { FileKind } from '../../ports/fs.ts';
import { err, type HostError, hostError, ok, type Result } from '../../ports/result.ts';
import { toHostError } from './fs.ts';

function attempt<T>(f: () => T): Result<T, HostError> {
  try {
    return ok(f());
  } catch (e) {
    return err(toHostError(e));
  }
}

function kindOf(entry: fs.Dirent<string | Buffer> | fs.BigIntStats): FileKind {
  return entry.isFile()
    ? 'file'
    : entry.isDirectory()
      ? 'dir'
      : entry.isSymbolicLink()
        ? 'symlink'
        : 'other';
}

function toStat(s: fs.BigIntStats, fd?: HostFd): FileStat {
  return {
    isTerminal: fd !== undefined && isatty(fd),
    kind: kindOf(s),
    dev: s.dev,
    ino: s.ino,
    mode: s.mode,
    nlink: s.nlink,
    uid: s.uid,
    gid: s.gid,
    rdev: s.rdev,
    size: s.size,
    blksize: s.blksize,
    blocks: s.blocks,
    atimeNs: s.atimeNs,
    mtimeNs: s.mtimeNs,
    ctimeNs: s.ctimeNs,
    birthtimeNs: s.birthtimeNs,
  };
}

function openFlags(flags: OpenFlags): number {
  const c = fs.constants;
  let n = flags.access === 'read' ? c.O_RDONLY : flags.access === 'write' ? c.O_WRONLY : c.O_RDWR;
  if (flags.append) n |= c.O_APPEND;
  if (flags.create || flags.exclusive) n |= c.O_CREAT;
  if (flags.exclusive) n |= c.O_EXCL;
  if (flags.truncate) n |= c.O_TRUNC;
  if (flags.directory === true) n |= c.O_DIRECTORY;
  if (flags.noFollow === true) n |= c.O_NOFOLLOW;
  if (flags.sync === 'data') n |= c.O_DSYNC;
  if (flags.sync === 'full') n |= c.O_SYNC;
  return n;
}

function readDir(path: string): DirEntry[] {
  // `readdirSync` sorts (libuv scandir); `opendirSync` keeps the OS order like Rust's `read_dir`.
  // `encoding: 'buffer'` keeps raw name bytes; @types/node does not declare it for opendir.
  const dir = fs.opendirSync(path, { encoding: 'buffer' as BufferEncoding, bufferSize: 32 });
  try {
    const entries: DirEntry[] = [];
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      const name = entryName(e);
      const entry = asDirent(e);
      entries.push({
        name,
        kind:
          entry === undefined
            ? kindOf(fs.lstatSync(Buffer.concat([Buffer.from(`${path}/`), name]), { bigint: true }))
            : kindOf(entry),
      });
    }
    return entries;
  } finally {
    dir.closeSync();
  }
}

/** Joins without normalizing, so `..` keeps its physical meaning. */
function under(cwd: string, p: string): string {
  if (p.startsWith('/')) {
    return p;
  }
  return cwd.endsWith('/') ? cwd + p : `${cwd}/${p}`;
}

export function nodeFiles(cwd: string = process.cwd()): FilePort {
  const at = (p: string): string => under(cwd, p);
  return {
    open: (p, flags) =>
      attempt(() => fs.openSync(at(p), openFlags(flags), flags.mode ?? 0o666) as HostFd),
    close: (fd) => attempt(() => fs.closeSync(fd)),
    read: (fd, buffer, position) =>
      attempt(() => fs.readSync(fd, buffer, 0, buffer.length, position ?? null)),
    write: (fd, bytes, position) =>
      attempt(() =>
        fs.writeSync(fd, bytes, 0, bytes.length, position === undefined ? null : Number(position)),
      ),
    fsync: (fd) => attempt(() => fs.fsyncSync(fd)),
    truncate: (fd, size) => attempt(() => fs.ftruncateSync(fd, Number(size))),
    fstat: (fd) => attempt(() => toStat(fs.fstatSync(fd, { bigint: true }), fd)),
    stat: (p) => attempt(() => toStat(fs.statSync(at(p), { bigint: true }))),
    lstat: (p) => attempt(() => toStat(fs.lstatSync(at(p), { bigint: true }))),
    readDir: (p) => attempt(() => readDir(at(p))),
    readLink: (p) => attempt(() => new Uint8Array(fs.readlinkSync(at(p), { encoding: 'buffer' }))),
    symlink: (target, p) => attempt(() => fs.symlinkSync(target, at(p))),
    rename: (from, to) => attempt(() => fs.renameSync(at(from), at(to))),
    mkdir: (p, mode) =>
      attempt(() => {
        fs.mkdirSync(at(p), { mode: mode ?? 0o777 });
      }),
    rmdir: (p) => attempt(() => fs.rmdirSync(at(p))),
    unlink: (p) => attempt(() => fs.unlinkSync(at(p))),
    access: (p, mode) => attempt(() => fs.accessSync(at(p), ACCESS[mode])),
    realpath: (p) => attempt(() => fs.realpathSync.native(at(p))),
    async: nodeAsyncFiles(at),
  };
}

/** Runs a callback-style `node:fs` call (libuv thread pool) as a Result promise. */
function settle<T>(
  start: (callback: (e: NodeJS.ErrnoException | null | undefined, value: T) => void) => void,
) {
  return new Promise<Result<T, HostError>>((resolve) => {
    try {
      start((e, value) => resolve(e === null || e === undefined ? ok(value) : err(toHostError(e))));
    } catch (e) {
      resolve(err(toHostError(e)));
    }
  });
}

const ACCESS: Readonly<Record<AccessMode, number>> = {
  exists: fs.constants.F_OK,
  read: fs.constants.R_OK,
  write: fs.constants.W_OK,
  execute: fs.constants.X_OK,
};

/** Linux `O_PATH`, which `fs.constants` does not export. */
const O_PATH = 0o10000000;

/** Linux `d_type` of a directory entry. */
function direntType(entry: fs.Dirent<string | Buffer> | fs.BigIntStats): number {
  if (entry.isFIFO()) return 1;
  if (entry.isCharacterDevice()) return 2;
  if (entry.isDirectory()) return 4;
  if (entry.isBlockDevice()) return 6;
  if (entry.isFile()) return 8;
  if (entry.isSymbolicLink()) return 10;
  if (entry.isSocket()) return 12;
  return 0;
}

/** The path of an open descriptor (Linux procfs). */
const fdPath = (fd: HostFd): string => `/proc/self/fd/${fd}`;

/** Bun returns the name itself; Deno returns a string name even for buffer encoding. */
function entryName(raw: unknown): Buffer {
  const name = typeof raw === 'object' && raw !== null && 'name' in raw ? raw.name : raw;
  if (typeof name === 'string') return Buffer.from(name);
  if (name instanceof Uint8Array) return Buffer.from(name);
  throw new TypeError('invalid directory entry');
}

function asDirent(raw: unknown): fs.Dirent<string | Buffer> | undefined {
  return typeof raw === 'object' &&
    raw !== null &&
    'isFile' in raw &&
    typeof raw.isFile === 'function'
    ? (raw as fs.Dirent<string | Buffer>)
    : undefined;
}

function directoryReader(fd: HostFd, dir: fs.Dir): DirectoryReader {
  const base = Buffer.from(`${fdPath(fd)}/`);
  let closed = false;
  return {
    next: async () => {
      let entry: fs.Dirent<Buffer> | null;
      try {
        entry = (await dir.read()) as unknown as fs.Dirent<Buffer> | null;
      } catch (e) {
        return err(toHostError(e));
      }
      if (entry === null) {
        return ok(null);
      }
      const name = entryName(entry);
      // `Dirent` has no `d_ino`; the entry's own inode is what getdents reports.
      const stat = await settle<fs.BigIntStats>((cb) =>
        fs.lstat(Buffer.concat([base, name]), { bigint: true }, cb),
      );
      const record: DirectoryRecord = {
        ino: stat.ok ? stat.value.ino : 0n,
        type:
          asDirent(entry) === undefined
            ? stat.ok
              ? direntType(stat.value)
              : 0
            : direntType(entry),
        name,
      };
      return ok(record);
    },
    close: () => {
      if (!closed) {
        closed = true;
        dir.close().catch(() => undefined);
      }
    },
  };
}

function nodeAsyncFiles(at: (p: string) => string): AsyncFilePort {
  type Listener = Parameters<AsyncFilePort['watch']>[1];
  const watches = new Map<
    string,
    { watcher: fs.FSWatcher; fd: number; target: string; listeners: Set<Listener> }
  >();
  const statOf = (p: string | Buffer, follow: boolean) =>
    settle<fs.BigIntStats>((cb) =>
      follow ? fs.stat(p, { bigint: true }, cb) : fs.lstat(p, { bigint: true }, cb),
    ).then((r) => (r.ok ? ok(toStat(r.value)) : r));
  const done = (r: Result<unknown, HostError>): Result<void, HostError> =>
    r.ok ? ok(undefined) : r;
  return {
    open: (p, flags) =>
      settle<number>((cb) => fs.open(at(p), openFlags(flags), flags.mode ?? 0o666, cb)).then(
        (r) => r as Result<HostFd, HostError>,
      ),
    openPath: (p) =>
      attempt(() => {
        try {
          return fs.openSync(at(p), O_PATH) as HostFd;
        } catch (e) {
          if (toHostError(e).code !== 'EINVAL') {
            throw e;
          }
          return fs.openSync(at(p), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) as HostFd;
        }
      }),
    read: (fd, buffer, position) =>
      settle<number>((cb) => fs.read(fd, buffer, 0, buffer.length, position ?? null, cb)),
    write: (fd, bytes, position) =>
      settle<number>((cb) =>
        fs.write(fd, bytes, 0, bytes.length, position === undefined ? null : Number(position), cb),
      ),
    fsync: (fd, dataOnly) =>
      settle<void>((cb) => (dataOnly ? fs.fdatasync(fd, cb) : fs.fsync(fd, cb))).then(done),
    fstat: (fd) =>
      settle<fs.BigIntStats>((cb) => fs.fstat(fd, { bigint: true }, cb)).then((r) =>
        r.ok ? ok(toStat(r.value, fd)) : r,
      ),
    statAt: (dir, p, follow) => {
      if (dir === undefined || p.startsWith('/')) {
        return statOf(at(p), follow);
      }
      if (p === '') {
        return Promise.resolve(err(hostError('ENOENT')));
      }
      return statOf(`${fdPath(dir)}/${p}`, follow);
    },
    access: (p, mode) => settle<void>((cb) => fs.access(at(p), ACCESS[mode], cb)).then(done),
    chmod: (p, mode) => settle<void>((cb) => fs.chmod(at(p), mode, cb)).then(done),
    unlink: (p) => settle<void>((cb) => fs.unlink(at(p), cb)).then(done),
    rmdir: (p) => settle<void>((cb) => fs.rmdir(at(p), cb)).then(done),
    mkdir: (p, mode) => settle<unknown>((cb) => fs.mkdir(at(p), { mode }, cb)).then(done),
    rename: (from, to) => settle<void>((cb) => fs.rename(at(from), at(to), cb)).then(done),
    symlink: (target, p) => settle<void>((cb) => fs.symlink(target, at(p), cb)).then(done),
    realpath: (p) =>
      settle<Buffer>((cb) =>
        fs.realpath.native(at(p), { encoding: 'buffer' }, cb as (e: unknown, v: Buffer) => void),
      ).then((r) => (r.ok ? ok(new Uint8Array(r.value)) : r)),
    openDirectory: async (fd) => {
      try {
        const dir = await fs.promises.opendir(fdPath(fd), {
          encoding: 'buffer' as BufferEncoding,
          bufferSize: 32,
        });
        return ok(directoryReader(fd, dir));
      } catch (e) {
        return err(toHostError(e));
      }
    },
    watch: (p, listener) =>
      attempt(() => {
        // Deno filters events by path and loses a renamed inode's writes. A procfs
        // identity path keeps following the same inode, like inotify/Node.
        const fd = fs.openSync(at(p), O_PATH);
        try {
          const stat = fs.fstatSync(fd, { bigint: true });
          const key = `${stat.dev}:${stat.ino}`;
          let watch = watches.get(key);
          if (watch === undefined) {
            const listeners = new Set<Listener>();
            const identity = fdPath(fd as HostFd);
            const notify = (event: string, name: string | null): void => {
              // Deno also filters a directory's children against its old canonical
              // path after it moves. Re-arm against the identity's current target.
              const current = watches.get(key);
              if (
                process.versions['deno'] !== undefined &&
                event === 'rename' &&
                current !== undefined
              ) {
                try {
                  const target = fs.readlinkSync(identity);
                  if (target !== current.target) {
                    current.target = target;
                    current.watcher.close();
                    current.watcher = start();
                  }
                } catch {
                  // An unlinked inode has no path to watch any longer.
                }
              }
              for (const notify of listeners)
                notify(event === 'change' ? 'change' : 'rename', name);
            };
            const start = (): fs.FSWatcher => {
              const watcher = fs.watch(identity, { persistent: false, encoding: 'utf8' }, notify);
              watcher.on('error', () => undefined);
              return watcher;
            };
            watch = { watcher: start(), fd, target: fs.readlinkSync(identity), listeners };
            watches.set(key, watch);
          } else {
            // Deno removes the OS watch when either duplicate watcher closes.
            fs.closeSync(fd);
          }
          const shared = watch;
          const subscribed: Listener = (event, name) => listener(event, name);
          shared.listeners.add(subscribed);
          let closed = false;
          return {
            close: () => {
              if (closed) return;
              closed = true;
              shared.listeners.delete(subscribed);
              if (shared.listeners.size === 0) {
                watches.delete(key);
                shared.watcher.close();
                fs.closeSync(shared.fd);
              }
            },
          };
        } catch (e) {
          fs.closeSync(fd);
          throw e;
        }
      }),
  };
}
