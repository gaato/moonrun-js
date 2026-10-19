import type { AsyncFilePort, FilePort, FileWatch, HostFd } from '../ports/files.ts';
import { err, ok, type Result } from '../ports/result.ts';
import { type AsyncError, INVAL, native } from './errors.ts';
import { inodeKey } from './file.ts';
import { IN_CREATE, IN_IGNORED, IN_MODIFY, inotifyEvent } from './fs-codec.ts';
import { EPOLLIN, type Pollable, type ReadinessListener, WaitQueue } from './readiness.ts';

interface Watch {
  readonly wd: number;
  readonly key: string;
  readonly fd: HostFd;
  isDir: boolean;
  watch: FileWatch;
  /** Last seen `mtime`, telling `IN_MODIFY` apart from `IN_ATTRIB` (both are `change`). */
  mtimeNs: bigint;
}

/**
 * An inotify instance emulated over the host's path watches (Node `fs.watch`, itself
 * inotify on Linux). Directory watches report entry changes (`IN_CREATE` and friends),
 * file watches report `IN_MODIFY`, and `IN_IGNORED` follows an explicit removal; the
 * guest only distinguishes "relevant", overflow and ignore (divergence D17).
 */
export class Inotify implements Pollable {
  readonly #files: FilePort;
  readonly #async: AsyncFilePort;
  readonly #queue: Uint8Array[] = [];
  readonly #waiters = new WaitQueue();
  readonly #watches = new Map<number, Watch>();
  readonly #byInode = new Map<string, number>();
  #nextWd = 1;
  #closed = false;

  constructor(files: FilePort) {
    this.#files = files;
    this.#async = files.async;
  }

  poll(): number {
    return this.#queue.length > 0 ? EPOLLIN : 0;
  }

  watch(listener: ReadinessListener): () => void {
    return this.#waiters.watch(listener);
  }

  /** `inotify_add_watch` with the guest's masks: entry changes for directories, `IN_MODIFY` for files. */
  addWatch(path: string, isDir: boolean): Result<number, AsyncError> {
    if (this.#closed) {
      return err(native('EBADF'));
    }
    if (path.includes('\0')) {
      return err(INVAL);
    }
    // An identity descriptor keeps the inode (and so the watch's identity) alive.
    const opened = this.#async.openPath(path);
    if (!opened.ok) {
      return err(native(opened.error.code));
    }
    const fd = opened.value;
    const stat = this.#files.fstat(fd);
    if (!stat.ok) {
      this.#files.close(fd);
      return err(native(stat.error.code));
    }
    const key = inodeKey(stat.value);
    const existing = this.#byInode.get(key);
    const reused = existing === undefined ? undefined : this.#watches.get(existing);
    const wd = reused?.wd ?? this.#nextWd++;
    const watch = this.#async.watch(path, (event) => this.#onEvent(wd, event));
    if (!watch.ok) {
      this.#files.close(fd);
      return err(native(watch.error.code));
    }
    if (reused !== undefined) {
      // Same inode: inotify replaces the mask of the existing watch.
      reused.watch.close();
      this.#files.close(fd);
      reused.watch = watch.value;
      reused.isDir = isDir;
      reused.mtimeNs = stat.value.mtimeNs;
      return ok(wd);
    }
    this.#watches.set(wd, {
      wd,
      key,
      fd,
      isDir,
      watch: watch.value,
      mtimeNs: stat.value.mtimeNs,
    });
    this.#byInode.set(key, wd);
    return ok(wd);
  }

  /** `inotify_rm_watch`: queues `IN_IGNORED`. */
  removeWatch(wd: number): Result<void, AsyncError> {
    const watch = this.#watches.get(wd);
    if (watch === undefined) {
      return err(native('EINVAL'));
    }
    this.#drop(watch);
    this.#push(wd, IN_IGNORED);
    return ok(undefined);
  }

  /** A nonblocking `read(2)`: whole events that fit, 0 when none are queued. */
  fetch(buffer: Uint8Array): Result<number, AsyncError> {
    let offset = 0;
    for (;;) {
      const event = this.#queue[0];
      if (event === undefined || offset + event.length > buffer.length) {
        break;
      }
      buffer.set(event, offset);
      offset += event.length;
      this.#queue.shift();
    }
    if (offset === 0 && this.#queue.length > 0) {
      return err(INVAL);
    }
    return ok(offset);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const watch of [...this.#watches.values()]) {
      this.#drop(watch);
    }
    this.#queue.length = 0;
  }

  #drop(watch: Watch): void {
    watch.watch.close();
    this.#files.close(watch.fd);
    this.#watches.delete(watch.wd);
    if (this.#byInode.get(watch.key) === watch.wd) {
      this.#byInode.delete(watch.key);
    }
  }

  #onEvent(wd: number, event: 'change' | 'rename'): void {
    const watch = this.#watches.get(wd);
    if (watch === undefined || this.#closed) {
      return;
    }
    if (watch.isDir) {
      // `rename` also stands for events on the directory itself (IN_MOVE_SELF,
      // IN_DELETE_SELF), which carry its own base name and so cannot be told from an
      // entry of that name. Reporting them only makes the guest rescan the directory,
      // which it does for a vanished directory anyway.
      if (event === 'rename') {
        this.#push(wd, IN_CREATE);
      }
      return;
    }
    if (event !== 'change') {
      return;
    }
    // `change` also stands for IN_ATTRIB (e.g. a link-count change when the file is
    // unlinked or replaced); only a write moves mtime.
    const stat = this.#files.fstat(watch.fd);
    if (stat.ok && stat.value.mtimeNs === watch.mtimeNs) {
      return;
    }
    if (stat.ok) {
      watch.mtimeNs = stat.value.mtimeNs;
    }
    this.#push(wd, IN_MODIFY);
  }

  #push(wd: number, mask: number): void {
    this.#queue.push(inotifyEvent(wd, mask));
    this.#waiters.wake(EPOLLIN);
  }
}
