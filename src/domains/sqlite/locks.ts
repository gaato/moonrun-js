// SQLite's file locks between the connections of one Run: the in-process half of
// os_unix.c's POSIX advisory locking (`unixLock`, `posixUnlock`, `unixCheckReservedLock`
// over `unixInodeInfo`), keyed by the file's device and inode. Within one process the
// fcntl() locks unix takes never conflict, so this bookkeeping alone decides; other
// processes and other Runs do not see these locks (docs/divergences.md D29).

export const NO_LOCK = 0;
export const SHARED_LOCK = 1;
export const RESERVED_LOCK = 2;
export const PENDING_LOCK = 3;
export const EXCLUSIVE_LOCK = 4;

export type LockLevel = 0 | 1 | 2 | 3 | 4;

const SQLITE_OK = 0;
const SQLITE_BUSY = 5;

/** `unixInodeInfo`: the strongest lock of any connection, and how many hold one. */
interface Inode {
  level: LockLevel;
  shared: number;
  locks: number;
}

/** One open file's view (`unixFile.eFileLock`). */
export class FileLock {
  level: LockLevel = NO_LOCK;
  readonly #inode: Inode;
  readonly #release: () => void;

  constructor(inode: Inode, release: () => void) {
    this.#inode = inode;
    this.#release = release;
  }

  /** `unixLock`: `SQLITE_OK` or `SQLITE_BUSY`. */
  lock(level: LockLevel): number {
    if (this.level >= level) {
      return SQLITE_OK;
    }
    const inode = this.#inode;
    if (this.level !== inode.level && (inode.level >= PENDING_LOCK || level > SHARED_LOCK)) {
      return SQLITE_BUSY;
    }
    if (level === SHARED_LOCK && (inode.level === SHARED_LOCK || inode.level === RESERVED_LOCK)) {
      this.level = SHARED_LOCK;
      inode.shared++;
      inode.locks++;
      return SQLITE_OK;
    }
    // The PENDING byte is taken first; between connections of one process it always succeeds.
    if (level === EXCLUSIVE_LOCK && this.level === RESERVED_LOCK) {
      this.level = PENDING_LOCK;
      inode.level = PENDING_LOCK;
    }
    if (level === SHARED_LOCK) {
      this.level = SHARED_LOCK;
      inode.locks++;
      inode.shared = 1;
    } else if (level === EXCLUSIVE_LOCK && inode.shared > 1) {
      return SQLITE_BUSY;
    }
    this.level = level;
    inode.level = level;
    return SQLITE_OK;
  }

  /** `posixUnlock` to `SHARED_LOCK` or `NO_LOCK`. */
  unlock(level: LockLevel): number {
    if (this.level <= level) {
      return SQLITE_OK;
    }
    const inode = this.#inode;
    if (this.level > SHARED_LOCK) {
      inode.level = SHARED_LOCK;
    }
    if (level === NO_LOCK) {
      inode.shared--;
      if (inode.shared === 0) {
        inode.level = NO_LOCK;
      }
      inode.locks--;
    }
    this.level = level;
    return SQLITE_OK;
  }

  /** `unixCheckReservedLock`: whether some connection holds RESERVED or more. */
  reserved(): boolean {
    return this.#inode.level > SHARED_LOCK;
  }

  /** The file is closed (`unixClose` unlocks first). */
  close(): void {
    this.unlock(NO_LOCK);
    this.#release();
  }
}

/** The inodes of one Run's open database files. */
export class LockTable {
  readonly #inodes = new Map<string, { inode: Inode; files: number }>();

  /** A lock handle for one open file of inode `key` (`dev:ino`). */
  open(key: string): FileLock {
    let entry = this.#inodes.get(key);
    if (entry === undefined) {
      entry = { inode: { level: NO_LOCK, shared: 0, locks: 0 }, files: 0 };
      this.#inodes.set(key, entry);
    }
    entry.files++;
    const found = entry;
    return new FileLock(found.inode, () => {
      found.files--;
      if (found.files === 0 && this.#inodes.get(key) === found) {
        this.#inodes.delete(key);
      }
    });
  }

  get size(): number {
    return this.#inodes.size;
  }
}
