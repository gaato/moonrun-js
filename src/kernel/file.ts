import type { DirectoryReader, DirectoryRecord, FileStat, HostFd } from '../ports/files.ts';

/** File types as `fstat` reports them (moonrun `kind_of_fd`). */
export type FdKind =
  | 'unknown'
  | 'regular'
  | 'directory'
  | 'symlink'
  | 'socket'
  | 'pipe'
  | 'block-device'
  | 'char-device';

/** `st_mode & S_IFMT` → file type. */
export function fdKindOfMode(mode: bigint): FdKind {
  switch (Number(mode & 0o170000n)) {
    case 0o100000:
      return 'regular';
    case 0o040000:
      return 'directory';
    case 0o120000:
      return 'symlink';
    case 0o140000:
      return 'socket';
    case 0o010000:
      return 'pipe';
    case 0o060000:
      return 'block-device';
    case 0o020000:
      return 'char-device';
    default:
      return 'unknown';
  }
}

/** async's `FileKind` numbering (moonrun `FILE_KIND_*`). */
export function fileKindCode(kind: FdKind): number {
  switch (kind) {
    case 'unknown':
      return 0;
    case 'regular':
      return 1;
    case 'directory':
      return 2;
    case 'symlink':
      return 3;
    case 'socket':
      return 4;
    case 'pipe':
      return 5;
    case 'block-device':
      return 6;
    case 'char-device':
      return 7;
  }
}

/** The readdir cursor of an open directory (moonrun keeps it in the kernel's file offset). */
export interface DirectoryCursor {
  reader: DirectoryReader | undefined;
  /** `.` and `..` still to be returned (getdents reports them; `opendir` does not). */
  specials: DirectoryRecord[] | undefined;
  /** An entry read from the stream that did not fit the previous buffer. */
  pending: DirectoryRecord | undefined;
  eof: boolean;
}

/**
 * A host file descriptor behind a file Resource (moonrun `ResourcePayload::File`).
 * In-flight Jobs hold it like an `Arc`: closing the handle drops the guest's hold,
 * and the descriptor closes when the last holder lets go.
 */
export class HostFile {
  readonly fd: HostFd;
  /**
   * The path the file was opened with. Host Filesystem authorization (policy)
   * derives the canonical path from it.
   */
  readonly path: string;
  /**
   * `realpath(path)` taken right after the open, best effort (moonrun's open Job keeps
   * `std::fs::canonicalize(filename).ok()` with the Resource). Host Filesystem
   * authorization of fd-based Jobs reads it; `undefined` when it failed.
   */
  canonicalPath: string | undefined;
  /** Cached `dev:ino` lock identity. */
  lockKey: string | undefined;
  directory: DirectoryCursor | undefined;
  /** Serializes directory-cursor Jobs (moonrun `lock_directory_cursor`). */
  cursorQueue: Promise<void> = Promise.resolve();
  #holds = 1;
  readonly #onClose: (file: HostFile) => void;

  constructor(fd: HostFd, path: string, onClose: (file: HostFile) => void) {
    this.fd = fd;
    this.path = path;
    this.#onClose = onClose;
  }

  retain(): void {
    this.#holds++;
  }

  release(): void {
    this.#holds--;
    if (this.#holds === 0) {
      this.directory?.reader?.close();
      this.directory = undefined;
      this.#onClose(this);
    }
  }

  get closed(): boolean {
    return this.#holds <= 0;
  }
}

type LockMode = 'shared' | 'exclusive';

interface Waiter {
  readonly owner: object;
  readonly exclusive: boolean;
  readonly granted: () => void;
}

interface InodeLocks {
  readonly holders: Map<object, LockMode>;
  readonly waiters: Waiter[];
}

/**
 * `flock(2)` advisory locks of one Run, keyed by inode and owned per open file
 * (Linux attaches them to the open file description). They are not visible to
 * other processes or Runs (divergence D16).
 */
export class FileLocks {
  readonly #inodes = new Map<string, InodeLocks>();

  #entry(key: string): InodeLocks {
    let entry = this.#inodes.get(key);
    if (entry === undefined) {
      entry = { holders: new Map(), waiters: [] };
      this.#inodes.set(key, entry);
    }
    return entry;
  }

  static #conflicts(entry: InodeLocks, owner: object, exclusive: boolean): boolean {
    for (const [holder, mode] of entry.holders) {
      if (holder !== owner && (exclusive || mode === 'exclusive')) {
        return true;
      }
    }
    return false;
  }

  /**
   * `LOCK_NB` lock. As in Linux, converting an existing lock drops it first, so a
   * failed conversion leaves the owner unlocked.
   */
  tryLock(key: string, owner: object, exclusive: boolean): boolean {
    const entry = this.#entry(key);
    this.#drop(entry, owner);
    if (FileLocks.#conflicts(entry, owner, exclusive)) {
      this.#gc(key, entry);
      return false;
    }
    entry.holders.set(owner, exclusive ? 'exclusive' : 'shared');
    return true;
  }

  /** A blocking lock: `granted` runs once it is held; the result cancels the wait. */
  lock(key: string, owner: object, exclusive: boolean, granted: () => void): () => void {
    if (this.tryLock(key, owner, exclusive)) {
      granted();
      return () => undefined;
    }
    const entry = this.#entry(key);
    const waiter: Waiter = { owner, exclusive, granted };
    entry.waiters.push(waiter);
    return () => {
      const at = entry.waiters.indexOf(waiter);
      if (at >= 0) {
        entry.waiters.splice(at, 1);
        this.#gc(key, entry);
      }
    };
  }

  unlock(key: string, owner: object): void {
    const entry = this.#inodes.get(key);
    if (entry !== undefined) {
      this.#drop(entry, owner);
      this.#gc(key, entry);
    }
  }

  /** The owner's descriptor closed: its locks and waits end. */
  releaseOwner(owner: object): void {
    for (const [key, entry] of [...this.#inodes]) {
      for (let i = entry.waiters.length - 1; i >= 0; i--) {
        if (entry.waiters[i]?.owner === owner) {
          entry.waiters.splice(i, 1);
        }
      }
      this.#drop(entry, owner);
      this.#gc(key, entry);
    }
  }

  #drop(entry: InodeLocks, owner: object): void {
    if (!entry.holders.delete(owner)) {
      return;
    }
    // Wake waiters in arrival order while they fit.
    for (let i = 0; i < entry.waiters.length; ) {
      const waiter = entry.waiters[i];
      if (waiter !== undefined && !FileLocks.#conflicts(entry, waiter.owner, waiter.exclusive)) {
        entry.waiters.splice(i, 1);
        entry.holders.set(waiter.owner, waiter.exclusive ? 'exclusive' : 'shared');
        waiter.granted();
      } else {
        i++;
      }
    }
  }

  #gc(key: string, entry: InodeLocks): void {
    if (entry.holders.size === 0 && entry.waiters.length === 0) {
      this.#inodes.delete(key);
    }
  }
}

/** The inode identity used for locks and watches. */
export function inodeKey(stat: FileStat): string {
  return `${stat.dev}:${stat.ino}`;
}

// ----- generic stat (moonbitlang/async PR 527, moonrun ADR 0011) -----

export const STAT_FILE_KIND = 0x01;
export const STAT_FILE_SIZE = 0x02;
export const STAT_DEVICE_ID = 0x04;
export const STAT_FILE_ID = 0x08;
export const STAT_ACCESS_TIME = 0x10;
export const STAT_MODIFY_TIME = 0x20;
export const STAT_CHANGE_TIME = 0x40;
export const STAT_CREATE_TIME = 0x80;
export const STAT_OPEN_IDENTITY = STAT_FILE_KIND | STAT_DEVICE_ID | STAT_FILE_ID;

export interface Timestamp {
  readonly seconds: bigint;
  readonly nanoseconds: bigint;
}

/** Typed metadata of a stat Job; `undefined` means "not available" (moonrun `StatValues`). */
export interface StatValues {
  readonly kind?: FdKind;
  readonly size?: bigint;
  readonly deviceId?: bigint;
  readonly fileId?: bigint;
  readonly accessTime?: Timestamp;
  readonly modifyTime?: Timestamp;
  readonly changeTime?: Timestamp;
  readonly createTime?: Timestamp;
}

export function timestampOfNs(ns: bigint): Timestamp {
  const second = 1_000_000_000n;
  let seconds = ns / second;
  let nanoseconds = ns % second;
  if (nanoseconds < 0n) {
    seconds -= 1n;
    nanoseconds += second;
  }
  return { seconds, nanoseconds };
}

/** The requested properties of a stat (Linux `statx` reports all of them but birth time when the filesystem lacks it). */
export function statValues(stat: FileStat, mask: number): StatValues {
  const values: {
    -readonly [K in keyof StatValues]: StatValues[K];
  } = {};
  if (mask & STAT_FILE_KIND) values.kind = fdKindOfMode(stat.mode);
  if (mask & STAT_FILE_SIZE) values.size = BigInt.asIntN(64, stat.size);
  if (mask & STAT_DEVICE_ID) values.deviceId = stat.dev;
  if (mask & STAT_FILE_ID) values.fileId = stat.ino;
  if (mask & STAT_ACCESS_TIME) values.accessTime = timestampOfNs(stat.atimeNs);
  if (mask & STAT_MODIFY_TIME) values.modifyTime = timestampOfNs(stat.mtimeNs);
  if (mask & STAT_CHANGE_TIME) values.changeTime = timestampOfNs(stat.ctimeNs);
  if (mask & STAT_CREATE_TIME && stat.birthtimeNs !== 0n) {
    values.createTime = timestampOfNs(stat.birthtimeNs);
  }
  return values;
}

/** The three timestamps of the compat FileTime record. */
export interface FileTimes {
  readonly access: Timestamp;
  readonly modify: Timestamp;
  readonly change: Timestamp;
}

export function fileTimes(stat: FileStat): FileTimes {
  return {
    access: timestampOfNs(stat.atimeNs),
    modify: timestampOfNs(stat.mtimeNs),
    change: timestampOfNs(stat.ctimeNs),
  };
}
