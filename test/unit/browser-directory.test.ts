import { describe, expect, it } from 'vitest';
import {
  type BrowserDirectoryHandle,
  directoryHandleProvider,
} from '../../src/hosts/browser/directory-provider.ts';
import { take } from '../../src/hosts/browser/mount-provider.ts';
import { MountedVfs } from '../../src/hosts/browser/mounted-vfs.ts';
import { MemoryVfs } from '../../src/hosts/browser/vfs.ts';
import { ok } from '../../src/ports/result.ts';

const encode = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const dom = (name: string): never => {
  throw new DOMException(name, name);
};
class Folder implements BrowserDirectoryHandle {
  readonly kind = 'directory';
  readonly name: string;
  readonly memory: MemoryVfs;
  readonly path: string;
  writes = 0;
  denied = false;
  failWrite = false;
  movable = false;
  constructor(memory = new MemoryVfs({ 'file.txt': 'abcdef', sub: null }, '/'), path = '') {
    this.memory = memory;
    this.path = path;
    this.name = path.split('/').at(-1) ?? '';
  }
  child(name: string): string {
    if (this.denied) dom('NotAllowedError');
    return `${this.path}/${name}`;
  }
  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<Folder> {
    const path = this.child(name);
    const kind = this.memory.fs.kind(path);
    if (!kind.ok) {
      if (!options.create) dom('NotFoundError');
      take(this.memory.files.mkdir(path));
    } else if (kind.value !== 'dir') dom('TypeMismatchError');
    return new Folder(this.memory, path);
  }
  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    let path = this.child(name);
    const kind = this.memory.fs.kind(path);
    if (!kind.ok) {
      if (!options.create) dom('NotFoundError');
      take(this.memory.fs.writeFile(path, new Uint8Array()));
    } else if (kind.value !== 'file') dom('TypeMismatchError');
    return {
      kind: 'file' as const,
      name,
      ...(this.movable
        ? {
            move: async (parent: BrowserDirectoryHandle, name: string) => {
              if (!(parent instanceof Folder)) throw new Error('foreign handle');
              const next = parent.child(name);
              take(this.memory.files.rename(path, next));
              path = next;
            },
          }
        : {}),
      getFile: async () => {
        const bytes = take(this.memory.fs.readFile(path));
        return {
          size: bytes.length,
          lastModified: 123,
          slice: (start: number, end: number) => ({
            arrayBuffer: async () => bytes.slice(start, end).buffer,
          }),
        };
      },
      createWritable: async ({ keepExistingData }: { keepExistingData: boolean }) => {
        let data = keepExistingData ? take(this.memory.fs.readFile(path)) : new Uint8Array();
        let offset = 0;
        const resize = (size: number) => {
          const next = new Uint8Array(size);
          next.set(data.subarray(0, size));
          data = next;
        };
        return {
          seek: async (pos: number) => {
            offset = pos;
          },
          write: async (bytes: Uint8Array) => {
            if (this.failWrite) dom('QuotaExceededError');
            if (offset + bytes.length > data.length) resize(offset + bytes.length);
            data.set(bytes, offset);
            offset += bytes.length;
          },
          truncate: async (size: number) => {
            resize(size);
          },
          close: async () => {
            this.writes++;
            take(this.memory.fs.writeFile(path, data));
          },
          abort: async () => {},
        };
      },
    };
  }
  async *entries(): AsyncGenerator<[string, { name: string; kind: 'file' | 'directory' }]> {
    if (this.denied) dom('NotAllowedError');
    for (const entry of take(this.memory.files.readDir(this.path || '/'))) {
      const name = text(entry.name);
      yield [name, { name, kind: entry.kind === 'dir' ? 'directory' : 'file' }];
    }
  }
  async removeEntry(name: string): Promise<void> {
    const path = this.child(name);
    const result =
      take(this.memory.fs.kind(path)) === 'dir'
        ? this.memory.files.rmdir(path)
        : this.memory.files.unlink(path);
    if (!result.ok && result.error.code === 'ENOTEMPTY') dom('InvalidModificationError');
    take(result);
  }
}
describe('FileSystemDirectoryHandle provider without a browser', () => {
  it('reads directories and ranges, mapping type, missing and permission failures', async () => {
    const root = new Folder();
    const provider = directoryHandleProvider(root);
    expect(provider.cache).toBe(false);
    expect(await provider.stat('/file.txt')).toEqual(ok({ kind: 'file', size: 6, mtimeMs: 123 }));
    expect(await provider.readdir('/')).toEqual(
      ok([
        { name: 'file.txt', kind: 'file' },
        { name: 'sub', kind: 'dir' },
      ]),
    );
    const file = take(await provider.open('/file.txt'));
    expect(text(take(await file.read(2, 3)))).toBe('cde');
    expect(await provider.open('/sub')).toEqual({ ok: false, error: { code: 'EISDIR' } });
    expect(await provider.readdir('/file.txt')).toEqual({ ok: false, error: { code: 'ENOTDIR' } });
    expect(await provider.stat('/missing')).toEqual({ ok: false, error: { code: 'ENOENT' } });
    expect(await provider.stat('/../file.txt')).toEqual({ ok: false, error: { code: 'EINVAL' } });
    root.denied = true;
    expect(await provider.stat('/file.txt')).toEqual({ ok: false, error: { code: 'EACCES' } });
  });
  it('commits writes without destroying other bytes, truncates, creates, removes and feature-detects rename', async () => {
    const root = new Folder();
    const provider = directoryHandleProvider(root);
    expect(await provider.write?.('/file.txt', 2, encode('XX'))).toEqual(ok(2));
    expect(text(take(root.memory.fs.readFile('/file.txt')))).toBe('abXXef');
    expect(root.writes).toBe(1);
    expect(await provider.truncate?.('/file.txt', 3)).toEqual(ok(undefined));
    expect(text(take(root.memory.fs.readFile('/file.txt')))).toBe('abX');
    expect(await provider.create?.('/created')).toEqual(ok(undefined));
    expect(await provider.mkdir?.('/dir')).toEqual(ok(undefined));
    expect(await provider.mkdir?.('/dir')).toEqual({ ok: false, error: { code: 'EEXIST' } });
    expect(await provider.rename?.('/created', '/dir/new')).toEqual({
      ok: false,
      error: { code: 'ENOSYS' },
    });
    root.movable = true;
    expect(await provider.rename?.('/created', '/dir/new')).toEqual(ok(undefined));
    expect(await provider.remove?.('/dir')).toEqual({ ok: false, error: { code: 'ENOTEMPTY' } });
    expect(await provider.remove?.('/dir/new')).toEqual(ok(undefined));
    expect(await provider.remove?.('/dir')).toEqual(ok(undefined));
    root.failWrite = true;
    expect(await provider.write?.('/file.txt', 0, encode('bad'))).toEqual({
      ok: false,
      error: { code: 'ENOSPC' },
    });
    expect(text(take(root.memory.fs.readFile('/file.txt')))).toBe('abX');
  });
  it('can mount read-only, and cache:false reflects outside edits through the same descriptor', async () => {
    const root = new Folder();
    const provider = directoryHandleProvider(root, { readOnly: true });
    expect(provider.write).toBeUndefined();
    const vfs = new MountedVfs(undefined, undefined, { '/picked': provider });
    const flags = {
      access: 'read' as const,
      append: false,
      create: false,
      exclusive: false,
      truncate: false,
    };
    const fd = take(await vfs.files.async.open('/picked/file.txt', flags));
    const b = new Uint8Array(20);
    expect(await vfs.files.async.read(fd, b, 0n)).toEqual(ok(6));
    take(root.memory.fs.writeFile('/file.txt', encode('outside')));
    expect(await vfs.files.async.read(fd, b, 0n)).toEqual(ok(7));
    expect(text(b.subarray(0, 7))).toBe('outside');
    expect(await vfs.files.async.open('/picked/file.txt', { ...flags, access: 'write' })).toEqual({
      ok: false,
      error: { code: 'EROFS' },
    });
    vfs.files.close(fd);
  });
});
