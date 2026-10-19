import { err, ok, type Result } from '../ports/result.ts';
import type { CompletionSource } from './completion.ts';
import type { AsyncError } from './errors.ts';
import { BADF, INVAL } from './errors.ts';
import type { HostFile } from './file.ts';
import { canonical, type Handle, type HostKeys } from './handles.ts';
import type { Inotify } from './inotify.ts';
import type { PipeEnd } from './pipe.ts';
import type { Child } from './process.ts';
import type { Pollable } from './readiness.ts';
import type { Socket } from './socket.ts';

/** A standard stream of the embedding process. */
export type StdioStream = 0 | 1 | 2;

/**
 * A moonrun-owned object that a Resource Handle can name. The variant is the
 * Resource Class (moonrun derives the class from the payload, too).
 */
export type Resource =
  /** The reserved `invalid_fd()` entry: live key, rejected by every lookup. */
  | { readonly kind: 'invalid' }
  /** A reserved stdio handle; usable by the guest, never owned or closed by it. */
  | { readonly kind: 'stdio'; readonly stream: StdioStream }
  /** `asyncWriter`: the async write end of `fd_util/pipe`, the only end a Worker may notify through. */
  | { readonly kind: 'pipe'; readonly end: PipeEnd; readonly asyncWriter: boolean }
  /** The guest's reading view of the thread pool's Completion Source. */
  | { readonly kind: 'completion-source'; readonly source: CompletionSource }
  /** A host file descriptor opened by an open Job (files, directories, devices, FIFOs). */
  | { readonly kind: 'file'; readonly file: HostFile }
  /** `fs/inotify/create`. */
  | { readonly kind: 'inotify'; readonly inotify: Inotify }
  /** A TCP or UDP socket (`make_tcp_socket`, `make_udp_socket`, `accept`). */
  | { readonly kind: 'socket'; readonly socket: Socket }
  /** A pidfd of a child (`spawn_job_get_result_handle`, `open_pid_handle`). */
  | { readonly kind: 'process'; readonly child: Child };

/** The poll target of a resource, or `undefined` when epoll would refuse it (`EPERM`). */
export function pollableOf(resource: Resource): Pollable | undefined {
  switch (resource.kind) {
    case 'pipe':
      return resource.end;
    case 'completion-source':
      return resource.source;
    case 'inotify':
      return resource.inotify;
    case 'socket':
      return resource.socket;
    case 'process':
      return resource.child;
    case 'invalid':
    case 'stdio':
    // Opened files take the thread pool (regular files and directories cannot be
    // polled; FIFOs and terminals opened by path diverge, D14).
    case 'file':
      // Stdio goes through the thread pool (`is_async: false`); the embedding process
      // owns its blocking mode, so moonrun-js never polls it.
      return undefined;
  }
}

/** Releases what a resource holds once its last holder lets go. */
function releaseResource(resource: Resource): void {
  switch (resource.kind) {
    case 'pipe':
      resource.end.release();
      return;
    case 'file':
      resource.file.release();
      return;
    case 'inotify':
      resource.inotify.close();
      return;
    case 'socket':
      resource.socket.release();
      return;
    case 'invalid':
    case 'stdio':
    case 'completion-source':
    case 'process':
      return;
  }
}

/** Takes another hold on the resource for an in-flight Job (an Acquired Resource). */
export function acquire(resource: Resource): Resource {
  if (resource.kind === 'pipe') {
    resource.end.retain();
  } else if (resource.kind === 'file') {
    resource.file.retain();
  } else if (resource.kind === 'socket') {
    resource.socket.retain();
  }
  return resource;
}

/** Ends an in-flight Job's hold on a resource. */
export function relinquish(resource: Resource): void {
  // An inotify instance is not reference counted: the guest's close ends it.
  if (resource.kind !== 'inotify') {
    releaseResource(resource);
  }
}

/**
 * The Resource family of the handle namespace (moonrun `HandleTable`): the
 * reserved invalid handle and the three stdio handles are allocated first, so
 * they are always `0x1_0000_0001` … `0x1_0000_0004`.
 */
export class ResourceTable {
  readonly #keys: HostKeys;
  readonly #entries = new Map<Handle, Resource>();
  readonly invalidHandle: Handle;
  readonly #stdio: readonly [Handle, Handle, Handle];

  constructor(keys: HostKeys) {
    this.#keys = keys;
    this.invalidHandle = this.#insert({ kind: 'invalid' });
    this.#stdio = [
      this.#insert({ kind: 'stdio', stream: 0 }),
      this.#insert({ kind: 'stdio', stream: 1 }),
      this.#insert({ kind: 'stdio', stream: 2 }),
    ];
  }

  stdioHandle(stream: StdioStream): Handle {
    return this.#stdio[stream];
  }

  insert(resource: Resource): Handle {
    return this.#insert(resource);
  }

  /** A live, valid resource (`Badf` for null, stale, foreign-kind and the invalid handle). */
  get(handle: Handle): Result<Resource, AsyncError> {
    const key = canonical(handle);
    if (this.#keys.kindOfKey(key) !== 'resource') {
      return err(BADF);
    }
    const resource = this.#entries.get(key);
    if (resource === undefined || resource.kind === 'invalid') {
      return err(BADF);
    }
    return ok(resource);
  }

  /** Like {@link get} but requires a pipe end of a pipe resource. */
  pipe(handle: Handle): Result<PipeEnd, AsyncError> {
    const resource = this.get(handle);
    if (!resource.ok) {
      return resource;
    }
    return resource.value.kind === 'pipe' ? ok(resource.value.end) : err(INVAL);
  }

  /** Closes a guest-owned resource handle; reserved handles cannot be closed. */
  remove(handle: Handle): Result<Resource, AsyncError> {
    const resource = this.get(handle);
    if (!resource.ok) {
      return resource;
    }
    const key = canonical(handle);
    if (key === this.invalidHandle || this.#stdio.includes(key)) {
      return err(BADF);
    }
    this.#keys.remove(key);
    this.#entries.delete(key);
    releaseResource(resource.value);
    return resource;
  }

  /** Number of guest-owned resources (for leak accounting). */
  get ownedCount(): number {
    return this.#entries.size - 4;
  }

  /** Releases every guest-owned resource (Run teardown). */
  closeAll(): void {
    for (const [handle, resource] of [...this.#entries]) {
      if (handle !== this.invalidHandle && !this.#stdio.includes(handle)) {
        this.#keys.remove(handle);
        this.#entries.delete(handle);
        releaseResource(resource);
      }
    }
  }

  #insert(resource: Resource): Handle {
    const handle = this.#keys.insert('resource');
    this.#entries.set(handle, resource);
    return handle;
  }
}
