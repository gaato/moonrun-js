import type { FileKind } from '../../ports/fs.ts';
import type { HostError } from '../../ports/result.ts';

export interface BrowserMemoryEntry {
  readonly name: string;
  readonly kind: FileKind;
}
export interface BrowserMemoryStat {
  readonly kind: FileKind;
  readonly size: number;
  readonly mtimeMs: number;
}
/** Live memory filesystem. All paths are absolute; operations reject with a HostError code. */
export interface BrowserMemoryFs {
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<BrowserMemoryEntry[]>;
  stat(path: string): Promise<BrowserMemoryStat>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}
export type MemoryFsRequest =
  | { readonly kind: 'writeFile'; readonly path: string; readonly data: Uint8Array | string }
  | { readonly kind: 'readFile' | 'readdir' | 'stat'; readonly path: string }
  | { readonly kind: 'mkdir' | 'remove'; readonly path: string; readonly recursive: boolean };
export interface MemoryFsResults {
  readonly writeFile: void;
  readonly readFile: Uint8Array;
  readonly readdir: BrowserMemoryEntry[];
  readonly stat: BrowserMemoryStat;
  readonly mkdir: void;
  readonly remove: void;
}
export type MemoryFsValue = MemoryFsResults[keyof MemoryFsResults];
export type MemoryFsCall = <R extends MemoryFsRequest>(
  request: R,
) => Promise<MemoryFsResults[R['kind']]>;

export function memoryFsError(error: HostError): Error & HostError {
  return Object.assign(new Error(error.message ?? error.code), error);
}

/** One typed facade for direct hosts and Worker RPC. */
export function memoryFilesystem(call: MemoryFsCall): BrowserMemoryFs {
  return {
    writeFile: (path, data) => call({ kind: 'writeFile', path, data }),
    readFile: (path) => call({ kind: 'readFile', path }),
    readdir: (path) => call({ kind: 'readdir', path }),
    stat: (path) => call({ kind: 'stat', path }),
    mkdir: (path, options = {}) =>
      call({ kind: 'mkdir', path, recursive: options.recursive ?? false }),
    remove: (path, options = {}) =>
      call({ kind: 'remove', path, recursive: options.recursive ?? false }),
  };
}

export async function dispatchMemoryFs(
  fs: BrowserMemoryFs,
  request: MemoryFsRequest,
): Promise<MemoryFsValue> {
  switch (request.kind) {
    case 'writeFile':
      return fs.writeFile(request.path, request.data);
    case 'readFile':
      return fs.readFile(request.path);
    case 'readdir':
      return fs.readdir(request.path);
    case 'stat':
      return fs.stat(request.path);
    case 'mkdir':
      return fs.mkdir(request.path, { recursive: request.recursive });
    case 'remove':
      return fs.remove(request.path, { recursive: request.recursive });
  }
}
