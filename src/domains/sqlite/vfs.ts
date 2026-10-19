// The `host.*` imports of sqlite-engine.wasm (crates/sqlite-engine/engine.c): one host
// call per syscall of SQLite's unix VFS, over the FilePort. The C side keeps os_unix.c's
// logic; this side only performs the calls, owns the descriptors and the lock table, and
// reports failures as negated Linux errnos.
import type { ClockPort } from '../../ports/clock.ts';
import type { EnvPort } from '../../ports/env.ts';
import type { AccessMode, FilePort, HostFd } from '../../ports/files.ts';
import type { FsPort } from '../../ports/fs.ts';
import type { RandomPort } from '../../ports/random.ts';
import type { HostError, Result } from '../../ports/result.ts';
import { type FileLock, type LockLevel, LockTable } from './locks.ts';

export interface VfsDeps {
  readonly files: FilePort;
  readonly fs: FsPort;
  readonly env: EnvPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
}

/** Linux errnos the C side tells apart; any other failure is `EIO`. */
const ERRNO: Readonly<Partial<Record<HostError['code'], number>>> = {
  ENOENT: 2,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  EACCES: 13,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  ENOSPC: 28,
  ELOOP: 40,
};

const fail = (error: HostError): number => -(ERRNO[error.code] ?? 5);

const OPEN_READWRITE = 1;
const OPEN_CREATE = 2;
const OPEN_EXCLUSIVE = 4;

/** `access(2)` bits as engine.c passes them. */
const ACCESS_BITS: ReadonlyArray<readonly [number, AccessMode]> = [
  [4, 'read'],
  [2, 'write'],
  [1, 'execute'],
];

interface OpenFile {
  readonly fd: HostFd;
  /** Created on the first lock call: only main database files take locks. */
  lock: FileLock | undefined;
}

/** The descriptors and locks of one engine instance, plus its host imports. */
export class Vfs {
  readonly #deps: VfsDeps;
  readonly #memory: () => ArrayBuffer;
  readonly #files = new Map<number, OpenFile>();
  readonly #locks = new LockTable();
  #nextFd = 3;
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();

  constructor(deps: VfsDeps, memory: () => ArrayBuffer) {
    this.#deps = deps;
    this.#memory = memory;
  }

  get openFiles(): number {
    return this.#files.size;
  }

  /** Closes every descriptor still open (Run teardown). */
  closeAll(): void {
    for (const [id, file] of this.#files) {
      file.lock?.close();
      this.#deps.files.close(file.fd);
      this.#files.delete(id);
    }
  }

  #bytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.#memory(), ptr, len);
  }

  #cstring(ptr: number): string {
    const memory = new Uint8Array(this.#memory());
    let end = ptr;
    while (memory[end] !== 0 && end < memory.length) {
      end++;
    }
    return this.#decoder.decode(memory.subarray(ptr, end));
  }

  /** Writes `text` (no NUL) to `ptr` when it fits in `capacity`; returns its length. */
  #put(text: string | Uint8Array, ptr: number, capacity: number): number {
    const bytes = typeof text === 'string' ? this.#encoder.encode(text) : text;
    if (bytes.length > capacity) {
      return -36; // ENAMETOOLONG
    }
    this.#bytes(ptr, bytes.length).set(bytes);
    return bytes.length;
  }

  #file(id: number): OpenFile | undefined {
    return this.#files.get(id);
  }

  #lockOf(file: OpenFile): FileLock | undefined {
    if (file.lock === undefined) {
      const stat = this.#deps.files.fstat(file.fd);
      if (!stat.ok) {
        return undefined;
      }
      file.lock = this.#locks.open(`${stat.value.dev}:${stat.value.ino}`);
    }
    return file.lock;
  }

  /** The `host` import module. */
  imports(extra: {
    authorize(action: number, a1: number, a2: number, db: number, trigger: number): number;
    progress(): number | Promise<number>;
  }): Record<string, unknown> {
    const { files, fs, env, clock, random } = this.#deps;
    const status = (r: Result<unknown, HostError>): number => (r.ok ? 0 : fail(r.error));
    return {
      open: (path: number, flags: number, mode: number): number => {
        const opened = files.open(this.#cstring(path), {
          access: flags & OPEN_READWRITE ? 'readWrite' : 'read',
          append: false,
          create: (flags & OPEN_CREATE) !== 0,
          exclusive: (flags & OPEN_EXCLUSIVE) !== 0,
          truncate: false,
          noFollow: true,
          mode,
        });
        if (!opened.ok) {
          return fail(opened.error);
        }
        const id = this.#nextFd++;
        this.#files.set(id, { fd: opened.value, lock: undefined });
        return id;
      },
      close: (id: number): number => {
        const file = this.#file(id);
        if (file === undefined) {
          return -9;
        }
        this.#files.delete(id);
        file.lock?.close();
        return status(files.close(file.fd));
      },
      pread: (id: number, buf: number, n: number, offset: bigint): number => {
        const file = this.#file(id);
        if (file === undefined) {
          return -9;
        }
        const r = files.read(file.fd, this.#bytes(buf, n), offset);
        return r.ok ? r.value : fail(r.error);
      },
      pwrite: (id: number, buf: number, n: number, offset: bigint): number => {
        const file = this.#file(id);
        if (file === undefined) {
          return -9;
        }
        const r = files.write(file.fd, this.#bytes(buf, n), offset);
        return r.ok ? r.value : fail(r.error);
      },
      ftruncate: (id: number, size: bigint): number => {
        const file = this.#file(id);
        return file === undefined ? -9 : status(files.truncate(file.fd, size));
      },
      fsync: (id: number): number => {
        const file = this.#file(id);
        return file === undefined ? -9 : status(files.fsync(file.fd));
      },
      fsize: (id: number): bigint => {
        const file = this.#file(id);
        if (file === undefined) {
          return -9n;
        }
        const r = files.fstat(file.fd);
        return r.ok ? r.value.size : BigInt(fail(r.error));
      },
      stat: (path: number, size: number): number => {
        const r = files.stat(this.#cstring(path));
        if (!r.ok) {
          return fail(r.error);
        }
        new DataView(this.#memory()).setBigInt64(size, r.value.size, true);
        return r.value.kind === 'file' ? 1 : r.value.kind === 'dir' ? 2 : 3;
      },
      file_mode: (path: number): number => {
        const r = files.stat(this.#cstring(path));
        return r.ok ? Number(r.value.mode & 0o777n) : fail(r.error);
      },
      lstat_is_link: (path: number): number => {
        const r = files.lstat(this.#cstring(path));
        return r.ok ? (r.value.kind === 'symlink' ? 1 : 0) : fail(r.error);
      },
      readlink: (path: number, buf: number, n: number): number => {
        const r = files.readLink(this.#cstring(path));
        return r.ok ? this.#put(r.value, buf, n) : fail(r.error);
      },
      access: (path: number, mode: number): number => {
        const target = this.#cstring(path);
        const modes = ACCESS_BITS.filter(([bit]) => (mode & bit) !== 0).map(([, m]) => m);
        for (const m of modes.length === 0 ? (['exists'] as const) : modes) {
          const r = files.access(target, m);
          if (!r.ok) {
            return fail(r.error);
          }
        }
        return 0;
      },
      unlink: (path: number): number => status(files.unlink(this.#cstring(path))),
      getcwd: (buf: number, n: number): number => {
        const cwd = fs.cwd();
        return cwd.ok ? this.#put(cwd.value, buf, n) : fail(cwd.error);
      },
      getenv: (name: number, buf: number, n: number): number => {
        const value = env.get(this.#cstring(name));
        return value === undefined ? -1 : this.#put(value, buf, n);
      },
      lock: (id: number, level: number): number => {
        const file = this.#file(id);
        const lock = file === undefined ? undefined : this.#lockOf(file);
        return lock === undefined ? 10 /* SQLITE_IOERR */ : lock.lock(level as LockLevel);
      },
      unlock: (id: number, level: number): number => {
        const file = this.#file(id);
        return file?.lock === undefined ? 0 : file.lock.unlock(level as LockLevel);
      },
      check_reserved: (id: number): number => {
        const file = this.#file(id);
        const lock = file === undefined ? undefined : this.#lockOf(file);
        return lock?.reserved() === true ? 1 : 0;
      },
      random: (buf: number, n: number): void => {
        random.fill(this.#bytes(buf, n));
      },
      now_ms: (): bigint => BigInt(Math.floor(clock.nowMs())),
      utc_offset: (seconds: bigint): number =>
        -new Date(Number(seconds) * 1000).getTimezoneOffset() * 60,
      sleep_us: (us: number): void => {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, us / 1000);
        } catch {
          // A host whose main thread cannot block (browsers) does not sleep.
        }
      },
      authorize: extra.authorize,
      progress: new WebAssembly.Suspending(extra.progress),
    };
  }
}
