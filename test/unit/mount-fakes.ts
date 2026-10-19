import type { MountProvider } from '../../src/hosts/browser/mount-provider.ts';
import { take } from '../../src/hosts/browser/mount-provider.ts';
import { type BrowserFiles, MemoryVfs } from '../../src/hosts/browser/vfs.ts';
import { ok } from '../../src/ports/result.ts';

const flags = {
  access: 'read' as const,
  append: false,
  create: false,
  exclusive: false,
  truncate: false,
};
export function fakeMount(
  files: BrowserFiles,
  options: { writable?: boolean; cache?: boolean; delay?: () => Promise<void> } = {},
) {
  const memory = new MemoryVfs(files, '/');
  const calls: { op: string; path: string; offset?: number; length?: number }[] = [];
  const before = async (op: string, path: string) => {
    calls.push({ op, path });
    await options.delay?.();
  };
  const provider: MountProvider = {
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    stat: async (path) => {
      await before('stat', path);
      const result = memory.files.lstat(path);
      return result.ok
        ? ok({ kind: result.value.kind, size: Number(result.value.size), mtimeMs: 1234 })
        : result;
    },
    readdir: async (path) => {
      await before('readdir', path);
      const result = memory.files.readDir(path);
      return result.ok
        ? ok(result.value.map((e) => ({ name: new TextDecoder().decode(e.name), kind: e.kind })))
        : result;
    },
    open: async (path) => {
      await before('open', path);
      const result = memory.files.open(path, flags);
      if (!result.ok) return result;
      const fd = result.value;
      return ok({
        size: Number(take(memory.files.fstat(fd)).size),
        read: async (offset, length) => {
          calls.push({ op: 'read', path, offset, length });
          await options.delay?.();
          const buffer = new Uint8Array(length);
          const read = memory.files.read(fd, buffer, BigInt(offset));
          return read.ok ? ok(buffer.slice(0, read.value)) : read;
        },
        close: () => {
          calls.push({ op: 'close', path });
          memory.files.close(fd);
        },
      });
    },
    readlink: async (path) => {
      const r = memory.files.readLink(path);
      return r.ok ? ok(new TextDecoder().decode(r.value)) : r;
    },
    ...(options.writable === true
      ? {
          create: async (path: string) => {
            const fd = memory.files.open(path, { ...flags, create: true, access: 'write' });
            return fd.ok ? memory.files.close(fd.value) : fd;
          },
          write: async (path: string, offset: number, bytes: Uint8Array) => {
            const opened = memory.files.open(path, { ...flags, access: 'write' });
            if (!opened.ok) return opened;
            try {
              return memory.files.write(opened.value, bytes, BigInt(offset));
            } finally {
              memory.files.close(opened.value);
            }
          },
          truncate: async (path: string, size: number) => {
            const fd = take(memory.files.open(path, { ...flags, access: 'write' }));
            try {
              return memory.files.truncate(fd, BigInt(size));
            } finally {
              memory.files.close(fd);
            }
          },
          mkdir: async (path: string) => memory.files.mkdir(path),
          remove: async (path: string) =>
            take(memory.fs.kind(path)) === 'dir'
              ? memory.files.rmdir(path)
              : memory.files.unlink(path),
          rename: async (a: string, b: string) => memory.files.rename(a, b),
        }
      : {}),
  };
  return { provider, memory, calls };
}
