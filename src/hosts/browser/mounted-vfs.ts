import type { DirectoryReader, FilePort, FileStat, HostFd, OpenFlags } from '../../ports/files.ts';
import type { FsPort } from '../../ports/fs.ts';
import { err, type HostError, type HostErrorCode, ok, type Result } from '../../ports/result.ts';
import {
  type BrowserMounts,
  type MountEntry,
  type MountFile,
  type MountProvider,
  type MountStat,
  mountError,
  mounted,
  take,
} from './mount-provider.ts';
import { type BrowserFiles, MemoryVfs, vfsView } from './vfs.ts';

const encode = new TextEncoder();
const decode = new TextDecoder();
const reading: OpenFlags = {
  access: 'read',
  append: false,
  create: false,
  exclusive: false,
  truncate: false,
};
const CACHE_LIMIT = 64 * 1024 * 1024;
function fail(code: HostErrorCode): never {
  throw { code };
}
function sync<T>(work: () => T): Result<T, HostError> {
  try {
    return ok(work());
  } catch (e) {
    return err(mountError(e));
  }
}
function integer(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) fail('EINVAL');
  return n;
}
interface Mount {
  path: string;
  provider: MountProvider;
}
interface Description {
  path: string;
  mount: Mount;
  flags: OpenFlags;
  stat: FileStat;
  reader: MountFile | undefined;
  offset: number;
  refs: number;
  tail: Promise<void>;
}
type Lookup = { kind: 'stat' | 'link'; path: string };
type Located = { path: string; stat: FileStat };

/** An overlay at the browser ports; the kernel continues to own all async job semantics. */
export class MountedVfs {
  readonly fs: FsPort;
  readonly files: FilePort;
  readonly #memory: MemoryVfs;
  readonly #mounts: Mount[];
  readonly #virtual = new Set<string>();
  readonly #fds = new Map<HostFd, Description>();
  readonly #paths = new Map<HostFd, string>();
  readonly #stats = new Map<string, FileStat>();
  readonly #links = new Map<string, string>();
  readonly #dirs = new Map<string, readonly MountEntry[]>();
  readonly #bytes = new Map<string, Map<number, Uint8Array>>();
  readonly #inos = new Map<string, bigint>();
  readonly #writes = new Map<string, Promise<void>>();
  #cachedBytes = 0;

  constructor(preload: BrowserFiles | undefined, cwd: string | undefined, mounts: BrowserMounts) {
    this.#memory = new MemoryVfs(preload, cwd);
    this.#mounts = Object.entries(mounts)
      .map(([path, provider]) => {
        if (!path.startsWith('/') || path.includes('\0')) fail('EINVAL');
        return { path: this.#memory.fs.resolve(path), provider };
      })
      .sort((a, b) => b.path.length - a.path.length);
    if (new Set(this.#mounts.map((m) => m.path)).size !== this.#mounts.length) fail('EINVAL');
    for (const { path } of this.#mounts) {
      take(this.#memory.fs.mkdirAll(path));
      let p = path;
      for (;;) {
        this.#virtual.add(p);
        if (p === '/') break;
        p = p.slice(0, p.lastIndexOf('/')) || '/';
      }
    }
    const base = this.#memory.files;
    const mutation = (p: string, work: (p: string) => Result<void, HostError>) =>
      sync(() => {
        const path = this.#parentSync(p);
        if (this.#mount(path)) fail('EROFS');
        return take(work(path));
      });
    this.files = {
      ...base,
      open: (p, flags) =>
        sync(() => {
          if (
            this.#mount(this.#memory.fs.resolve(p)) &&
            (flags.access !== 'read' || flags.create || flags.truncate || flags.exclusive)
          )
            fail('EROFS');
          let found: Located;
          try {
            found = this.#resolveSync(p);
          } catch (e) {
            if (mountError(e).code !== 'ENOENT' || !flags.create) throw e;
            const path = this.#parentSync(p);
            if (this.#mount(path)) fail('EROFS');
            return this.#localOpen(path, flags);
          }
          const { path, stat } = found;
          const mount = this.#mount(path);
          if (mount === undefined) return this.#localOpen(path, flags);
          if (flags.access !== 'read' || flags.create || flags.exclusive || flags.truncate)
            fail('EROFS');
          return this.#descriptor(path, mount, stat, flags);
        }),
      close: (fd) =>
        sync(() => {
          this.#paths.delete(fd);
          const d = this.#fds.get(fd);
          if (d !== undefined) {
            this.#fds.delete(fd);
            if (--d.refs === 0) {
              try {
                d.reader?.close?.();
              } catch {
                /* The descriptor must still be released. */
              }
            }
          }
          return take(base.close(fd));
        }),
      read: (fd, b, position) =>
        sync(() => {
          const d = this.#fds.get(fd);
          if (d === undefined) return take(base.read(fd, b, position));
          this.#canRead(d);
          const offset = position === undefined ? d.offset : integer(Number(position));
          const data = this.#cachedRead(d.path, offset, b.length, d.stat);
          b.set(data);
          if (position === undefined) d.offset += data.length;
          return data.length;
        }),
      write: (fd, b, p) => (this.#fds.has(fd) ? err({ code: 'EROFS' }) : base.write(fd, b, p)),
      truncate: (fd, n) => (this.#fds.has(fd) ? err({ code: 'EROFS' }) : base.truncate(fd, n)),
      fsync: (fd) => (this.#fds.has(fd) ? ok(undefined) : base.fsync(fd)),
      fstat: (fd) =>
        sync(() => {
          const d = this.#fds.get(fd);
          return d === undefined ? take(base.fstat(fd)) : this.#statSync(d.path);
        }),
      stat: (p) => sync(() => this.#resolveSync(p).stat),
      lstat: (p) => sync(() => this.#resolveSync(p, false).stat),
      readDir: (p) =>
        sync(() =>
          this.#listSync(this.#resolveSync(p).path).map((e) => ({
            name: encode.encode(e.name),
            kind: e.kind,
          })),
        ),
      readLink: (p) =>
        sync(() => {
          const found = this.#resolveSync(p, false);
          if (found.stat.kind !== 'symlink') fail('EINVAL');
          return encode.encode(this.#linkSync(found.path));
        }),
      realpath: (p) => sync(() => this.#resolveSync(p).path),
      access: (p, mode) => sync(() => this.#access(this.#resolveSync(p), mode)),
      mkdir: (p) => mutation(p, base.mkdir),
      rmdir: (p) => mutation(p, base.rmdir),
      unlink: (p) => mutation(p, base.unlink),
      rename: (a, b) =>
        sync(() => {
          const from = this.#resolveSync(a).path;
          const to = this.#parentSync(b);
          if (this.#virtual.has(from) || this.#virtual.has(to)) fail('EBUSY');
          if (this.#mount(from) || this.#mount(to)) fail('EROFS');
          take(base.rename(from, to));
          this.#movePaths(from, to);
        }),
      symlink: (target, p) => mutation(p, (path) => base.symlink(target, path)),
      async: {
        open: (p, f) => mounted(() => this.#open(p, f)),
        openPath: (p) => this.files.open(p, reading),
        read: (fd, b, p) =>
          this.#fds.has(fd)
            ? mounted(() => this.#queue(fd, (d) => this.#read(d, b, p)))
            : base.async.read(fd, b, p),
        write: (fd, b, p) =>
          this.#fds.has(fd)
            ? mounted(() => this.#queue(fd, (d) => this.#write(d, b, p)))
            : base.async.write(fd, b, p),
        fstat: (fd) =>
          mounted(async () => {
            const d = this.#fds.get(fd);
            if (d === undefined) return take(await base.async.fstat(fd));
            d.stat = await this.#stat(d.path);
            return d.stat;
          }),
        fsync: (fd, dataOnly) =>
          this.#fds.has(fd)
            ? mounted(() => this.#queue(fd, async () => {}))
            : base.async.fsync(fd, dataOnly),
        statAt: (fd, p, follow) =>
          mounted(async () => {
            if (fd === undefined || p.startsWith('/')) return (await this.#resolve(p, follow)).stat;
            const d = this.#fds.get(fd);
            const path = d?.path ?? this.#localPath(fd);
            if (path === undefined) return take(await base.async.statAt(fd, p, follow));
            const stat = d?.stat ?? take(await base.async.fstat(fd));
            if (stat.kind !== 'dir') fail('ENOTDIR');
            if (p === '') fail('ENOENT');
            return (await this.#resolve(`${path}/${p}`, follow)).stat;
          }),
        realpath: (p) => mounted(async () => encode.encode((await this.#resolve(p)).path)),
        access: (p, mode) => mounted(async () => this.#access(await this.#resolve(p), mode)),
        chmod: (p, mode) =>
          mounted(async () => {
            const path = (await this.#resolve(p)).path;
            if (this.#mount(path)) fail('EROFS');
            return take(await base.async.chmod(path, mode));
          }),
        mkdir: (p, mode) => this.#mutate(p, 'mkdir', (path) => base.async.mkdir(path, mode)),
        unlink: (p) => this.#remove(p, false),
        rmdir: (p) => this.#remove(p, true),
        rename: (a, b) => mounted(() => this.#rename(a, b)),
        symlink: (target, p) =>
          mounted(async () => {
            const path = await this.#parent(p);
            if (this.#mount(path)) fail('EROFS');
            return take(await base.async.symlink(target, path));
          }),
        openDirectory: (fd) =>
          mounted(async () => {
            const d = this.#fds.get(fd);
            const path = d?.path ?? this.#localPath(fd);
            if (path === undefined) return take(await base.async.openDirectory(fd));
            const stat = d?.stat ?? take(await base.async.fstat(fd));
            if (stat.kind !== 'dir') fail('ENOTDIR');
            const entries = await this.#list(path);
            let index = 0;
            let closed = false;
            const reader: DirectoryReader = {
              next: async () => {
                if (closed) return err({ code: 'EBADF' });
                const entry = entries[index++];
                return ok(
                  entry === undefined
                    ? null
                    : {
                        name: encode.encode(entry.name),
                        ino: this.#entryIno(`${path === '/' ? '' : path}/${entry.name}`),
                        type:
                          entry.kind === 'dir'
                            ? 4
                            : entry.kind === 'file'
                              ? 8
                              : entry.kind === 'symlink'
                                ? 10
                                : 0,
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
      },
    };
    this.fs = {
      cwd: this.#memory.fs.cwd,
      resolve: this.#memory.fs.resolve,
      kind: (p) => sync(() => this.#resolveSync(p).stat.kind),
      readFile: (p) =>
        sync(() => {
          const { path, stat } = this.#resolveSync(p);
          if (!this.#mount(path)) return take(this.#memory.fs.readFile(path));
          if (stat.kind !== 'file') fail('EISDIR');
          return this.#cachedRead(path, 0, Number(stat.size), stat);
        }),
      readDir: (p) => sync(() => this.#listSync(this.#resolveSync(p).path).map((e) => e.name)),
      writeFile: (p, b) => mutation(p, (path) => this.#memory.fs.writeFile(path, b)),
      mkdirAll: (p) =>
        sync(() => {
          let path = p.startsWith('/') ? '' : take(this.#memory.fs.cwd());
          for (const part of p.split('/').filter(Boolean)) {
            path += `/${part}`;
            try {
              if (this.#mount(this.#resolveSync(path).path)) fail('EROFS');
            } catch (e) {
              if (mountError(e).code === 'ENOENT') break;
              throw e;
            }
          }
          return take(this.#memory.fs.mkdirAll(p));
        }),
      removeFile: this.files.unlink,
      removeDirAll: (p) =>
        sync(() => {
          const path = this.#resolveSync(p).path;
          if (this.#virtual.has(path)) fail('EBUSY');
          if (this.#mount(path)) fail('EROFS');
          return take(this.#memory.fs.removeDirAll(path));
        }),
    };
  }
  view(cwd: string): { fs: FsPort; files: FilePort } {
    return vfsView(this.fs, this.files, this.fs.resolve(cwd));
  }
  duplicate(fd: HostFd): Result<HostFd, HostError> {
    const copy = this.#memory.duplicate(fd);
    const d = this.#fds.get(fd);
    if (copy.ok && d !== undefined) {
      ++d.refs;
      this.#fds.set(copy.value, d);
    }
    if (copy.ok) {
      const path = this.#paths.get(fd);
      if (path !== undefined) this.#paths.set(copy.value, path);
    }
    return copy;
  }
  #mount(path: string): Mount | undefined {
    return this.#mounts.find(
      (m) => m.path === '/' || path === m.path || path.startsWith(`${m.path}/`),
    );
  }
  #relative(m: Mount, p: string): string {
    return m.path === '/' ? p : p.slice(m.path.length) || '/';
  }
  #ino(path: string): bigint {
    let ino = this.#inos.get(path);
    if (ino === undefined) {
      ino = BigInt(this.#inos.size + 1);
      this.#inos.set(path, ino);
    }
    return ino;
  }
  #entryIno(path: string): bigint {
    return this.#mount(path) ? this.#ino(path) : take(this.#memory.files.lstat(path)).ino;
  }
  #localOpen(path: string, flags: OpenFlags): HostFd {
    const fd = take(this.#memory.files.open(path, flags));
    this.#paths.set(fd, path);
    return fd;
  }
  #localPath(fd: HostFd): string | undefined {
    const path = this.#paths.get(fd);
    if (path === undefined) return undefined;
    const stat = this.#memory.files.stat(path);
    const self = this.#memory.files.fstat(fd);
    return stat.ok && self.ok && stat.value.ino === self.value.ino ? path : undefined;
  }
  #movePaths(from: string, to: string): void {
    for (const [fd, path] of this.#paths)
      if (path === from || path.startsWith(`${from}/`))
        this.#paths.set(fd, to + path.slice(from.length));
    for (const d of new Set(this.#fds.values()))
      if (d.path === from || d.path.startsWith(`${from}/`)) d.path = to + d.path.slice(from.length);
  }
  #convert(path: string, m: Mount, stat: MountStat): FileStat {
    if (stat.kind === 'file' && stat.size === undefined) fail('EIO');
    const size = BigInt(integer(stat.size ?? 0));
    const time = BigInt(Math.trunc(stat.mtimeMs ?? 0)) * 1_000_000n;
    const writable =
      stat.kind === 'dir'
        ? Boolean(m.provider.mkdir || m.provider.create || m.provider.remove || m.provider.rename)
        : m.provider.write !== undefined;
    return {
      kind: stat.kind,
      dev: 2n,
      ino: this.#ino(path),
      nlink: 1n,
      uid: 0n,
      gid: 0n,
      rdev: 0n,
      mode:
        BigInt(
          (stat.mode ??
            (stat.kind === 'dir' ? (writable ? 0o755 : 0o555) : writable ? 0o644 : 0o444)) & 0o7777,
        ) |
        (stat.kind === 'dir'
          ? 0o040000n
          : stat.kind === 'symlink'
            ? 0o120000n
            : stat.kind === 'file'
              ? 0o100000n
              : 0n),
      size,
      blocks: (size + 511n) / 512n,
      blksize: 4096n,
      atimeNs: time,
      mtimeNs: time,
      ctimeNs: time,
      birthtimeNs: 0n,
    };
  }
  #statSync(path: string): FileStat {
    const m = this.#mount(path);
    if (m === undefined) return take(this.#memory.files.lstat(path));
    if (this.#virtual.has(path)) return this.#convert(path, m, { kind: 'dir' });
    const cached = m.provider.cache === false ? undefined : this.#stats.get(path);
    if (cached === undefined) fail('EAGAIN');
    return cached;
  }
  async #stat(path: string): Promise<FileStat> {
    const m = this.#mount(path);
    if (m === undefined || this.#virtual.has(path)) return this.#statSync(path);
    const cached = m.provider.cache === false ? undefined : this.#stats.get(path);
    if (cached !== undefined) return cached;
    const stat = this.#convert(path, m, take(await m.provider.stat(this.#relative(m, path))));
    if (m.provider.cache !== false) this.#stats.set(path, stat);
    return stat;
  }
  #linkSync(path: string): string {
    const m = this.#mount(path);
    if (m === undefined) return decode.decode(take(this.#memory.files.readLink(path)));
    const link = m.provider.cache === false ? undefined : this.#links.get(path);
    if (link === undefined) fail('EAGAIN');
    return link;
  }
  async #link(path: string): Promise<string> {
    const m = this.#mount(path);
    if (m === undefined) return this.#linkSync(path);
    const cached = m.provider.cache === false ? undefined : this.#links.get(path);
    if (cached !== undefined) return cached;
    if (!m.provider.readlink) fail('ENOSYS');
    const link = take(await m.provider.readlink(this.#relative(m, path)));
    if (m.provider.cache !== false) this.#links.set(path, link);
    return link;
  }
  *#walk(p: string, follow: boolean): Generator<Lookup, Located, FileStat | string> {
    if (p === '') fail('ENOENT');
    if (p.includes('\0')) fail('EINVAL');
    const parts = (p.startsWith('/') ? p : `${take(this.#memory.fs.cwd())}/${p}`)
      .split('/')
      .filter(Boolean);
    const stack: string[] = [];
    let stat = (yield { kind: 'stat', path: '/' }) as FileStat;
    let links = 0;
    while (parts.length) {
      if (stat.kind !== 'dir') fail('ENOTDIR');
      const part = parts.shift() as string;
      if (part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
      const path = `/${stack.join('/')}`;
      stat = (yield { kind: 'stat', path }) as FileStat;
      if (stat.kind === 'symlink' && (follow || parts.length > 0 || p.endsWith('/'))) {
        if (++links > 40) fail('ELOOP');
        const link = (yield { kind: 'link', path }) as string;
        stack.pop();
        if (link.startsWith('/')) stack.length = 0;
        parts.unshift(...link.split('/').filter(Boolean));
        stat = (yield { kind: 'stat', path: `/${stack.join('/')}` }) as FileStat;
      }
    }
    if (p.endsWith('/') && stat.kind !== 'dir') fail('ENOTDIR');
    return { path: `/${stack.join('/')}`, stat };
  }
  #resolveSync(p: string, follow = true): Located {
    const walk = this.#walk(p, follow);
    let step = walk.next();
    while (!step.done) {
      const r = step.value;
      step = walk.next(r.kind === 'stat' ? this.#statSync(r.path) : this.#linkSync(r.path));
    }
    return step.value;
  }
  async #resolve(p: string, follow = true): Promise<Located> {
    const walk = this.#walk(p, follow);
    let step = walk.next();
    while (!step.done) {
      const r = step.value;
      step = walk.next(r.kind === 'stat' ? await this.#stat(r.path) : await this.#link(r.path));
    }
    return step.value;
  }
  #leaf(p: string): { parent: string; name: string } {
    const parts = p.split('/');
    const name = parts.pop();
    if (!name || name === '.' || name === '..') fail('EBUSY');
    if (encode.encode(name).length > 255) fail('ENAMETOOLONG');
    return { parent: parts.join('/') || (p.startsWith('/') ? '/' : '.'), name };
  }
  #parentSync(p: string): string {
    const { parent, name } = this.#leaf(p);
    const dir = this.#resolveSync(parent);
    if (dir.stat.kind !== 'dir') fail('ENOTDIR');
    return `${dir.path === '/' ? '' : dir.path}/${name}`;
  }
  async #parent(p: string): Promise<string> {
    const { parent, name } = this.#leaf(p);
    const dir = await this.#resolve(parent);
    if (dir.stat.kind !== 'dir') fail('ENOTDIR');
    return `${dir.path === '/' ? '' : dir.path}/${name}`;
  }
  #merge(path: string, entries: readonly MountEntry[]): readonly MountEntry[] {
    const map = new Map(
      entries.map((e) => {
        if (!e.name || e.name === '.' || e.name === '..' || /[\0/]/.test(e.name)) fail('EIO');
        return [e.name, e] as const;
      }),
    );
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const p of this.#virtual) {
      if (p.startsWith(prefix) && p !== path && !p.slice(prefix.length).includes('/'))
        map.set(p.slice(prefix.length), { name: p.slice(prefix.length), kind: 'dir' });
    }
    return [...map.values()];
  }
  #listSync(path: string): readonly MountEntry[] {
    if (this.#statSync(path).kind !== 'dir') fail('ENOTDIR');
    const m = this.#mount(path);
    if (m === undefined)
      return this.#merge(
        path,
        take(this.#memory.files.readDir(path)).map((e) => ({
          name: decode.decode(e.name),
          kind: e.kind,
        })),
      );
    const list = m.provider.cache === false ? undefined : this.#dirs.get(path);
    if (list === undefined) fail('EAGAIN');
    return this.#merge(path, list);
  }
  async #list(path: string): Promise<readonly MountEntry[]> {
    if ((await this.#stat(path)).kind !== 'dir') fail('ENOTDIR');
    const m = this.#mount(path);
    if (m === undefined) return this.#listSync(path);
    let entries = m.provider.cache === false ? undefined : this.#dirs.get(path);
    if (entries === undefined) {
      const r = await m.provider.readdir(this.#relative(m, path));
      if (!r.ok && this.#virtual.has(path) && ['ENOENT', 'ENOTDIR'].includes(r.error.code))
        entries = [];
      else entries = take(r);
      if (m.provider.cache !== false) this.#dirs.set(path, entries);
    }
    return this.#merge(path, entries);
  }
  #descriptor(path: string, mount: Mount, stat: FileStat, flags: OpenFlags): HostFd {
    if (flags.directory && stat.kind !== 'dir') fail('ENOTDIR');
    if (stat.kind === 'dir' && flags.access !== 'read') fail('EISDIR');
    if (flags.noFollow && stat.kind === 'symlink') fail('ELOOP');
    // Reserve from the memory VFS's allocator: host fds can never collide across mounts.
    const fd = take(this.#memory.files.open('/', reading));
    this.#fds.set(fd, {
      path,
      mount,
      stat,
      flags,
      reader: undefined,
      offset: 0,
      refs: 1,
      tail: Promise.resolve(),
    });
    return fd;
  }
  async #open(p: string, flags: OpenFlags): Promise<HostFd> {
    let found: Located;
    let created = false;
    try {
      found = await this.#resolve(p, flags.noFollow !== true && !flags.exclusive);
      if (flags.exclusive) fail('EEXIST');
    } catch (e) {
      if (mountError(e).code !== 'ENOENT' || !flags.create) throw e;
      if (flags.directory || p.endsWith('/')) fail('ENOENT');
      const path = await this.#parent(p);
      const m = this.#mount(path);
      if (m === undefined) return this.#localOpen(path, flags);
      if (!m.provider.create) fail('EROFS');
      if (flags.access !== 'read' && !m.provider.write) fail('EROFS');
      take(await m.provider.create(this.#relative(m, path)));
      created = true;
      this.#invalidate(path);
      found = await this.#resolve(path);
    }
    const { path } = found;
    const m = this.#mount(path);
    if (m === undefined) return this.#localOpen(path, flags);
    if (flags.directory && found.stat.kind !== 'dir') fail('ENOTDIR');
    if (found.stat.kind === 'dir' && (flags.access !== 'read' || flags.truncate)) fail('EISDIR');
    if (flags.noFollow && found.stat.kind === 'symlink') fail('ELOOP');
    if (flags.access !== 'read' && !m.provider.write) fail('EROFS');
    if (flags.truncate && !created) {
      if (!m.provider.truncate) fail('EROFS');
      take(await m.provider.truncate(this.#relative(m, path), 0));
      this.#invalidate(path);
      found.stat = await this.#stat(path);
    }
    const fd = this.#descriptor(path, m, found.stat, flags);
    if (found.stat.kind === 'file') {
      try {
        (this.#fds.get(fd) as Description).reader = take(
          await m.provider.open(this.#relative(m, path)),
        );
      } catch (e) {
        this.files.close(fd);
        throw e;
      }
    }
    return fd;
  }
  #queue<T>(fd: HostFd, work: (d: Description) => Promise<T>): Promise<T> {
    const d = this.#fds.get(fd);
    if (!d) fail('EBADF');
    const pending = d.tail.then(() => work(d));
    d.tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  #canRead(d: Description): void {
    if (d.flags.access === 'write') fail('EBADF');
    if (d.stat.kind !== 'file') fail('EISDIR');
  }
  #cachedRead(path: string, offset: number, length: number, stat: FileStat): Uint8Array {
    const m = this.#mount(path);
    if (m?.provider.cache === false) fail('EAGAIN');
    const end = Math.min(Number(stat.size), offset + length);
    if (offset >= end) return new Uint8Array();
    const chunks = [...(this.#bytes.get(path) ?? [])].sort((a, b) => a[0] - b[0]);
    let pos = offset;
    const parts: Uint8Array[] = [];
    for (const [start, bytes] of chunks) {
      if (start > pos) break;
      if (start + bytes.length <= pos) continue;
      const part = bytes.subarray(pos - start, Math.min(bytes.length, end - start));
      parts.push(part);
      pos += part.length;
      if (pos === end) break;
    }
    if (pos !== end) fail('EAGAIN');
    const out = new Uint8Array(end - offset);
    pos = 0;
    for (const part of parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }
  async #read(d: Description, b: Uint8Array, position?: bigint): Promise<number> {
    this.#canRead(d);
    const offset = position === undefined ? d.offset : integer(Number(position));
    let data: Uint8Array | undefined;
    try {
      data = this.#cachedRead(d.path, offset, b.length, d.stat);
    } catch (e) {
      if (mountError(e).code !== 'EAGAIN') throw e;
    }
    if (data === undefined) {
      d.reader ??= take(await d.mount.provider.open(this.#relative(d.mount, d.path)));
      data = take(await d.reader.read(offset, b.length));
      if (data.length > b.length) fail('EIO');
      if (
        d.mount.provider.cache !== false &&
        data.length &&
        this.#cachedBytes + data.length <= CACHE_LIMIT
      ) {
        const chunks = this.#bytes.get(d.path) ?? new Map<number, Uint8Array>();
        this.#cachedBytes -= chunks.get(offset)?.length ?? 0;
        chunks.set(offset, data.slice());
        this.#bytes.set(d.path, chunks);
        this.#cachedBytes += data.length;
      }
    }
    b.set(data);
    if (position === undefined) d.offset += data.length;
    return data.length;
  }
  #write(d: Description, b: Uint8Array, position?: bigint): Promise<number> {
    const path = d.path;
    const pending = (this.#writes.get(path) ?? Promise.resolve()).then(() =>
      this.#writeNow(d, b, position),
    );
    const tail = pending.then(
      () => {},
      () => {},
    );
    this.#writes.set(path, tail);
    void tail.then(() => {
      if (this.#writes.get(path) === tail) this.#writes.delete(path);
    });
    return pending;
  }
  async #writeNow(d: Description, b: Uint8Array, position?: bigint): Promise<number> {
    if (d.flags.access === 'read') fail('EBADF');
    if (d.stat.kind !== 'file') fail('EISDIR');
    const provider = d.mount.provider;
    if (!provider.write) fail('EROFS');
    const offset = d.flags.append
      ? Number((await this.#stat(d.path)).size)
      : position === undefined
        ? d.offset
        : integer(Number(position));
    const n = take(await provider.write(this.#relative(d.mount, d.path), offset, b));
    if (!Number.isInteger(n) || n < 0 || n > b.length) fail('EIO');
    this.#invalidate(d.path);
    d.stat = await this.#stat(d.path);
    if (position === undefined) d.offset = offset + n;
    return n;
  }
  #access({ path, stat }: Located, mode: string): void {
    const provider = this.#mount(path)?.provider;
    if (mode === 'write' && provider !== undefined) {
      const writable =
        stat.kind === 'dir'
          ? Boolean(provider.create || provider.mkdir || provider.remove || provider.rename)
          : provider.write !== undefined;
      if (!writable) fail('EROFS');
    }
    const mask =
      mode === 'read' ? 0o444n : mode === 'write' ? 0o222n : mode === 'execute' ? 0o111n : 0n;
    if (mask && !(stat.mode & mask)) fail('EACCES');
  }
  #invalidate(path: string): void {
    for (const key of this.#stats.keys())
      if (key === path || key.startsWith(`${path}/`)) this.#stats.delete(key);
    for (const key of this.#links.keys())
      if (key === path || key.startsWith(`${path}/`)) this.#links.delete(key);
    this.#dirs.clear();
    for (const [key, chunks] of this.#bytes)
      if (key === path || key.startsWith(`${path}/`)) {
        for (const chunk of chunks.values()) this.#cachedBytes -= chunk.length;
        this.#bytes.delete(key);
      }
    for (const d of new Set(this.#fds.values()))
      if (d.path === path || d.path.startsWith(`${path}/`)) {
        d.reader?.close?.();
        d.reader = undefined;
      }
  }
  #mutate(
    p: string,
    op: 'mkdir',
    base: (path: string) => Promise<Result<void, HostError>>,
  ): Promise<Result<void, HostError>> {
    return mounted(async () => {
      const path = await this.#parent(p);
      const m = this.#mount(path);
      if (!m) return take(await base(path));
      if (this.#virtual.has(path)) fail('EBUSY');
      const method = m.provider[op];
      if (!method) fail('EROFS');
      take(await method.call(m.provider, this.#relative(m, path)));
      this.#invalidate(path);
    });
  }
  #remove(p: string, directory: boolean): Promise<Result<void, HostError>> {
    return mounted(async () => {
      const { path, stat } = await this.#resolve(p, false);
      const m = this.#mount(path);
      if (!m)
        return take(
          await (directory
            ? this.#memory.files.async.rmdir(path)
            : this.#memory.files.async.unlink(path)),
        );
      if (this.#virtual.has(path)) fail('EBUSY');
      if (!m.provider.remove) fail('EROFS');
      if (directory && stat.kind !== 'dir') fail('ENOTDIR');
      if (!directory && stat.kind === 'dir') fail('EISDIR');
      take(await m.provider.remove(this.#relative(m, path)));
      this.#invalidate(path);
    });
  }
  async #rename(from: string, to: string): Promise<void> {
    const a = (await this.#resolve(from, false)).path;
    const b = await this.#parent(to);
    const m = this.#mount(a);
    if (this.#virtual.has(a) || this.#virtual.has(b)) fail('EBUSY');
    if (m !== this.#mount(b)) fail('EXDEV');
    if (!m) {
      take(await this.#memory.files.async.rename(a, b));
      this.#movePaths(a, b);
      return;
    }
    if (!m.provider.rename) fail('EROFS');
    take(await m.provider.rename(this.#relative(m, a), this.#relative(m, b)));
    this.#invalidate(a);
    this.#invalidate(b);
    this.#movePaths(a, b);
  }
}
