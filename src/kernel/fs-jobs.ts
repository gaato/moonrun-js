import type { DirectoryRecord, FileStat, HostFd, OpenFlags } from '../ports/files.ts';
import { err, type HostError, ok, type Result } from '../ports/result.ts';
import { type AsyncError, BADF, FAULT, INVAL, IO, native } from './errors.ts';
import {
  type DirectoryCursor,
  fdKindOfMode,
  fileKindCode,
  fileTimes,
  inodeKey,
  statValues,
} from './file.ts';
import { DT_DIR, direntLength, writeDirent } from './fs-codec.ts';
import type { FilesystemPayload, Job } from './job.ts';
import type { Execution, JobEnvironment } from './job-runner.ts';
import type { Resource } from './resource.ts';

type Of<K extends FilesystemPayload['kind']> = Extract<FilesystemPayload, { kind: K }>;

const FINISHED: Execution = { interrupt: () => false };
const EINTR = native('EINTR');

function hostFailure(error: HostError): AsyncError {
  return native(error.code);
}

function lift<T>(result: Result<T, HostError>): Result<T, AsyncError> {
  return result.ok ? result : err(hostFailure(result.error));
}

/**
 * Settles a Job from asynchronous host work. Filesystem syscalls cannot be
 * interrupted once issued (moonrun leaves them outside cancellable regions or the
 * kernel completes them anyway), so the Execution never interrupts.
 */
function settle(
  job: Job,
  done: () => void,
  work: () => Promise<Result<number, AsyncError>>,
): Execution {
  work().then(
    (result) => {
      if (result.ok) {
        job.succeed(result.value);
      } else {
        job.fail(result.error);
      }
      done();
    },
    () => {
      job.fail(IO);
      done();
    },
  );
  return FINISHED;
}

/** `CString::new`: a path with an interior NUL is `EINVAL` when the Job runs. */
function checkPath(...paths: string[]): AsyncError | undefined {
  return paths.some((p) => p.includes('\0')) ? INVAL : undefined;
}

/** The descriptor of a file-class resource (`Resource::as_file`). */
function descriptor(resource: Resource): Result<HostFd | undefined, AsyncError> {
  switch (resource.kind) {
    case 'file':
      return ok(resource.file.fd);
    case 'stdio':
      return ok(resource.stream as HostFd);
    case 'invalid':
      return err(BADF);
    // moonrun-js models these without host descriptors.
    case 'pipe':
    case 'completion-source':
    case 'inotify':
    case 'socket':
      return ok(undefined);
  }
}

const S_IFIFO = 0o010000n;
const S_IFSOCK = 0o140000n;

/** `fstat` of a resource; pipes and the inotify instance have no host descriptor (D15). */
async function fstatOf(
  resource: Resource,
  env: JobEnvironment,
): Promise<Result<FileStat, AsyncError>> {
  const fd = descriptor(resource);
  if (!fd.ok) {
    return fd;
  }
  if (fd.value !== undefined) {
    return lift(await env.files.async.fstat(fd.value));
  }
  const mode =
    resource.kind === 'inotify'
      ? 0n
      : resource.kind === 'socket'
        ? S_IFSOCK | 0o777n
        : S_IFIFO | 0o600n;
  return ok({
    kind: 'other',
    dev: 0n,
    ino: 0n,
    mode,
    nlink: 1n,
    uid: 0n,
    gid: 0n,
    rdev: 0n,
    size: 0n,
    blksize: 4096n,
    blocks: 0n,
    atimeNs: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
    birthtimeNs: 0n,
  });
}

/** `fstatat(parent ?? AT_FDCWD, path, flags)`. */
async function statAt(
  parent: Resource | undefined,
  path: string,
  follow: boolean,
  env: JobEnvironment,
): Promise<Result<FileStat, AsyncError>> {
  const bad = checkPath(path);
  if (bad !== undefined) {
    return err(bad);
  }
  let dir: HostFd | undefined;
  if (parent !== undefined) {
    const fd = descriptor(parent);
    if (!fd.ok) {
      return fd;
    }
    if (fd.value === undefined && !path.startsWith('/')) {
      return err(native('ENOTDIR'));
    }
    dir = fd.value;
  }
  return lift(await env.files.async.statAt(dir, path, follow));
}

function openFlags(payload: Of<'open'>): Result<OpenFlags, AsyncError> {
  const access =
    payload.access === 0 || payload.access === 3
      ? 'read'
      : payload.access === 1
        ? 'write'
        : payload.access === 2
          ? 'readWrite'
          : undefined;
  const create = [
    { create: false, truncate: false, exclusive: false },
    { create: false, truncate: true, exclusive: false },
    { create: true, truncate: false, exclusive: false },
    { create: true, truncate: true, exclusive: false },
    { create: true, truncate: false, exclusive: true },
  ][payload.create];
  const sync =
    payload.sync === 0
      ? null
      : payload.sync === 1
        ? 'data'
        : payload.sync === 2
          ? 'full'
          : undefined;
  if (access === undefined || create === undefined || sync === undefined) {
    return err(INVAL);
  }
  return ok({
    access,
    append: payload.append,
    ...create,
    ...(sync === null ? {} : { sync }),
    mode: payload.mode >>> 0,
  });
}

/** `open_job_worker`: open, then `fstat` for the requested properties. */
async function open(payload: Of<'open'>, env: JobEnvironment): Promise<Result<number, AsyncError>> {
  const flags = openFlags(payload);
  if (!flags.ok) {
    return flags;
  }
  const bad = checkPath(payload.path);
  if (bad !== undefined) {
    return err(bad);
  }
  const fd = await env.files.async.open(payload.path, flags.value);
  if (!fd.ok) {
    return err(hostFailure(fd.error));
  }
  const file = env.adoptFile(fd.value, payload.path);
  const canonical = await env.files.async.realpath(payload.path);
  file.canonicalPath = canonical.ok ? lossyPath(canonical.value) : undefined;
  const stat = await env.files.async.fstat(fd.value);
  if (!stat.ok) {
    file.release();
    return err(hostFailure(stat.error));
  }
  payload.result = {
    opened: { state: 'unpublished', file },
    stat: statValues(stat.value, payload.request.mask),
  };
  return ok(0);
}

/** `remove(3)`: unlink, or rmdir when the path is a directory. */
async function remove(path: string, env: JobEnvironment): Promise<Result<number, AsyncError>> {
  const unlinked = await env.files.async.unlink(path);
  if (unlinked.ok) {
    return ok(0);
  }
  if (unlinked.error.code !== 'EISDIR') {
    return err(hostFailure(unlinked.error));
  }
  const removed = await env.files.async.rmdir(path);
  return removed.ok ? ok(0) : err(hostFailure(removed.error));
}

/**
 * `renameat2`; `RENAME_NOREPLACE` is emulated by checking the target first (Node has no
 * rename flags), so a target created concurrently is replaced (D18).
 */
async function rename(
  payload: Of<'rename'>,
  env: JobEnvironment,
): Promise<Result<number, AsyncError>> {
  const files = env.files.async;
  if (!payload.replace) {
    const source = await files.statAt(undefined, payload.from, false);
    if (!source.ok) {
      return err(hostFailure(source.error));
    }
    const target = await files.statAt(undefined, payload.to, false);
    if (target.ok) {
      return err(native('EEXIST'));
    }
  }
  const renamed = await files.rename(payload.from, payload.to);
  return renamed.ok ? ok(0) : err(hostFailure(renamed.error));
}

const ACCESS_MODES = ['exists', 'read', 'write', 'execute'] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Host path bytes as the string ports use (U+FFFD for invalid UTF-8, D4). */
function lossyPath(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

async function specials(fd: HostFd, env: JobEnvironment): Promise<DirectoryRecord[]> {
  const self = await env.files.async.fstat(fd);
  const parent = await env.files.async.statAt(fd, '..', true);
  return [
    { ino: self.ok ? self.value.ino : 0n, type: DT_DIR, name: encoder.encode('.') },
    { ino: parent.ok ? parent.value.ino : 0n, type: DT_DIR, name: encoder.encode('..') },
  ];
}

/**
 * `getdents64` over the host's directory stream: whole records that fit `out`, 0 at
 * the end, `EINVAL` when the next record does not fit an empty buffer.
 */
async function readdir(
  payload: Of<'readdir'>,
  env: JobEnvironment,
): Promise<Result<number, AsyncError>> {
  const resource = payload.resource;
  const fd = descriptor(resource);
  if (!fd.ok) {
    return fd;
  }
  if (payload.len > payload.buffer.bytes.length) {
    return err(FAULT);
  }
  if (resource.kind !== 'file' || fd.value === undefined) {
    return err(native('ENOTDIR'));
  }
  const file = resource.file;
  const out = payload.buffer.bytes.subarray(0, payload.len);
  if (payload.restart || file.directory === undefined) {
    file.directory?.reader?.close();
    file.directory = { reader: undefined, specials: undefined, pending: undefined, eof: false };
  }
  const cursor: DirectoryCursor = file.directory;
  if (cursor.eof) {
    return ok(0);
  }
  if (cursor.reader === undefined) {
    const reader = await env.files.async.openDirectory(fd.value);
    if (!reader.ok) {
      return err(hostFailure(reader.error));
    }
    cursor.reader = reader.value;
    cursor.specials = await specials(fd.value, env);
  }
  let offset = 0;
  let index = 0n;
  for (;;) {
    let record = cursor.specials?.shift() ?? cursor.pending;
    if (record === cursor.pending) {
      cursor.pending = undefined;
    }
    if (record === undefined) {
      const next = await cursor.reader.next();
      if (!next.ok) {
        return offset > 0 ? ok(offset) : err(hostFailure(next.error));
      }
      if (next.value === null) {
        cursor.eof = true;
        return ok(offset);
      }
      record = next.value;
    }
    if (offset + direntLength(record.name) > out.length) {
      cursor.pending = record;
      return offset > 0 ? ok(offset) : err(INVAL);
    }
    index++;
    offset += writeDirent(out, offset, record, index);
  }
}

/** `flock_job_worker`: a blocking `flock(2)`, interruptible while it waits. */
function flock(job: Job, payload: Of<'flock'>, env: JobEnvironment, done: () => void): Execution {
  let state: 'identifying' | 'waiting' | 'finished' = 'identifying';
  let cancel: (() => void) | undefined;
  const finish = (error: AsyncError | undefined): void => {
    if (state === 'finished') {
      return;
    }
    state = 'finished';
    if (error === undefined) {
      job.succeed(0);
    } else {
      job.fail(error);
    }
    done();
  };
  lockIdentity(payload.resource, env).then(
    (key) => {
      if (state !== 'identifying') {
        return;
      }
      if (!key.ok) {
        finish(key.error);
        return;
      }
      state = 'waiting';
      cancel = env.locks.lock(key.value, lockOwner(payload.resource), payload.exclusive, () =>
        finish(undefined),
      );
    },
    () => finish(IO),
  );
  return {
    interrupt: () => {
      if (state === 'finished') {
        return false;
      }
      cancel?.();
      finish(EINTR);
      return true;
    },
  };
}

/** The open file description a lock belongs to. */
export function lockOwner(resource: Resource): object {
  switch (resource.kind) {
    case 'file':
      return resource.file;
    case 'pipe':
      return resource.end;
    case 'completion-source':
      return resource.source;
    case 'inotify':
      return resource.inotify;
    case 'socket':
      return resource.socket;
    case 'stdio':
    case 'invalid':
      return resource;
  }
}

async function lockIdentity(
  resource: Resource,
  env: JobEnvironment,
): Promise<Result<string, AsyncError>> {
  if (resource.kind === 'file' && resource.file.lockKey !== undefined) {
    return ok(resource.file.lockKey);
  }
  const stat = await fstatOf(resource, env);
  if (!stat.ok) {
    return stat;
  }
  // Descriptor-less resources lock against themselves only.
  const key = stat.value.ino === 0n ? env.lockKeyOf(lockOwner(resource)) : inodeKey(stat.value);
  if (resource.kind === 'file') {
    resource.file.lockKey = key;
  }
  return ok(key);
}

/** Runs a Filesystem Job (moonrun `filesystem::Job::run`). */
export function startFilesystemJob(
  job: Job,
  payload: FilesystemPayload,
  env: JobEnvironment,
  done: () => void,
): Execution {
  // Host Filesystem authorization (moonrun `check_policy`) happens before any side effect.
  const denied = env.authorize(payload);
  if (denied !== undefined) {
    job.fail(denied);
    done();
    return FINISHED;
  }
  const files = env.files.async;
  const path = (p: string, run: () => Promise<Result<unknown, HostError>>) =>
    settle(job, done, async () => {
      const bad = checkPath(p);
      if (bad !== undefined) {
        return err(bad);
      }
      const r = await run();
      return r.ok ? ok(0) : err(hostFailure(r.error));
    });
  switch (payload.kind) {
    case 'open':
      return settle(job, done, () => open(payload, env));
    case 'fstatx':
      return settle(job, done, async () => {
        const stat = await fstatOf(payload.resource, env);
        if (!stat.ok) {
          return stat;
        }
        payload.result = statValues(stat.value, payload.request.mask);
        return ok(0);
      });
    case 'statx':
      return settle(job, done, async () => {
        const stat = await statAt(payload.parent, payload.path, payload.follow, env);
        if (!stat.ok) {
          return stat;
        }
        payload.result = statValues(stat.value, payload.request.mask);
        return ok(0);
      });
    case 'file-kind-by-path':
      return settle(job, done, async () => {
        const stat = await statAt(payload.parent, payload.path, payload.follow, env);
        if (!stat.ok) {
          return stat;
        }
        return ok(fileKindCode(fdKindOfMode(stat.value.mode)));
      });
    case 'file-size':
      return settle(job, done, async () => {
        const stat = await fstatOf(payload.resource, env);
        if (!stat.ok) {
          return stat;
        }
        payload.result = BigInt.asIntN(64, stat.value.size);
        return ok(0);
      });
    case 'file-time':
      return settle(job, done, async () => {
        const stat = await fstatOf(payload.resource, env);
        if (!stat.ok) {
          return stat;
        }
        payload.result = fileTimes(stat.value);
        return ok(0);
      });
    case 'file-time-by-path':
      return settle(job, done, async () => {
        const stat = await statAt(undefined, payload.path, payload.follow, env);
        if (!stat.ok) {
          return stat;
        }
        payload.result = fileTimes(stat.value);
        return ok(0);
      });
    case 'access': {
      const mode = ACCESS_MODES[payload.access];
      if (mode === undefined) {
        job.fail(INVAL);
        done();
        return FINISHED;
      }
      return path(payload.path, () => files.access(payload.path, mode));
    }
    case 'chmod':
      return path(payload.path, () => files.chmod(payload.path, payload.mode & 0o7777));
    case 'fsync':
      return settle(job, done, async () => {
        const fd = descriptor(payload.resource);
        if (!fd.ok) {
          return fd;
        }
        if (fd.value === undefined) {
          return err(INVAL);
        }
        const synced = await files.fsync(fd.value, payload.dataOnly);
        return synced.ok ? ok(0) : err(hostFailure(synced.error));
      });
    case 'flock':
      return flock(job, payload, env, done);
    case 'remove':
      return settle(job, done, async () => {
        const bad = checkPath(payload.path);
        return bad === undefined ? remove(payload.path, env) : err(bad);
      });
    case 'rename':
      return settle(job, done, async () => {
        const bad = checkPath(payload.from, payload.to);
        return bad === undefined ? rename(payload, env) : err(bad);
      });
    case 'symlink':
      return settle(job, done, async () => {
        const bad = checkPath(payload.target, payload.path);
        if (bad !== undefined) {
          return err(bad);
        }
        const r = await files.symlink(payload.target, payload.path);
        return r.ok ? ok(0) : err(hostFailure(r.error));
      });
    case 'mkdir':
      return path(payload.path, () => files.mkdir(payload.path, payload.mode & 0o7777));
    case 'rmdir':
      return path(payload.path, () => files.rmdir(payload.path));
    case 'readdir': {
      const resource = payload.resource;
      if (resource.kind !== 'file') {
        return settle(job, done, () => readdir(payload, env));
      }
      // Directory-cursor Jobs on one descriptor run one at a time.
      const file = resource.file;
      const run = file.cursorQueue.then(() => readdir(payload, env));
      file.cursorQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return settle(job, done, () => run);
    }
    case 'inotify-add-watch': {
      const resource = payload.resource;
      const wd =
        resource.kind === 'inotify'
          ? resource.inotify.addWatch(payload.path, payload.isDir)
          : err(INVAL);
      if (wd.ok) {
        job.succeed(wd.value);
      } else {
        job.fail(wd.error);
      }
      done();
      return FINISHED;
    }
    case 'realpath':
      return settle(job, done, async () => {
        const bad = checkPath(payload.path);
        if (bad !== undefined) {
          return err(bad);
        }
        const resolved = await files.realpath(payload.path);
        if (!resolved.ok) {
          return err(hostFailure(resolved.error));
        }
        const bytes = new Uint8Array(resolved.value.length + 1);
        bytes.set(resolved.value);
        payload.result = { state: 'unpublished', bytes };
        return ok(0);
      });
  }
}
