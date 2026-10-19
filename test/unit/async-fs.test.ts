import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncFailure } from '../../src/abi/async/env.ts';
import { readGuestPath } from '../../src/abi/async/fs.ts';
import { GuestMemory } from '../../src/abi/memory.ts';
import { nodeFiles } from '../../src/hosts/node/files.ts';
import { AsyncKernel } from '../../src/kernel/async-kernel.ts';
import { FileLocks } from '../../src/kernel/file.ts';
import {
  dirEntry,
  direntLength,
  fileTimeRecord,
  IN_IGNORED,
  LayoutFault,
  OPEN_IDENTITY_REQUEST,
  packStat,
  statRequest,
  writeDirent,
} from '../../src/kernel/fs-codec.ts';
import type { Handle } from '../../src/kernel/handles.ts';
import { Inotify } from '../../src/kernel/inotify.ts';
import type { FilesystemPayload } from '../../src/kernel/job.ts';
import { acquire } from '../../src/kernel/resource.ts';
import { ok } from '../../src/ports/result.ts';
import { FakeScheduler, memoryStdio } from './kernel-fakes.ts';

const encoder = new TextEncoder();

describe('generic stat codec', () => {
  it('validates requests like StatRequest::new', () => {
    expect(statRequest(0x0d, 32)).toEqual({ mask: 0x0d, encodedLen: 32 });
    expect(statRequest(0x01, 7)).toBeUndefined();
    expect(statRequest(0x100, 64)).toBeUndefined();
    expect(statRequest(0x30, 39)).toBeUndefined();
    expect(statRequest(0x30, 40)).toEqual({ mask: 0x30, encodedLen: 40 });
    expect(statRequest(-1, 1024)).toBeUndefined();
    expect(OPEN_IDENTITY_REQUEST).toEqual(statRequest(0x0d, 32));
  });

  it('packs slots in bit order and omits unavailable properties from the mask', () => {
    const request = statRequest(0x01 | 0x02 | 0x20 | 0x80, 64);
    expect(request).toBeDefined();
    if (request === undefined) return;
    const bytes = packStat(request, {
      kind: 'directory',
      size: -1n,
      modifyTime: { seconds: 5n, nanoseconds: 7n },
    });
    const view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(8 + 8 + 8 + 16 + 16);
    expect(view.getUint32(0, true)).toBe(bytes.length);
    expect(view.getUint32(4, true)).toBe(0x01 | 0x02 | 0x20);
    expect(view.getBigUint64(8, true)).toBe(2n);
    expect(view.getBigInt64(16, true)).toBe(-1n);
    expect(view.getBigInt64(24, true)).toBe(5n);
    expect(view.getBigInt64(32, true)).toBe(7n);
    expect([...bytes.subarray(40)]).toEqual(new Array(16).fill(0));
  });

  it('lays out the compat FileTime record', () => {
    const t = (s: bigint, n: bigint) => ({ seconds: s, nanoseconds: n });
    const view = new DataView(
      fileTimeRecord({ access: t(1n, 2n), modify: t(3n, 4n), change: t(-5n, 6n) }).buffer,
    );
    expect(view.byteLength).toBe(48);
    expect([view.getBigInt64(0, true), view.getInt32(8, true)]).toEqual([1n, 2]);
    expect([view.getBigInt64(16, true), view.getInt32(24, true)]).toEqual([3n, 4]);
    expect([view.getBigInt64(32, true), view.getInt32(40, true)]).toEqual([-5n, 6]);
  });
});

describe('linux_dirent64', () => {
  it('reads the native getdents64 layout (moonrun dir.rs test)', () => {
    const buf = new Uint8Array(200);
    const view = new DataView(buf.buffer);
    view.setBigUint64(100, 0x0102_0304_0506_0708n, true);
    view.setUint16(116, 24, true);
    buf[118] = 4;
    buf.set(encoder.encode('abc\0'), 119);
    expect(dirEntry.length(buf, 100)).toBe(24);
    expect(dirEntry.nameLen(buf, 100)).toBe(3);
    expect(dirEntry.nameOffset(buf, 100)).toBe(19);
    expect(dirEntry.isDir(buf, 100)).toBe(1);
    expect(dirEntry.isHidden(buf, 100)).toBe(false);
    expect(dirEntry.fileId(buf, 100)).toBe(0x0102_0304_0506_0708n);
  });

  it('writes 8-aligned records the accessors read back', () => {
    const buf = new Uint8Array(64);
    const name = encoder.encode('.hidden');
    const length = writeDirent(buf, 0, { ino: 9n, type: 0, name }, 1n);
    expect(length).toBe(direntLength(name));
    expect(length % 8).toBe(0);
    expect(dirEntry.length(buf, 0)).toBe(length);
    expect(dirEntry.nameLen(buf, 0)).toBe(7);
    expect(dirEntry.isDir(buf, 0)).toBe(-1);
    expect(dirEntry.isHidden(buf, 0)).toBe(true);
    expect(dirEntry.fileId(buf, 0)).toBe(9n);
  });

  it('faults on records outside the buffer', () => {
    const buf = new Uint8Array(24);
    new DataView(buf.buffer).setUint16(16, 32, true);
    expect(() => dirEntry.nameLen(buf, 0)).toThrow(LayoutFault);
    expect(() => dirEntry.fileId(buf, 20)).toThrow(LayoutFault);
  });
});

describe('Guest String Path', () => {
  const memory = new GuestMemory();
  memory.bind(new WebAssembly.Memory({ initial: 1 }));

  it('decodes UTF-16 and rejects misalignment and lone surrogates', () => {
    const units = [0x61, 0xd83d, 0xde00, 0x2f];
    const bytes = new Uint8Array(units.flatMap((u) => [u & 0xff, u >> 8]));
    memory.write(16, bytes);
    expect(readGuestPath(memory, 16, 4)).toBe('a\u{1f600}/');
    expect(() => readGuestPath(memory, 17, 1)).toThrow(new AsyncFailure({ kind: 'fault' }));
    expect(() => readGuestPath(memory, 18, 1)).toThrow(new AsyncFailure({ kind: 'inval' }));
    expect(readGuestPath(memory, 17, 0)).toBe('');
  });
});

describe('flock emulation', () => {
  it('shares, excludes, converts and wakes waiters in order', () => {
    const locks = new FileLocks();
    const a = {};
    const b = {};
    const c = {};
    expect(locks.tryLock('1:2', a, false)).toBe(true);
    expect(locks.tryLock('1:2', b, false)).toBe(true);
    expect(locks.tryLock('1:2', c, true)).toBe(false);
    const granted: string[] = [];
    locks.lock('1:2', c, true, () => granted.push('c'));
    locks.unlock('1:2', a);
    expect(granted).toEqual([]);
    // A conversion drops the existing lock first (as in Linux), which lets the waiter in.
    expect(locks.tryLock('1:2', b, true)).toBe(false);
    expect(granted).toEqual(['c']);
    locks.releaseOwner(b);
    expect(locks.tryLock('1:2', a, false)).toBe(false);
    const cancel = locks.lock('1:2', a, false, () => granted.push('a'));
    cancel();
    locks.unlock('1:2', c);
    expect(granted).toEqual(['c']);
    expect(locks.tryLock('3:4', a, true)).toBe(true);
  });
});

describe('inotify events', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('queues IN_IGNORED on removal and returns whole events only', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'moonrun-js-inotify-'));
    const inotify = new Inotify(nodeFiles());
    const wd = inotify.addWatch(dir, true);
    expect(wd).toEqual(ok(1));
    // The same inode keeps its watch descriptor.
    expect(inotify.addWatch(`${dir}/.`, true)).toEqual(ok(1));
    expect(inotify.addWatch(`${dir}/missing`, false)).toEqual({
      ok: false,
      error: { kind: 'native', code: 'ENOENT' },
    });
    expect(inotify.removeWatch(2)).toEqual({
      ok: false,
      error: { kind: 'native', code: 'EINVAL' },
    });
    expect(inotify.removeWatch(1).ok).toBe(true);
    expect(inotify.poll()).toBe(1);
    expect(inotify.fetch(new Uint8Array(8))).toEqual({ ok: false, error: { kind: 'inval' } });
    const buffer = new Uint8Array(64);
    expect(inotify.fetch(buffer)).toEqual(ok(16));
    const view = new DataView(buffer.buffer);
    expect([view.getInt32(0, true), view.getUint32(4, true)]).toEqual([1, IN_IGNORED]);
    expect(inotify.fetch(buffer)).toEqual(ok(0));
    inotify.close();
  });
});

describe('filesystem Jobs', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(path.join(tmpdir(), 'moonrun-js-fs-'));
    const kernel = new AsyncKernel({
      stdio: memoryStdio(),
      scheduler: new FakeScheduler(),
      stdioKind: () => ok('pipe'),
      files: nodeFiles(),
    });
    const run = async (payload: FilesystemPayload): Promise<Handle> => {
      const job = kernel.pool.insertJob(payload);
      expect(kernel.pool.runJob(job).ok).toBe(true);
      for (let i = 0; i < 1000 && !kernel.pool.job(job).ok; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return job;
    };
    const result = (job: Handle) => {
      const found = kernel.pool.job(job);
      if (!found.ok) throw new Error('job still running');
      return found.value;
    };
    return { dir, kernel, run, result };
  }

  it('opens, lists a directory in getdents64 records and keeps the cursor', async () => {
    const { dir, kernel, run, result } = setup();
    for (const name of ['a', 'bb', 'ccc']) writeFileSync(path.join(dir, name), name);
    const open = await run({
      kind: 'open',
      path: dir,
      access: 3,
      create: 0,
      append: false,
      sync: 0,
      mode: 0,
      request: OPEN_IDENTITY_REQUEST,
      result: undefined,
    });
    expect(result(open).err).toBeUndefined();
    const fd = kernel.openJobFd(open);
    expect(fd.ok).toBe(true);
    if (!fd.ok) return;
    expect(kernel.openJobFd(open)).toEqual(fd);
    expect(kernel.openJobProperty(open, 'kind')).toEqual(ok(2n));
    expect(kernel.kindOfFd(fd.value)).toEqual(ok('directory'));
    const found = kernel.resources.get(fd.value);
    if (!found.ok) return;
    const resource = found.value;
    const buf = kernel.cBuffers.insert(new Uint8Array(1024));
    const names: string[] = [];
    for (let restart = true; ; restart = false) {
      const bytes = kernel.cBuffers.lease(buf);
      if (!bytes.ok) throw new Error('lease');
      const job = await run({
        kind: 'readdir',
        resource: acquire(resource),
        buffer: { handle: buf, bytes: bytes.value },
        // Small enough to need several batches.
        len: 48,
        restart,
      });
      const n = result(job).ret;
      expect(result(job).err).toBeUndefined();
      kernel.pool.freeJob(job);
      const data = kernel.cBuffers.get(buf);
      if (!data.ok) throw new Error('buffer not restored');
      if (n === 0) break;
      for (let at = 0; at < n; at += dirEntry.length(data.value, at)) {
        const start = at + dirEntry.nameOffset(data.value, at);
        names.push(
          new TextDecoder().decode(
            data.value.subarray(start, start + dirEntry.nameLen(data.value, at)),
          ),
        );
      }
    }
    expect(names.slice(0, 2)).toEqual(['.', '..']);
    expect(names.slice(2).sort()).toEqual(['a', 'bb', 'ccc']);
    kernel.pool.freeJob(open);
    expect(kernel.closeFd(fd.value).ok).toBe(true);
  });

  it('matches remove(3), RENAME_NOREPLACE and the NUL-path check', async () => {
    const { dir, run, result } = setup();
    const sub = path.join(dir, 'sub');
    expect(result(await run({ kind: 'mkdir', path: sub, mode: 0o755 })).err).toBeUndefined();
    expect(result(await run({ kind: 'remove', path: sub })).err).toBeUndefined();
    writeFileSync(path.join(dir, 'x'), '');
    writeFileSync(path.join(dir, 'y'), '');
    const noReplace = await run({
      kind: 'rename',
      from: path.join(dir, 'x'),
      to: path.join(dir, 'y'),
      replace: false,
    });
    expect(result(noReplace).err).toEqual({ kind: 'native', code: 'EEXIST' });
    const missing = await run({
      kind: 'rename',
      from: path.join(dir, 'none'),
      to: path.join(dir, 'y'),
      replace: false,
    });
    expect(result(missing).err).toEqual({ kind: 'native', code: 'ENOENT' });
    const nul = await run({ kind: 'access', path: `${dir}\0`, access: 0 });
    expect(result(nul).err).toEqual({ kind: 'inval' });
    const badMode = await run({ kind: 'access', path: dir, access: 4 });
    expect(result(badMode).err).toEqual({ kind: 'inval' });
  });
});
