import type {
  AsyncFilePort,
  DirectoryReader,
  FilePort,
  FileStat,
  HostFd,
  OpenFlags,
} from '../../ports/files.ts';
import type { FsPort } from '../../ports/fs.ts';
import { err, type HostError, type HostErrorCode, ok, type Result } from '../../ports/result.ts';

/** null preloads a directory; strings are UTF-8. Parents are created automatically. */
export type BrowserFiles = Readonly<Record<string, Uint8Array | string | null>>;

type Entry = { ino: bigint; mode: number; time: bigint; nlink: bigint } & (
  | { kind: 'file'; bytes: Uint8Array }
  | { kind: 'dir'; children: Map<string, Entry> }
  | { kind: 'symlink'; target: string }
);
interface Descriptor {
  entry: Entry;
  flags: OpenFlags;
  offset: number;
}
class VfsError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode) {
    super(code);
    this.code = code;
  }
}
function fail(code: HostErrorCode): never {
  throw new VfsError(code);
}
function attempt<T>(f: () => T): Result<T, HostError> {
  try {
    return ok(f());
  } catch (e) {
    return err({ code: e instanceof VfsError ? e.code : 'EIO' });
  }
}
const encoder = new TextEncoder();
const readFlags: OpenFlags = {
  access: 'read',
  append: false,
  create: false,
  exclusive: false,
  truncate: false,
};
// A bounded, deliberately small memory filesystem, rather than accidental multi-GB allocation.
const MAX_FILE_SIZE = 64 * 1024 * 1024;
function sizeOf(n: bigint): number {
  if (n < 0n) fail('EINVAL');
  if (n > BigInt(MAX_FILE_SIZE)) fail('EFBIG');
  return Number(n);
}

/** Per-host filesystem. Open descriptors retain their inode through rename/unlink. */
export class MemoryVfs {
  readonly fs: FsPort;
  readonly files: FilePort;
  readonly #root: Entry;
  readonly #cwd: string;
  readonly #fds = new Map<HostFd, Descriptor>();
  #ino = 0n;
  #fd = 3;

  constructor(preload: BrowserFiles = {}, cwd = '/work') {
    this.#root = this.#entry('dir');
    this.#cwd = cwd.startsWith('/') ? cwd : `/${cwd}`;
    this.#mkdirAll(this.#cwd);
    this.#cwd = this.#find(this.#cwd).path;
    for (const [path, value] of Object.entries(preload)) {
      if (value === null) this.#mkdirAll(path);
      else {
        const parts = this.#parts(path);
        parts.pop();
        this.#mkdirAll(`/${parts.join('/')}`);
        this.#writeFile(path, typeof value === 'string' ? encoder.encode(value) : value);
      }
    }
    const files: FilePort = {
      open: (p, flags) => attempt(() => this.#open(p, flags)),
      close: (fd) =>
        attempt(() => {
          this.#descriptor(fd);
          this.#fds.delete(fd);
        }),
      read: (fd, buffer, position) =>
        attempt(() => {
          const d = this.#descriptor(fd);
          if (d.flags.access === 'write') fail('EBADF');
          if (d.entry.kind !== 'file') fail('EISDIR');
          if (position !== undefined && position < 0n) fail('EINVAL');
          const pos = position === undefined ? d.offset : Number(position);
          const chunk = d.entry.bytes.subarray(pos, pos + buffer.length);
          buffer.set(chunk);
          if (position === undefined) d.offset += chunk.length;
          return chunk.length;
        }),
      write: (fd, bytes, position) =>
        attempt(() => {
          const d = this.#descriptor(fd);
          if (d.flags.access === 'read') fail('EBADF');
          if (d.entry.kind !== 'file') fail('EISDIR');
          const pos = d.flags.append
            ? d.entry.bytes.length
            : position === undefined
              ? d.offset
              : sizeOf(position);
          this.#resize(d.entry, Math.max(d.entry.bytes.length, sizeOf(BigInt(pos + bytes.length))));
          d.entry.bytes.set(bytes, pos);
          d.entry.time = this.#now();
          if (position === undefined) d.offset = pos + bytes.length;
          return bytes.length;
        }),
      fsync: (fd) =>
        attempt(() => {
          this.#descriptor(fd);
        }),
      truncate: (fd, size) =>
        attempt(() => {
          const d = this.#descriptor(fd);
          if (d.flags.access === 'read') fail('EBADF');
          this.#resize(d.entry, sizeOf(size));
        }),
      fstat: (fd) => attempt(() => this.#stat(this.#descriptor(fd).entry)),
      stat: (p) => attempt(() => this.#stat(this.#find(p).entry)),
      lstat: (p) => attempt(() => this.#stat(this.#find(p, false).entry)),
      readDir: (p) =>
        attempt(() =>
          [...this.#directory(p).children].map(([name, entry]) => ({
            name: encoder.encode(name),
            kind: entry.kind,
          })),
        ),
      readLink: (p) =>
        attempt(() => {
          const e = this.#find(p, false).entry;
          if (e.kind !== 'symlink') fail('EINVAL');
          return encoder.encode(e.target);
        }),
      symlink: (target, p) =>
        attempt(() => {
          const [parent, name] = this.#parent(p);
          if (parent.children.has(name)) fail('EEXIST');
          const entry = this.#entry('symlink');
          if (entry.kind === 'symlink') entry.target = target;
          parent.children.set(name, entry);
        }),
      rename: (from, to) => attempt(() => this.#rename(from, to)),
      mkdir: (p, mode) => attempt(() => this.#mkdir(p, mode)),
      rmdir: (p) => attempt(() => this.#remove(p, true)),
      unlink: (p) => attempt(() => this.#remove(p, false)),
      access: (p, mode) =>
        attempt(() => {
          const e = this.#find(p).entry;
          const mask =
            mode === 'read' ? 0o444 : mode === 'write' ? 0o222 : mode === 'execute' ? 0o111 : 0;
          if (mask !== 0 && (e.mode & mask) === 0) fail('EACCES');
        }),
      realpath: (p) => attempt(() => this.#find(p).path),
      async: this.#asyncFiles(),
    };
    this.files = files;
    this.fs = {
      cwd: () => ok(this.#cwd),
      resolve: (p) => {
        const out: string[] = [];
        for (const part of this.#parts(p)) {
          if (part === '..') out.pop();
          else if (part !== '.') out.push(part);
        }
        return `/${out.join('/')}`;
      },
      readFile: (p) =>
        attempt(() => {
          const e = this.#find(p).entry;
          if (e.kind !== 'file') fail('EISDIR');
          return e.bytes.slice();
        }),
      writeFile: (p, bytes) => attempt(() => this.#writeFile(p, bytes)),
      mkdirAll: (p) => attempt(() => this.#mkdirAll(p)),
      readDir: (p) => attempt(() => [...this.#directory(p).children.keys()]),
      removeFile: files.unlink,
      removeDirAll: (p) =>
        attempt(() => {
          const [parent, name] = this.#parent(p);
          const e = parent.children.get(name);
          if (e === undefined) fail('ENOENT');
          if (e.kind === 'file') fail('ENOTDIR');
          parent.children.delete(name);
          e.nlink = 0n;
        }),
      kind: (p) => attempt(() => this.#find(p).entry.kind),
    };
  }

  #now(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }
  #entry(kind: Entry['kind'], mode = kind === 'dir' ? 0o777 : 0o666): Entry {
    const common = { ino: ++this.#ino, mode, time: this.#now(), nlink: 1n };
    if (kind === 'file') return { ...common, kind, bytes: new Uint8Array() };
    if (kind === 'dir') return { ...common, kind, children: new Map() };
    return { ...common, kind, target: '' };
  }
  #parts(p: string): string[] {
    if (p.includes('\0')) fail('EINVAL');
    return (p.startsWith('/') ? p : `${this.#cwd}/${p}`).split('/').filter(Boolean);
  }
  #find(p: string, follow = true): { entry: Entry; path: string } {
    if (p === '') fail('ENOENT');
    const todo = this.#parts(p);
    const stack: { entry: Entry; name: string }[] = [{ entry: this.#root, name: '' }];
    let links = 0;
    while (todo.length > 0) {
      const part = todo.shift() as string;
      const parent = stack.at(-1)?.entry as Entry;
      if (parent.kind !== 'dir') fail('ENOTDIR');
      if (part === '.') continue;
      if (part === '..') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const e = parent.children.get(part);
      if (e === undefined) fail('ENOENT');
      if (e.kind === 'symlink' && (follow || todo.length > 0 || p.endsWith('/'))) {
        if (++links > 40) fail('ELOOP');
        if (e.target.startsWith('/')) stack.splice(1);
        todo.unshift(...e.target.split('/').filter(Boolean));
      } else stack.push({ entry: e, name: part });
    }
    const entry = stack.at(-1)?.entry as Entry;
    if (p.endsWith('/') && entry.kind !== 'dir') fail('ENOTDIR');
    return {
      entry,
      path: `/${stack
        .slice(1)
        .map((e) => e.name)
        .join('/')}`,
    };
  }
  #directory(p: string): Entry & { kind: 'dir' } {
    const e = this.#find(p).entry;
    if (e.kind !== 'dir') fail('ENOTDIR');
    return e;
  }
  #parent(p: string): [Entry & { kind: 'dir' }, string] {
    const parts = this.#parts(p);
    const name = parts.pop();
    if (name === undefined || name === '.' || name === '..') fail('EBUSY');
    if (encoder.encode(name).length > 255) fail('ENAMETOOLONG');
    return [this.#directory(`/${parts.join('/')}`), name];
  }
  #descriptor(fd: HostFd): Descriptor {
    const d = this.#fds.get(fd);
    if (d === undefined) fail('EBADF');
    return d;
  }
  #open(p: string, flags: OpenFlags): HostFd {
    let e: Entry;
    try {
      e = this.#find(p, flags.noFollow !== true && !flags.exclusive).entry;
      if (flags.exclusive) fail('EEXIST');
      if (flags.noFollow === true && e.kind === 'symlink') fail('ELOOP');
    } catch (error) {
      if (
        !(error instanceof VfsError) ||
        error.code !== 'ENOENT' ||
        !(flags.create || flags.exclusive)
      )
        throw error;
      if (flags.directory === true || p.endsWith('/')) fail('ENOENT');
      const [parent, name] = this.#parent(p);
      const existing = parent.children.get(name);
      if (existing?.kind === 'symlink') {
        const leaf = this.#find(p, false);
        const base = leaf.path.slice(0, leaf.path.lastIndexOf('/'));
        return this.#open(
          existing.target.startsWith('/') ? existing.target : `${base}/${existing.target}`,
          flags,
        );
      }
      e = this.#entry('file', flags.mode);
      parent.children.set(name, e);
    }
    if (flags.directory === true && e.kind !== 'dir') fail('ENOTDIR');
    if (e.kind === 'dir' && flags.access !== 'read') fail('EISDIR');
    if (flags.truncate) this.#resize(e, 0);
    const fd = this.#fd++ as HostFd;
    this.#fds.set(fd, { entry: e, flags, offset: 0 });
    return fd;
  }
  #resize(e: Entry, size: number): void {
    if (e.kind !== 'file') fail('EISDIR');
    if (e.bytes.length !== size) {
      const bytes = new Uint8Array(size);
      bytes.set(e.bytes.subarray(0, size));
      e.bytes = bytes;
    }
    e.time = this.#now();
  }
  #writeFile(p: string, bytes: Uint8Array): void {
    const fd = this.#open(p, { ...readFlags, access: 'write', create: true, truncate: true });
    try {
      const d = this.#descriptor(fd);
      this.#resize(d.entry, sizeOf(BigInt(bytes.length)));
      if (d.entry.kind === 'file') d.entry.bytes.set(bytes);
    } finally {
      this.#fds.delete(fd);
    }
  }
  #mkdir(p: string, mode?: number): void {
    const [parent, name] = this.#parent(p);
    if (parent.children.has(name)) fail('EEXIST');
    parent.children.set(name, this.#entry('dir', mode));
  }
  #mkdirAll(p: string): void {
    let path = '';
    for (const part of this.#parts(p)) {
      path += `/${part}`;
      try {
        this.#directory(path);
      } catch (e) {
        if (!(e instanceof VfsError) || e.code !== 'ENOENT') throw e;
        this.#mkdir(path);
      }
    }
  }
  #remove(p: string, directory: boolean): void {
    const [parent, name] = this.#parent(p);
    const e = parent.children.get(name);
    if (e === undefined) fail('ENOENT');
    if (directory && e.kind !== 'dir') fail('ENOTDIR');
    if (!directory && e.kind === 'dir') fail('EISDIR');
    if (e.kind === 'dir' && e.children.size > 0) fail('ENOTEMPTY');
    parent.children.delete(name);
    e.nlink = 0n;
  }
  #rename(from: string, to: string): void {
    const [a, x] = this.#parent(from);
    const [b, y] = this.#parent(to);
    const e = a.children.get(x);
    if (e === undefined) fail('ENOENT');
    const old = b.children.get(y);
    if (old === e) return;
    if (e.kind === 'dir') {
      const contains = (dir: Entry): boolean =>
        dir === b || (dir.kind === 'dir' && [...dir.children.values()].some(contains));
      if (contains(e)) fail('EINVAL');
    }
    if (old !== undefined) {
      if (old.kind === 'dir' && e.kind !== 'dir') fail('EISDIR');
      if (old.kind !== 'dir' && e.kind === 'dir') fail('ENOTDIR');
      if (old.kind === 'dir' && old.children.size > 0) fail('ENOTEMPTY');
      old.nlink = 0n;
    }
    b.children.set(y, e);
    a.children.delete(x);
  }
  #stat(e: Entry): FileStat {
    const size = BigInt(
      e.kind === 'file'
        ? e.bytes.length
        : e.kind === 'symlink'
          ? encoder.encode(e.target).length
          : 0,
    );
    return {
      kind: e.kind,
      ino: e.ino,
      dev: 1n,
      mode: BigInt(
        e.mode | (e.kind === 'dir' ? 0o040000 : e.kind === 'symlink' ? 0o120000 : 0o100000),
      ),
      nlink: e.nlink,
      uid: 0n,
      gid: 0n,
      rdev: 0n,
      size,
      blksize: 4096n,
      blocks: (size + 511n) / 512n,
      atimeNs: e.time,
      mtimeNs: e.time,
      ctimeNs: e.time,
      birthtimeNs: 0n,
    };
  }
  #asyncFiles(): AsyncFilePort {
    return {
      open: async (p, f) => this.files.open(p, f),
      openPath: (p) => this.files.open(p, readFlags),
      read: async (fd, b, p) => this.files.read(fd, b, p),
      write: async (fd, b, p) => this.files.write(fd, b, p),
      fsync: async (fd) => this.files.fsync(fd),
      fstat: async (fd) => this.files.fstat(fd),
      statAt: async (fd, p, follow) =>
        attempt(() => {
          if (fd === undefined || p.startsWith('/')) return this.#stat(this.#find(p, follow).entry);
          const dir = this.#descriptor(fd).entry;
          if (dir.kind !== 'dir') fail('ENOTDIR');
          const locate = (e: Entry, path: string): string | undefined => {
            if (e === dir) return path;
            if (e.kind === 'dir')
              for (const [name, child] of e.children) {
                const found = locate(child, `${path}/${name}`);
                if (found !== undefined) return found;
              }
            return undefined;
          };
          const base = locate(this.#root, '');
          if (base === undefined || p === '') fail('ENOENT');
          return this.#stat(this.#find(`${base}/${p}`, follow).entry);
        }),
      access: async (p, m) => this.files.access(p, m),
      chmod: async (p, mode) =>
        attempt(() => {
          this.#find(p).entry.mode = mode & 0o7777;
        }),
      unlink: async (p) => this.files.unlink(p),
      rmdir: async (p) => this.files.rmdir(p),
      mkdir: async (p, m) => this.files.mkdir(p, m),
      rename: async (a, b) => this.files.rename(a, b),
      symlink: async (a, b) => this.files.symlink(a, b),
      realpath: async (p) => {
        const r = this.files.realpath(p);
        return r.ok ? ok(encoder.encode(r.value)) : r;
      },
      openDirectory: async (fd) =>
        attempt(() => {
          const e = this.#descriptor(fd).entry;
          if (e.kind !== 'dir') fail('ENOTDIR');
          const entries = [...e.children];
          let index = 0;
          let closed = false;
          const reader: DirectoryReader = {
            next: async () => {
              if (closed) return err({ code: 'EBADF' });
              const item = entries[index++];
              return ok(
                item === undefined
                  ? null
                  : {
                      ino: item[1].ino,
                      name: encoder.encode(item[0]),
                      type: item[1].kind === 'dir' ? 4 : item[1].kind === 'file' ? 8 : 10,
                    },
              );
            },
            close: () => {
              closed = true;
            },
          };
          return reader;
        }),
      watch: () => err({ code: 'ENOSYS' }),
    };
  }
}
