import { err, type HostError, ok, type Result } from '../../ports/result.ts';
import {
  type BrowserMounts,
  type MountEntry,
  type MountFile,
  type MountProvider,
  type MountStat,
  mounted,
  take,
} from './mount-provider.ts';

const optional = ['readlink', 'create', 'write', 'truncate', 'mkdir', 'remove', 'rename'] as const;
export interface MountDescription {
  readonly cache: boolean;
  readonly capabilities: readonly (typeof optional)[number][];
}
export type MountDescriptions = Readonly<Record<string, MountDescription>>;
export type MountCall =
  | {
      readonly op: 'stat' | 'readdir' | 'open' | 'readlink' | 'create' | 'mkdir' | 'remove';
      readonly path: string;
    }
  | {
      readonly op: 'read';
      readonly handle: number;
      readonly offset: number;
      readonly length: number;
    }
  | { readonly op: 'close'; readonly handle: number }
  | {
      readonly op: 'write';
      readonly path: string;
      readonly offset: number;
      readonly bytes: Uint8Array;
    }
  | { readonly op: 'truncate'; readonly path: string; readonly size: number }
  | { readonly op: 'rename'; readonly from: string; readonly to: string };
export type MountValue =
  | MountStat
  | readonly MountEntry[]
  | Uint8Array
  | string
  | number
  | undefined
  | { readonly handle: number; readonly size: number };

/** The same provider model is used for arbitrary callbacks and native directory handles. */
export class MountServer {
  readonly descriptions: MountDescriptions;
  readonly mounts: BrowserMounts;
  readonly #files = new Map<number, { mount: string; file: MountFile }>();
  #next = 0;
  #closed = false;
  #isClosed(): boolean {
    return this.#closed;
  }
  constructor(mounts: BrowserMounts) {
    this.mounts = mounts;
    this.descriptions = Object.fromEntries(
      Object.entries(mounts).map(([path, provider]) => [
        path,
        {
          cache: provider.cache !== false,
          capabilities: optional.filter((op) => provider[op] !== undefined),
        },
      ]),
    );
  }
  call(mount: string, request: MountCall): Promise<Result<MountValue, HostError>> {
    return mounted(async () => {
      if (this.#isClosed()) throw { code: 'ECANCELED' };
      const provider = this.mounts[mount];
      if (!provider) throw { code: 'ENOENT' };
      if (request.op === 'read' || request.op === 'close') {
        const entry = this.#files.get(request.handle);
        if (!entry || entry.mount !== mount) throw { code: 'EBADF' };
        if (request.op === 'read')
          return take(await entry.file.read(request.offset, request.length));
        this.#files.delete(request.handle);
        entry.file.close?.();
        return undefined;
      }
      switch (request.op) {
        case 'open': {
          const file = take(await provider.open(request.path));
          if (this.#isClosed()) {
            file.close?.();
            throw { code: 'ECANCELED' };
          }
          const handle = ++this.#next;
          this.#files.set(handle, { mount, file });
          return { handle, size: file.size };
        }
        case 'stat':
          return take(await provider.stat(request.path));
        case 'readdir':
          return take(await provider.readdir(request.path));
        case 'write':
          return take(
            await (provider.write?.(request.path, request.offset, request.bytes) ??
              err({ code: 'EROFS' })),
          );
        case 'truncate':
          take(await (provider.truncate?.(request.path, request.size) ?? err({ code: 'EROFS' })));
          return undefined;
        case 'rename':
          take(await (provider.rename?.(request.from, request.to) ?? err({ code: 'EROFS' })));
          return undefined;
        case 'readlink':
          return take(await (provider.readlink?.(request.path) ?? err({ code: 'ENOSYS' })));
        default: {
          const method = provider[request.op];
          take(await (method?.call(provider, request.path) ?? err({ code: 'EROFS' })));
          return undefined;
        }
      }
    });
  }
  close(): void {
    this.#closed = true;
    for (const { file } of this.#files.values()) {
      try {
        file.close?.();
      } catch {
        /* Release all readers even if one provider fails. */
      }
    }
    this.#files.clear();
  }
}
export function proxyMounts(
  descriptions: MountDescriptions,
  call: (mount: string, request: MountCall) => Promise<Result<MountValue, HostError>>,
): BrowserMounts {
  return Object.fromEntries(
    Object.entries(descriptions).map(([mount, description]) => {
      const rpc = async <T extends MountValue>(request: MountCall): Promise<Result<T, HostError>> =>
        (await call(mount, request)) as Result<T, HostError>;
      const provider: MountProvider = {
        cache: description.cache,
        stat: (path) => rpc<MountStat>({ op: 'stat', path }),
        readdir: (path) => rpc<readonly MountEntry[]>({ op: 'readdir', path }),
        open: async (path) => {
          const result = await rpc<{ handle: number; size: number }>({ op: 'open', path });
          if (!result.ok) return result;
          const { handle, size } = result.value;
          return ok({
            size,
            read: (offset, length) => rpc<Uint8Array>({ op: 'read', handle, offset, length }),
            close: () => {
              void rpc({ op: 'close', handle }).catch(() => {});
            },
          });
        },
        ...(description.capabilities.includes('readlink')
          ? { readlink: (path: string) => rpc<string>({ op: 'readlink', path }) }
          : {}),
        ...(description.capabilities.includes('create')
          ? { create: (path: string) => rpc<undefined>({ op: 'create', path }) }
          : {}),
        ...(description.capabilities.includes('mkdir')
          ? { mkdir: (path: string) => rpc<undefined>({ op: 'mkdir', path }) }
          : {}),
        ...(description.capabilities.includes('remove')
          ? { remove: (path: string) => rpc<undefined>({ op: 'remove', path }) }
          : {}),
        ...(description.capabilities.includes('write')
          ? {
              write: (path: string, offset: number, bytes: Uint8Array) =>
                rpc<number>({ op: 'write', path, offset, bytes }),
            }
          : {}),
        ...(description.capabilities.includes('truncate')
          ? {
              truncate: (path: string, size: number) =>
                rpc<undefined>({ op: 'truncate', path, size }),
            }
          : {}),
        ...(description.capabilities.includes('rename')
          ? { rename: (from: string, to: string) => rpc<undefined>({ op: 'rename', from, to }) }
          : {}),
      };
      return [mount, provider];
    }),
  );
}
