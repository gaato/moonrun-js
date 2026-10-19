import { type AsyncError, BADF, FAULT, INVAL } from '../../kernel/errors.ts';
import {
  dirEntry,
  fileTimeRecord,
  INOTIFY_BUFFER_SIZE,
  inotifyEventAt,
  LayoutFault,
  OPEN_IDENTITY_REQUEST,
  packStat,
  statRequest,
} from '../../kernel/fs-codec.ts';
import type { Handle } from '../../kernel/handles.ts';
import type { FilesystemPayload, JobPayload, StatRequest } from '../../kernel/job.ts';
import { acquire, type Resource, relinquish } from '../../kernel/resource.ts';
import { err, type Result } from '../../ports/result.ts';
import type { GuestMemory } from '../memory.ts';
import { type AsyncEnv, AsyncFailure, bool, fail, handle, unwrap, zeroOrMinusOne } from './env.ts';
import type { HandlerGroup } from './types.ts';

/**
 * A Guest String Path (moonrun `os_string::read_guest`): `len` UTF-16 units at a
 * 2-aligned `ptr`; an unpaired surrogate is `Inval`. The result is the host path.
 */
export function readGuestPath(memory: GuestMemory, ptr: number, len: number): string {
  if (len !== 0 && ptr % 2 !== 0) {
    throw new AsyncFailure(FAULT);
  }
  if (len * 2 > 0xffff_ffff) {
    throw new AsyncFailure(FAULT);
  }
  const bytes = memory.view(ptr, len * 2);
  const units = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    units[i] = (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
  }
  let text = '';
  for (let i = 0; i < len; i += 4096) {
    text += String.fromCharCode(...units.subarray(i, i + 4096));
  }
  if (!text.isWellFormed()) {
    throw new AsyncFailure(INVAL);
  }
  return text;
}

/** moonrun `Job::filesystem`: every payload but the failed and sleep Jobs. */
export function isFilesystem(
  payload: JobPayload,
): payload is Exclude<JobPayload, { kind: 'failed' | 'sleep' }> {
  return payload.kind !== 'failed' && payload.kind !== 'sleep';
}

/** Filesystem Jobs, readdir buffers, file locks and inotify (moonrun `async_api::{fs, thread_pool}`). */
export function filesystem(env: AsyncEnv) {
  const { kernel, memory } = env;
  const pool = kernel.pool;
  const path = (ptr: number, len: number): string => readGuestPath(memory, ptr, len);
  const failed = (error: AsyncError): Handle => pool.insertJob({ kind: 'failed', error });
  /** `acquire_resource_of_class(File)`: a hold the Job owns. */
  const acquireFile = (fd: bigint): Resource => acquire(unwrap(kernel.resources.get(handle(fd))));
  /** Runs `make` with a hold, dropping it when construction fails. */
  const held = (resource: Resource | undefined, make: () => Handle): Handle => {
    try {
      return make();
    } catch (e) {
      if (resource !== undefined) {
        relinquish(resource);
      }
      throw e;
    }
  };
  const parentOf = (parent: bigint): Resource | undefined =>
    handle(parent) === kernel.resources.invalidHandle ? undefined : acquireFile(parent);
  const visible = (job: bigint) => unwrap(pool.job(handle(job)));
  const fsJob = (job: bigint) => {
    const found = visible(job);
    if (!isFilesystem(found.payload)) {
      throw new AsyncFailure(BADF);
    }
    return found;
  };
  const insert = (payload: FilesystemPayload): Handle => pool.insertJob(payload);
  const open = (
    ptr: number,
    len: number,
    access: number,
    create: number,
    append: number,
    sync: number,
    mode: number,
    request: StatRequest | undefined,
  ): Handle => {
    const p = path(ptr, len);
    if (request === undefined) {
      return failed(INVAL);
    }
    return insert({
      kind: 'open',
      path: p,
      access,
      create,
      append: bool(append),
      sync,
      mode,
      request,
      result: undefined,
    });
  };
  /** Decodes a c_buffer with a layout accessor; out-of-range is `Fault`. */
  const withBuffer = <T>(buf: bigint, f: (bytes: Uint8Array) => T): T => {
    const bytes = unwrap(kernel.cBuffers.get(handle(buf)));
    try {
      return f(bytes);
    } catch (e) {
      throw e instanceof LayoutFault ? new AsyncFailure(FAULT) : e;
    }
  };
  return {
    'thread_pool/make_open_job': (ptr, len, access, create, append, sync, mode) =>
      open(ptr, len, access, create, append, sync, mode, OPEN_IDENTITY_REQUEST),
    'thread_pool/make_open_stat_job': (ptr, len, access, create, append, sync, mode, mask, cap) =>
      open(ptr, len, access, create, append, sync, mode, statRequest(mask, cap)),
    'thread_pool/open_job_get_fd': (job) => unwrap(kernel.openJobFd(handle(job))),
    'thread_pool/open_job_get_kind': (job) =>
      Number(BigInt.asIntN(32, unwrap(kernel.openJobProperty(handle(job), 'kind')))),
    'thread_pool/open_job_get_dev_id': (job) => unwrap(kernel.openJobProperty(handle(job), 'dev')),
    'thread_pool/open_job_get_file_id': (job) => unwrap(kernel.openJobProperty(handle(job), 'ino')),
    'thread_pool/make_fstatx_job': (fd, mask, cap) => {
      const resource = acquireFile(fd);
      const request = statRequest(mask, cap);
      if (request === undefined) {
        relinquish(resource);
        return failed(INVAL);
      }
      return insert({ kind: 'fstatx', resource, request, result: undefined });
    },
    'thread_pool/make_statx_job': (ptr, len, mask, cap, parentFd, follow) => {
      const parent = parentOf(parentFd);
      return held(parent, () => {
        const p = path(ptr, len);
        const request = statRequest(mask, cap);
        if (request === undefined) {
          if (parent !== undefined) {
            relinquish(parent);
          }
          return failed(INVAL);
        }
        return insert({
          kind: 'statx',
          parent,
          path: p,
          request,
          follow: bool(follow),
          result: undefined,
        });
      });
    },
    'thread_pool/get_stat_result': (job, dst, dstLen) => {
      const found = visible(job);
      if (found.err !== undefined) {
        return;
      }
      const payload = found.payload;
      if (!isFilesystem(payload)) {
        throw new AsyncFailure(BADF);
      }
      if (payload.kind !== 'open' && payload.kind !== 'fstatx' && payload.kind !== 'statx') {
        throw new AsyncFailure(BADF);
      }
      const values = payload.kind === 'open' ? payload.result?.stat : payload.result;
      if (values === undefined) {
        throw new AsyncFailure(INVAL);
      }
      const bytes = packStat(payload.request, values);
      if (bytes.length > dstLen) {
        throw new AsyncFailure(FAULT);
      }
      memory.view(dst, dstLen).set(bytes);
    },
    'thread_pool/make_file_kind_by_path_job': (parentFd, ptr, len, follow) => {
      const parent = parentOf(parentFd);
      return held(parent, () =>
        insert({ kind: 'file-kind-by-path', parent, path: path(ptr, len), follow: bool(follow) }),
      );
    },
    'thread_pool/make_file_size_job': (fd) =>
      insert({ kind: 'file-size', resource: acquireFile(fd), result: 0n }),
    'thread_pool/get_file_size_result': (job) => {
      const payload = fsJob(job).payload;
      if (payload.kind !== 'file-size') {
        throw new AsyncFailure(BADF);
      }
      return payload.result;
    },
    'thread_pool/make_file_time_job': (fd) =>
      insert({ kind: 'file-time', resource: acquireFile(fd), result: undefined }),
    'thread_pool/make_file_time_by_path_job': (ptr, len, follow) =>
      insert({
        kind: 'file-time-by-path',
        path: path(ptr, len),
        follow: bool(follow),
        result: undefined,
      }),
    'thread_pool/get_file_time_result': (job, out) => {
      const found = fsJob(job);
      if (found.err !== undefined) {
        return;
      }
      const payload = found.payload;
      if (
        (payload.kind !== 'file-time' && payload.kind !== 'file-time-by-path') ||
        payload.result === undefined
      ) {
        throw new AsyncFailure(BADF);
      }
      memory.write(out, fileTimeRecord(payload.result));
    },
    'thread_pool/make_access_job': (ptr, len, access) =>
      insert({ kind: 'access', path: path(ptr, len), access }),
    'thread_pool/make_chmod_job': (ptr, len, mode) =>
      insert({ kind: 'chmod', path: path(ptr, len), mode }),
    'thread_pool/make_fsync_job': (fd, onlyData) =>
      insert({ kind: 'fsync', resource: acquireFile(fd), dataOnly: bool(onlyData) }),
    'thread_pool/make_flock_job': (fd, exclusive) =>
      insert({ kind: 'flock', resource: acquireFile(fd), exclusive: bool(exclusive) }),
    'thread_pool/make_remove_job': (ptr, len) => insert({ kind: 'remove', path: path(ptr, len) }),
    'thread_pool/make_rename_job': (fromPtr, fromLen, toPtr, toLen, replace) => {
      const from = path(fromPtr, fromLen);
      const to = path(toPtr, toLen);
      return insert({ kind: 'rename', from, to, replace: bool(replace) });
    },
    'thread_pool/make_symlink_job': (targetPtr, targetLen, ptr, len) => {
      const target = path(targetPtr, targetLen);
      return insert({ kind: 'symlink', target, path: path(ptr, len) });
    },
    'thread_pool/make_mkdir_job': (ptr, len, mode) =>
      insert({ kind: 'mkdir', path: path(ptr, len), mode }),
    'thread_pool/make_rmdir_job': (ptr, len) => insert({ kind: 'rmdir', path: path(ptr, len) }),
    'thread_pool/make_readdir_job': (dir, buf, len, restart) => {
      const resource = acquireFile(dir);
      return held(resource, () => {
        const bytes = unwrap(kernel.cBuffers.lease(handle(buf)));
        return insert({
          kind: 'readdir',
          resource,
          buffer: { handle: handle(buf), bytes },
          len,
          restart: bool(restart),
        });
      });
    },
    'thread_pool/make_realpath_job': (ptr, len) =>
      insert({ kind: 'realpath', path: path(ptr, len), result: undefined }),
    'thread_pool/get_realpath_result': (job) => {
      const payload = fsJob(job).payload;
      if (payload.kind !== 'realpath') {
        throw new AsyncFailure(BADF);
      }
      const result = payload.result;
      if (result?.state === 'published') {
        return result.handle;
      }
      if (result === undefined) {
        throw new AsyncFailure(INVAL);
      }
      const published = kernel.cBuffers.insert(result.bytes);
      payload.result = { state: 'published', handle: published };
      return published;
    },
    'thread_pool/make_inotify_add_watch_job': (inotify, ptr, len, isDir) => {
      const resource = acquireFile(inotify);
      return held(resource, () =>
        insert({ kind: 'inotify-add-watch', resource, path: path(ptr, len), isDir: bool(isDir) }),
      );
    },
    'fs/dir_entry_length': (buf, offset) => withBuffer(buf, (b) => dirEntry.length(b, offset)),
    'fs/dir_entry_get_name_len': (buf, offset) =>
      withBuffer(buf, (b) => dirEntry.nameLen(b, offset)),
    'fs/dir_entry_get_name_offset': (buf, offset) =>
      withBuffer(buf, (b) => dirEntry.nameOffset(b, offset)),
    'fs/dir_entry_is_dir': (buf, offset) => withBuffer(buf, (b) => dirEntry.isDir(b, offset)),
    'fs/dir_entry_is_hidden': (buf, offset) =>
      withBuffer(buf, (b) => (dirEntry.isHidden(b, offset) ? 1 : 0)),
    'fs/dir_entry_get_file_id': (buf, offset) => withBuffer(buf, (b) => dirEntry.fileId(b, offset)),
    'fs/try_lock_file': (fd, exclusive) =>
      zeroOrMinusOne(env, () => kernel.tryLockFile(handle(fd), bool(exclusive))),
    'fs/unlock_file': (fd) => zeroOrMinusOne(env, () => kernel.unlockFile(handle(fd))),
    'fs/inotify/create': () => kernel.inotifyCreate(),
    'fs/inotify/event_buffer_size': () => INOTIFY_BUFFER_SIZE,
    'fs/inotify/remove_file': (watcher, wd) =>
      zeroOrMinusOne(env, () => {
        if (wd > 0x7fff_ffffn) {
          return err(INVAL);
        }
        const inotify = kernel.inotify(handle(watcher));
        return inotify.ok ? inotify.value.removeWatch(Number(wd)) : inotify;
      }),
    'fs/inotify/fetch_event': (watcher, buffer, len) => {
      const fetched = ((): Result<number, AsyncError> => {
        const inotify = kernel.inotify(handle(watcher));
        if (!inotify.ok) {
          return inotify;
        }
        const bytes = kernel.cBuffers.get(handle(buffer));
        if (!bytes.ok) {
          return bytes;
        }
        if (len > bytes.value.length) {
          return err(FAULT);
        }
        return inotify.value.fetch(bytes.value.subarray(0, len));
      })();
      return fetched.ok ? fetched.value : fail(env, fetched.error);
    },
    'fs/inotify/event_get_size': (buffer, offset) =>
      withBuffer(buffer, (b) => inotifyEventAt.size(b, offset)),
    'fs/inotify/event_get_wd': (buffer, offset) =>
      withBuffer(buffer, (b) => BigInt.asUintN(64, BigInt(inotifyEventAt.wd(b, offset)))),
    'fs/inotify/event_has_relevant_event': (buffer, offset) =>
      withBuffer(buffer, (b) => (inotifyEventAt.relevant(b, offset) ? 1 : 0)),
    'fs/inotify/event_has_overflow': (buffer, offset) =>
      withBuffer(buffer, (b) => (inotifyEventAt.overflow(b, offset) ? 1 : 0)),
    'fs/inotify/event_has_ignore': (buffer, offset) =>
      withBuffer(buffer, (b) => (inotifyEventAt.ignore(b, offset) ? 1 : 0)),
  } satisfies HandlerGroup;
}
