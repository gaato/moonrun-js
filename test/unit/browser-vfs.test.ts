import { describe, expect, it } from 'vitest';
import { MemoryVfs } from '../../src/hosts/browser/vfs.ts';
import type { OpenFlags } from '../../src/ports/files.ts';
import type { HostError, Result } from '../../src/ports/result.ts';

const utf8 = new TextEncoder();
const flags: OpenFlags = {
  access: 'readWrite',
  create: true,
  exclusive: false,
  append: false,
  truncate: false,
};
function value<T>(r: Result<T, HostError>): T {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
function code<T>(r: Result<T, HostError>): string {
  if (r.ok) throw new Error('expected error');
  return r.error.code;
}

describe('browser memory VFS', () => {
  it('preloads nested files/directories, copies byte ownership, and resolves a writable cwd', () => {
    const bytes = utf8.encode('hello');
    const { fs, files } = new MemoryVfs({ 'sub/a': bytes, empty: null });
    bytes.fill(0);
    expect(fs.cwd()).toEqual({ ok: true, value: '/work' });
    expect(fs.resolve('../work/./sub/../a')).toBe('/work/a');
    expect(value(fs.readFile('sub/a'))).toEqual(utf8.encode('hello'));
    const copy = value(fs.readFile('sub/a'));
    copy.fill(0);
    expect(value(fs.readFile('/work/sub/a'))).toEqual(utf8.encode('hello'));
    expect(value(fs.readDir('.'))).toEqual(['sub', 'empty']);
    expect(value(files.stat('sub')).kind).toBe('dir');
    expect(fs.writeFile('new', utf8.encode('ok')).ok).toBe(true);
    expect(code(fs.readFile('missing'))).toBe('ENOENT');
    expect(code(fs.writeFile('missing/a', bytes))).toBe('ENOENT');
    expect(code(files.stat('new/a'))).toBe('ENOTDIR');
  });
  it('shares whole-file and fd state, supports positioned writes, sparse growth, append and truncate', () => {
    const { fs, files } = new MemoryVfs();
    const fd = value(files.open('a', flags));
    expect(value(files.write(fd, utf8.encode('AB')))).toBe(2);
    expect(value(files.write(fd, utf8.encode('Z'), 4n))).toBe(1);
    expect(value(fs.readFile('a'))).toEqual(new Uint8Array([65, 66, 0, 0, 90]));
    const buffer = new Uint8Array(8);
    expect(value(files.read(fd, buffer))).toBe(3); // pwrite did not move offset 2
    expect(buffer.slice(0, 3)).toEqual(new Uint8Array([0, 0, 90]));
    value(files.truncate(fd, 1n));
    const append = value(files.open('a', { ...flags, append: true }));
    value(files.write(append, utf8.encode('!'), 0n));
    expect(value(fs.readFile('a'))).toEqual(utf8.encode('A!'));
    expect(value(files.fstat(fd)).size).toBe(2n);
    expect(code(files.truncate(fd, -1n))).toBe('EINVAL');
    expect(code(files.truncate(fd, 64n * 1024n * 1024n + 1n))).toBe('EFBIG');
    value(files.close(fd));
    expect(code(files.read(fd, buffer))).toBe('EBADF');
    const ro = value(files.open('a', { ...flags, access: 'read' }));
    expect(code(files.write(ro, buffer))).toBe('EBADF');
    expect(code(files.open('a', { ...flags, exclusive: true }))).toBe('EEXIST');
    expect(code(files.open('a', { ...flags, directory: true }))).toBe('ENOTDIR');
  });
  it('retains inodes and descriptors through rename, replacement and unlink', () => {
    const { fs, files } = new MemoryVfs({ a: 'first', b: 'second', tree: null });
    const a = value(files.open('a', flags));
    const b = value(files.open('b', flags));
    const inode = value(files.fstat(a)).ino;
    value(files.rename('a', 'b'));
    expect(value(files.stat('b')).ino).toBe(inode);
    expect(value(files.fstat(b)).nlink).toBe(0n);
    value(files.unlink('b'));
    expect(value(files.fstat(a)).nlink).toBe(0n);
    const buffer = new Uint8Array(5);
    value(files.read(a, buffer));
    expect(buffer).toEqual(utf8.encode('first'));
    expect(code(files.rename('tree', 'tree/nested'))).toBe('EINVAL');
    value(fs.mkdirAll('tree/nested'));
    expect(code(files.rmdir('tree'))).toBe('ENOTEMPTY');
    expect(code(files.unlink('tree'))).toBe('EISDIR');
    value(fs.removeDirAll('tree'));
    expect(code(files.stat('tree'))).toBe('ENOENT');
  });
  it('follows symlinks physically, reports lstat/readlink and bounds loops', () => {
    const { fs, files } = new MemoryVfs({ 'dir/deep': null, 'dir/data': 'data' });
    value(files.symlink('dir/deep', 'link'));
    expect(value(files.realpath('link/..'))).toBe('/work/dir');
    expect(value(fs.readFile('link/../data'))).toEqual(utf8.encode('data'));
    expect(value(files.lstat('link')).kind).toBe('symlink');
    expect(value(files.readLink('link'))).toEqual(utf8.encode('dir/deep'));
    expect(code(files.open('link', { ...flags, create: false, noFollow: true }))).toBe('ELOOP');
    value(files.symlink('new-target', 'dangling'));
    expect(code(files.open('dangling', { ...flags, exclusive: true }))).toBe('EEXIST');
    value(fs.writeFile('dangling', utf8.encode('created')));
    expect(value(fs.readFile('new-target'))).toEqual(utf8.encode('created'));
    value(files.symlink('loop', 'loop'));
    expect(code(files.stat('loop'))).toBe('ELOOP');
    expect(code(files.stat('dir/data/'))).toBe('ENOTDIR');
  });
  it('implements async directory/stat/chmod ports and rejects unsupported watches', async () => {
    const { files } = new MemoryVfs({ 'dir/a': 'a', 'dir/empty': null });
    const fd = value(files.async.openPath('dir'));
    const ino = value(files.stat('dir/a')).ino;
    const reader = value(await files.async.openDirectory(fd));
    expect(value(await reader.next())).toEqual({ ino, type: 8, name: utf8.encode('a') });
    expect(value(await reader.next())?.type).toBe(4);
    expect(value(await reader.next())).toBe(null);
    reader.close();
    expect(code(await reader.next())).toBe('EBADF');
    value(files.rename('dir', 'moved'));
    expect(value(await files.async.statAt(fd, 'a', true)).ino).toBe(ino);
    value(await files.async.chmod('moved/a', 0o400));
    expect(code(await files.async.access('moved/a', 'write'))).toBe('EACCES');
    expect(code(files.async.watch('moved/a', () => {}))).toBe('ENOSYS');
  });
});
