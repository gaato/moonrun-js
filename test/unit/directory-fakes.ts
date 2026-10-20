import type { BrowserDirectoryHandle } from '../../src/hosts/browser/directory-provider.ts';
import { take } from '../../src/hosts/browser/mount-provider.ts';
import { MemoryVfs } from '../../src/hosts/browser/vfs.ts';

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const dom = (name: string): never => {
  throw new DOMException(name, name);
};
export class Folder implements BrowserDirectoryHandle {
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
