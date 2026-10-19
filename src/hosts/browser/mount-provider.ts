import type { FileKind } from '../../ports/fs.ts';
import { err, type HostError, type Result } from '../../ports/result.ts';

export interface MountStat {
  readonly kind: FileKind;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly mode?: number;
}
export interface MountEntry {
  readonly name: string;
  readonly kind: FileKind;
}
export interface MountFile {
  readonly size: number;
  read(offset: number, length: number): Promise<Result<Uint8Array, HostError>>;
  close?(): void;
}
/** Paths are absolute within the provider: / is its root, never a host filesystem path. */
export interface MountProvider {
  /** false disables the VFS's run-local metadata, directory and byte caches. Default true. */
  readonly cache?: boolean;
  stat(path: string): Promise<Result<MountStat, HostError>>;
  readdir(path: string): Promise<Result<readonly MountEntry[], HostError>>;
  open(path: string): Promise<Result<MountFile, HostError>>;
  readlink?(path: string): Promise<Result<string, HostError>>;
  create?(path: string): Promise<Result<void, HostError>>;
  write?(path: string, offset: number, bytes: Uint8Array): Promise<Result<number, HostError>>;
  truncate?(path: string, size: number): Promise<Result<void, HostError>>;
  mkdir?(path: string): Promise<Result<void, HostError>>;
  remove?(path: string): Promise<Result<void, HostError>>;
  rename?(from: string, to: string): Promise<Result<void, HostError>>;
}
export type BrowserMounts = Readonly<Record<string, MountProvider>>;

export function mountError(e: unknown): HostError {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string')
    return e as HostError;
  return { code: 'EIO' };
}
export function take<T>(result: Result<T, HostError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
export async function mounted<T>(work: () => Promise<T>): Promise<Result<T, HostError>> {
  try {
    return { ok: true, value: await work() };
  } catch (e) {
    return err(mountError(e));
  }
}
