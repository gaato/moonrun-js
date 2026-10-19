import type { HostError, Result } from './result.ts';

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

/**
 * Synchronous filesystem primitives used by the legacy whole-file imports and WASI.
 * Paths are host paths; relative paths resolve against the run's working directory.
 */
export interface FsPort {
  cwd(): Result<string, HostError>;
  /** Resolves `path` against the working directory without touching the filesystem. */
  resolve(path: string): string;
  readFile(path: string): Result<Uint8Array, HostError>;
  writeFile(path: string, data: Uint8Array): Result<void, HostError>;
  mkdirAll(path: string): Result<void, HostError>;
  readDir(path: string): Result<string[], HostError>;
  removeFile(path: string): Result<void, HostError>;
  removeDirAll(path: string): Result<void, HostError>;
  /** Follows symlinks. */
  kind(path: string): Result<FileKind, HostError>;
}
