import { err, type HostError, type HostErrorCode, ok, type Result } from '../../ports/result.ts';
import type { MountEntry, MountProvider } from './mount-provider.ts';

interface NativeHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  move?(parent: BrowserDirectoryHandle, name: string): Promise<void>;
}
interface NativeFile {
  readonly size: number;
  readonly lastModified: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
interface NativeWriter {
  seek(position: number): Promise<void>;
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface NativeFileHandle extends NativeHandle {
  readonly kind: 'file';
  getFile(): Promise<NativeFile>;
  createWritable(options: { keepExistingData: boolean }): Promise<NativeWriter>;
}
/** Structural subset, assignable from a browser FileSystemDirectoryHandle without DOM shims. */
export interface BrowserDirectoryHandle extends NativeHandle {
  readonly kind: 'directory';
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<NativeFileHandle>;
  entries(): AsyncIterable<[string, NativeHandle]>;
  removeEntry(name: string): Promise<void>;
}
function failure(e: unknown, mismatch: HostErrorCode): HostError {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string')
    return e as HostError;
  const name = typeof e === 'object' && e !== null && 'name' in e ? e.name : '';
  const codes: Readonly<Record<string, HostErrorCode>> = {
    NotFoundError: 'ENOENT',
    NotAllowedError: 'EACCES',
    SecurityError: 'EACCES',
    TypeMismatchError: mismatch,
    InvalidModificationError: 'ENOTEMPTY',
    NoModificationAllowedError: 'EACCES',
    QuotaExceededError: 'ENOSPC',
    NotSupportedError: 'ENOSYS',
    InvalidStateError: 'EBADF',
  };
  return { code: typeof name === 'string' ? (codes[name] ?? 'EIO') : 'EIO' };
}
async function native<T>(
  work: () => Promise<T>,
  mismatch: HostErrorCode = 'ENOTDIR',
): Promise<Result<T, HostError>> {
  try {
    return ok(await work());
  } catch (e) {
    return err(failure(e, mismatch));
  }
}
function parts(path: string): string[] {
  if (!path.startsWith('/') || path.includes('\0')) throw { code: 'EINVAL' };
  const names = path.split('/').filter(Boolean);
  if (names.some((n) => n === '.' || n === '..')) throw { code: 'EINVAL' };
  return names;
}

/** All native operations stay with the embedder; runInWorker proxies this like any provider. */
export function directoryHandleProvider(
  root: BrowserDirectoryHandle,
  options: { readonly readOnly?: boolean; readonly cache?: boolean } = {},
): MountProvider {
  const directory = async (names: readonly string[]) => {
    let dir = root;
    for (const name of names) dir = await dir.getDirectoryHandle(name);
    return dir;
  };
  const parent = async (path: string) => {
    const names = parts(path);
    const name = names.pop();
    if (name === undefined) throw { code: 'EBUSY' };
    return { dir: await directory(names), name };
  };
  const file = async (path: string): Promise<NativeFileHandle> => {
    if (parts(path).length === 0) throw { code: 'EISDIR' };
    const { dir, name } = await parent(path);
    try {
      return await dir.getFileHandle(name);
    } catch (e) {
      throw failure(e, 'EISDIR');
    }
  };
  const handle = async (path: string): Promise<BrowserDirectoryHandle | NativeFileHandle> => {
    if (parts(path).length === 0) return root;
    const { dir, name } = await parent(path);
    try {
      return await dir.getDirectoryHandle(name);
    } catch (e) {
      if (failure(e, 'ENOTDIR').code !== 'ENOTDIR') throw e;
      return dir.getFileHandle(name);
    }
  };
  // createWritable uses a temporary file; serialize mutations to prevent lost updates.
  let tail = Promise.resolve();
  const mutate = <T>(work: () => Promise<T>) => {
    const pending = tail.then(work);
    tail = pending.then(
      () => {},
      () => {},
    );
    return native(() => pending);
  };
  const withWriter = async (path: string, work: (writer: NativeWriter) => Promise<void>) => {
    const entry = await file(path);
    if (typeof entry.createWritable !== 'function') throw { code: 'ENOSYS' };
    const writer = await entry.createWritable({ keepExistingData: true });
    try {
      await work(writer);
      await writer.close();
    } catch (e) {
      try {
        await writer.abort();
      } catch {
        /* Preserve the original failure. */
      }
      throw e;
    }
  };
  return {
    cache: options.cache ?? false,
    stat: (path) =>
      native(async () => {
        const entry = await handle(path);
        if (entry.kind === 'directory') return { kind: 'dir' as const };
        const snapshot = await entry.getFile();
        return { kind: 'file' as const, size: snapshot.size, mtimeMs: snapshot.lastModified };
      }),
    readdir: (path) =>
      native(async () => {
        const dir = await directory(parts(path));
        const entries: MountEntry[] = [];
        for await (const [name, entry] of dir.entries())
          entries.push({ name, kind: entry.kind === 'directory' ? 'dir' : 'file' });
        return entries;
      }),
    open: (path) =>
      native(async () => {
        const entry = await file(path);
        const snapshot = await entry.getFile();
        return {
          size: snapshot.size,
          read: (offset: number, length: number) =>
            native(async () => {
              if (
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                !Number.isSafeInteger(length) ||
                length < 0
              )
                throw { code: 'EINVAL' };
              const current = await entry.getFile();
              return new Uint8Array(await current.slice(offset, offset + length).arrayBuffer());
            }),
        };
      }),
    ...(options.readOnly === true
      ? {}
      : {
          create: (path: string) =>
            mutate(async () => {
              const { dir, name } = await parent(path);
              await dir.getFileHandle(name, { create: true });
            }),
          write: (path: string, offset: number, bytes: Uint8Array) =>
            mutate(async () => {
              if (!Number.isSafeInteger(offset) || offset < 0) throw { code: 'EINVAL' };
              await withWriter(path, async (writer) => {
                await writer.seek(offset);
                await writer.write(bytes.slice());
              });
              return bytes.length;
            }),
          truncate: (path: string, size: number) =>
            mutate(async () => {
              if (!Number.isSafeInteger(size) || size < 0) throw { code: 'EINVAL' };
              await withWriter(path, (writer) => writer.truncate(size));
            }),
          mkdir: (path: string) =>
            mutate(async () => {
              const { dir, name } = await parent(path);
              try {
                await handle(path);
                throw { code: 'EEXIST' };
              } catch (e) {
                if (failure(e, 'ENOTDIR').code !== 'ENOENT') throw e;
              }
              await dir.getDirectoryHandle(name, { create: true });
            }),
          remove: (path: string) =>
            mutate(async () => {
              const { dir, name } = await parent(path);
              await dir.removeEntry(name);
            }),
          rename: (from: string, to: string) =>
            mutate(async () => {
              const entry = await handle(from);
              const { dir, name } = await parent(to);
              if (typeof entry.move !== 'function') throw { code: 'ENOSYS' };
              await entry.move(dir, name);
            }),
        }),
  };
}
