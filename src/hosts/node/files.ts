import * as fs from 'node:fs';
import type { DirEntry, FilePort, FileStat, HostFd, OpenFlags } from '../../ports/files.ts';
import type { FileKind } from '../../ports/fs.ts';
import { err, type HostError, ok, type Result } from '../../ports/result.ts';
import { toHostError } from './fs.ts';

function attempt<T>(f: () => T): Result<T, HostError> {
  try {
    return ok(f());
  } catch (e) {
    return err(toHostError(e));
  }
}

function kindOf(entry: fs.Dirent<Buffer> | fs.BigIntStats): FileKind {
  return entry.isFile()
    ? 'file'
    : entry.isDirectory()
      ? 'dir'
      : entry.isSymbolicLink()
        ? 'symlink'
        : 'other';
}

function toStat(s: fs.BigIntStats): FileStat {
  return {
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
  return n;
}

function readDir(path: string): DirEntry[] {
  // `readdirSync` sorts (libuv scandir); `opendirSync` keeps the OS order like Rust's `read_dir`.
  // `encoding: 'buffer'` keeps raw name bytes; @types/node does not declare it for opendir.
  const dir = fs.opendirSync(path, { encoding: 'buffer' as BufferEncoding });
  try {
    const entries: DirEntry[] = [];
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      const entry = e as unknown as fs.Dirent<Buffer>;
      entries.push({ name: new Uint8Array(entry.name), kind: kindOf(entry) });
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
    fstat: (fd) => attempt(() => toStat(fs.fstatSync(fd, { bigint: true }))),
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
    realpath: (p) => attempt(() => fs.realpathSync.native(at(p))),
  };
}
