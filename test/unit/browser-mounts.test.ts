import { describe, expect, it } from 'vitest';
import { take } from '../../src/hosts/browser/mount-provider.ts';
import { MountServer, proxyMounts } from '../../src/hosts/browser/mount-rpc.ts';
import { MountedVfs } from '../../src/hosts/browser/mounted-vfs.ts';
import { AsyncKernel } from '../../src/kernel/async-kernel.ts';
import { OPEN_IDENTITY_REQUEST } from '../../src/kernel/fs-codec.ts';
import { unsupportedDns, unsupportedNet } from '../../src/kernel/net-unsupported.ts';
import { ok, type Result } from '../../src/ports/result.ts';
import { FakeScheduler, memoryStdio } from './kernel-fakes.ts';
import { fakeMount } from './mount-fakes.ts';

const flags = {
  access: 'read' as const,
  append: false,
  create: false,
  exclusive: false,
  truncate: false,
};
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
describe('async browser mounts', () => {
  it('restricts live additions to memory, including physical parent symlinks and mount boundaries', () => {
    const { provider, calls } = fakeMount({ file: 'provider' }, { cache: false });
    const vfs = new MountedVfs(undefined, undefined, { '/mnt/local': provider });
    take(vfs.files.symlink('/mnt/local', '/work/alias'));
    for (const path of [
      '/mnt/local/file',
      '/mnt/local/new/file',
      '/work/alias/file',
      '/work/alias/../outside',
    ]) {
      expect(vfs.memory({ kind: 'writeFile', path, data: 'blocked' })).toEqual({
        ok: false,
        error: { code: 'EROFS' },
      });
    }
    expect(calls).toEqual([]);
    expect(
      vfs.memory({ kind: 'writeFile', path: '/mnt/locality/new/file', data: 'memory' }),
    ).toEqual(ok(undefined));
    expect(text(take(vfs.fs.readFile('/mnt/locality/new/file')))).toBe('memory');
    const rooted = new MountedVfs(undefined, undefined, { '/': provider });
    expect(rooted.memory({ kind: 'writeFile', path: '/work/file', data: 'blocked' })).toEqual({
      ok: false,
      error: { code: 'EROFS' },
    });
    expect(calls).toEqual([]);
  });
  it('preserves memory directory descriptors across rename and protects mount ancestors', async () => {
    const { provider } = fakeMount({ file: 'data' });
    const vfs = new MountedVfs({ 'old/file': 'memory' }, undefined, { '/mnt/local': provider });
    const fd = take(await vfs.files.async.open('/work/old', flags));
    const ino = take(await vfs.files.async.statAt(fd, 'file', true)).ino;
    expect(await vfs.files.async.rename('/work/old', '/work/new')).toEqual(ok(undefined));
    expect(take(await vfs.files.async.statAt(fd, 'file', true)).ino).toBe(ino);
    take(vfs.files.rename('/work/new', '/work/renamed'));
    expect(take(await vfs.files.async.statAt(fd, 'file', true)).ino).toBe(ino);
    take(await vfs.files.async.chmod('/work/renamed/file', 0o444));
    expect(vfs.files.access('/work/renamed/file', 'write')).toEqual({
      ok: false,
      error: { code: 'EACCES' },
    });
    expect(vfs.fs.removeDirAll('/mnt')).toEqual({ ok: false, error: { code: 'EBUSY' } });
    expect(await vfs.files.async.rename('/mnt', '/other')).toEqual({
      ok: false,
      error: { code: 'EBUSY' },
    });
    vfs.files.close(fd);
  });
  it('overlays parent listings, picks the longest boundary prefix, and follows symlinks across mounts', async () => {
    const outer = fakeMount({ file: 'outer', sub: null });
    const inner = fakeMount({ file: 'inner' });
    const vfs = new MountedVfs({ '/mnt/locality': 'memory' }, undefined, {
      '/mnt/local': outer.provider,
      '/mnt/local/sub/deep': inner.provider,
    });
    expect(take(vfs.fs.readDir('/mnt'))).toEqual(['locality', 'local']);
    expect(text(take(vfs.fs.readFile('/mnt/locality')))).toBe('memory');
    take(vfs.files.symlink('/mnt/local/sub/deep/file', '/work/alias'));
    const fd = take(await vfs.files.async.open('/work/alias', flags));
    const buffer = new Uint8Array(64);
    expect(await vfs.files.async.read(fd, buffer)).toEqual(ok(5));
    expect(text(buffer.subarray(0, 5))).toBe('inner');
    expect(text(take(await vfs.files.async.realpath('/work/alias')))).toBe(
      '/mnt/local/sub/deep/file',
    );
    expect(inner.calls.some((c) => c.path === '/file')).toBe(true);
    expect(outer.calls.some((c) => c.path.includes('deep/file'))).toBe(false);
    const dir = take(await vfs.files.async.open('/mnt/local/sub', flags));
    const stream = take(await vfs.files.async.openDirectory(dir));
    const entry = take(await stream.next());
    expect(entry && text(entry.name)).toBe('deep');
    expect(entry?.ino).toBe(take(await vfs.files.async.statAt(dir, 'deep', true)).ino);
    expect(await vfs.files.async.statAt(fd, '..', true)).toEqual({
      ok: false,
      error: { code: 'ENOTDIR' },
    });
    stream.close();
    vfs.files.close(fd);
    vfs.files.close(dir);
  });
  it('exposes only cached synchronous content, keeps ranged reads bounded, and shares dup offsets', async () => {
    const { provider, calls } = fakeMount({ file: 'abcdef' });
    const vfs = new MountedVfs(undefined, undefined, { '/mnt': provider });
    expect(vfs.fs.readFile('/mnt/file')).toEqual({ ok: false, error: { code: 'EAGAIN' } });
    const fd = take(await vfs.files.async.open('/mnt/file', flags));
    const copy = take(vfs.duplicate(fd));
    const b = new Uint8Array(3);
    expect(await vfs.files.async.read(fd, b)).toEqual(ok(3));
    expect(text(b)).toBe('abc');
    expect(vfs.fs.readFile('/mnt/file')).toEqual({ ok: false, error: { code: 'EAGAIN' } });
    expect(await vfs.files.async.read(copy, b)).toEqual(ok(3));
    expect(text(b)).toBe('def');
    expect(text(take(vfs.fs.readFile('/mnt/file')))).toBe('abcdef');
    expect(calls.filter((c) => c.op === 'read').map((c) => [c.offset, c.length])).toEqual([
      [0, 3],
      [3, 3],
    ]);
    const stat = take(await vfs.files.async.fstat(copy));
    expect(stat.mode).toBe(0o100444n);
    expect(stat.mtimeNs).toBe(1234000000n);
    expect(take(vfs.files.stat('/mnt/file')).ino).toBe(stat.ino);
    expect(await vfs.files.async.open('/mnt/file', { ...flags, access: 'write' })).toEqual({
      ok: false,
      error: { code: 'EROFS' },
    });
    expect(vfs.fs.writeFile('/mnt/file', encode('bad'))).toEqual({
      ok: false,
      error: { code: 'EROFS' },
    });
    vfs.files.close(fd);
    expect(calls.some((c) => c.op === 'close')).toBe(false);
    vfs.files.close(copy);
    expect(calls.filter((c) => c.op === 'close')).toHaveLength(1);
  });
  it('can opt out of caching, and maps provider rejections to EIO', async () => {
    const { provider, memory } = fakeMount({ file: 'one' }, { cache: false });
    const vfs = new MountedVfs(undefined, undefined, { '/mnt': provider });
    const fd = take(await vfs.files.async.open('/mnt/file', flags));
    const b = new Uint8Array(8);
    expect(await vfs.files.async.read(fd, b, 0n)).toEqual(ok(3));
    take(memory.fs.writeFile('/file', encode('changed')));
    expect(await vfs.files.async.read(fd, b, 0n)).toEqual(ok(7));
    expect(text(b.subarray(0, 7))).toBe('changed');
    expect(vfs.fs.readFile('/mnt/file')).toEqual({ ok: false, error: { code: 'EAGAIN' } });
    provider.stat = async () => ok({ kind: 'other' });
    expect(
      take(await vfs.files.async.statAt(undefined, '/mnt/special', true)).mode & 0o170000n,
    ).toBe(0n);
    provider.stat = async () => {
      throw new Error('failed');
    };
    expect(await vfs.files.async.statAt(undefined, '/mnt/file', true)).toEqual({
      ok: false,
      error: { code: 'EIO' },
    });
    provider.stat = async () => {
      throw new DOMException('failed', 'NotFoundError');
    };
    expect(await vfs.files.async.statAt(undefined, '/mnt/file', true)).toEqual({
      ok: false,
      error: { code: 'EIO' },
    });
    vfs.files.close(fd);
  });
  it('persists optional writes, invalidates caches, and rejects cross-mount rename', async () => {
    const { provider, memory } = fakeMount({ file: 'old' }, { writable: true });
    const vfs = new MountedVfs(undefined, undefined, { '/mnt': provider });
    const fd = take(
      await vfs.files.async.open('/mnt/file', { ...flags, access: 'readWrite', truncate: true }),
    );
    expect(await vfs.files.async.write(fd, encode('new'))).toEqual(ok(3));
    expect(text(take(memory.fs.readFile('/file')))).toBe('new');
    const b = new Uint8Array(3);
    expect(await vfs.files.async.read(fd, b, 0n)).toEqual(ok(3));
    expect(text(b)).toBe('new');
    expect(take(await vfs.files.async.fstat(fd)).mode).toBe(0o100644n);
    const other = take(
      await vfs.files.async.open('/mnt/file', { ...flags, access: 'write', append: true }),
    );
    const append = take(
      await vfs.files.async.open('/mnt/file', { ...flags, access: 'write', append: true }),
    );
    expect(
      await Promise.all([
        vfs.files.async.write(other, encode('1')),
        vfs.files.async.write(append, encode('2')),
      ]),
    ).toEqual([ok(1), ok(1)]);
    expect(text(take(memory.fs.readFile('/file')))).toBe('new12');
    vfs.files.close(other);
    vfs.files.close(append);
    expect(
      await vfs.files.async.open('/mnt/file', {
        ...flags,
        access: 'write',
        truncate: true,
        directory: true,
      }),
    ).toEqual({ ok: false, error: { code: 'ENOTDIR' } });
    expect(text(take(memory.fs.readFile('/file')))).toBe('new12');
    expect(await vfs.files.async.mkdir('/mnt/sub', 0o700)).toEqual(ok(undefined));
    expect(await vfs.files.async.rename('/mnt/file', '/mnt/sub/renamed')).toEqual(ok(undefined));
    expect(text(take(memory.fs.readFile('/sub/renamed')))).toBe('new12');
    expect(await vfs.files.async.rename('/mnt/sub/renamed', '/work/file')).toEqual({
      ok: false,
      error: { code: 'EXDEV' },
    });
    vfs.files.close(fd);
    expect(await vfs.files.async.unlink('/mnt/sub/renamed')).toEqual(ok(undefined));
    expect(await vfs.files.async.rmdir('/mnt/sub')).toEqual(ok(undefined));
    const created = take(
      await vfs.files.async.open('/mnt/created', { ...flags, access: 'write', create: true }),
    );
    vfs.files.close(created);
    expect(
      await vfs.files.async.open('/mnt/created', {
        ...flags,
        access: 'write',
        create: true,
        exclusive: true,
      }),
    ).toEqual({ ok: false, error: { code: 'EEXIST' } });
    const local = take(vfs.files.open('/work/local', { ...flags, create: true, access: 'write' }));
    expect(vfs.files.write(local, encode('memory'))).toEqual(ok(6));
    vfs.files.close(local);
  });
  it('does not interrupt an issued filesystem job while its provider is pending', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider } = fakeMount({ file: 'data' }, { delay: async () => gate });
    const vfs = new MountedVfs(undefined, undefined, { '/mnt': provider });
    const kernel = new AsyncKernel({
      files: vfs.files,
      stdio: memoryStdio(),
      scheduler: new FakeScheduler(),
      stdioKind: () => ok('regular'),
      dns: unsupportedDns,
      net: unsupportedNet,
    });
    const job = kernel.pool.insertJob({
      kind: 'open',
      path: '/mnt/file',
      access: 0,
      create: 0,
      append: false,
      sync: 0,
      mode: 0,
      request: OPEN_IDENTITY_REQUEST,
      result: undefined,
    });
    const poll = kernel.pollCreate();
    value(kernel.initThreadPool(poll));
    const worker = value(kernel.spawnWorker(1, job));
    expect(kernel.pool.cancel(worker)).toEqual(ok('retry-later'));
    expect(kernel.pool.job(job).ok).toBe(false);
    release?.();
    for (let i = 0; i < 1000 && !kernel.pool.job(job).ok; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(value(kernel.pool.job(job)).err).toBeUndefined();
    expect(kernel.openJobFd(job).ok).toBe(true);
    expect(kernel.pool.cancel(worker)).toEqual(ok('need-wait'));
    kernel.teardown();
  });
  it('proxies ranged file handles and releases late opens on Worker termination', async () => {
    const { provider, calls } = fakeMount({ file: 'abcdef' });
    const server = new MountServer({ '/mnt': provider });
    const proxy = proxyMounts(server.descriptions, (mount, request) =>
      server.call(mount, structuredClone(request)),
    );
    const remote = proxy['/mnt'];
    if (!remote) throw new Error('missing proxy');
    const file = take(await remote.open('/file'));
    expect(text(take(await file.read(2, 2)))).toBe('cd');
    file.close?.();
    await Promise.resolve();
    expect(calls.some((c) => c.op === 'close')).toBe(true);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = provider.open;
    provider.open = async (path) => {
      await gate;
      return open(path);
    };
    const late = remote.open('/file');
    server.close();
    release?.();
    expect(await late).toEqual({ ok: false, error: { code: 'ECANCELED' } });
    expect(calls.filter((c) => c.op === 'close')).toHaveLength(2);
    expect(await remote.stat('/file')).toEqual({ ok: false, error: { code: 'ECANCELED' } });
  });
});
