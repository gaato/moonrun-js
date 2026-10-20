import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAsyncKernel } from '../../src/abi/async/index.ts';
import { directoryHandleProvider } from '../../src/hosts/browser/directory-provider.ts';
import { createBrowserHost } from '../../src/hosts/browser/host.ts';
import { MemoryVfs } from '../../src/hosts/browser/vfs.ts';
import { OPEN_IDENTITY_REQUEST } from '../../src/kernel/fs-codec.ts';
import type { FilesystemPayload } from '../../src/kernel/job.ts';
import { acquire } from '../../src/kernel/resource.ts';
import type { Result } from '../../src/ports/result.ts';
import { Folder } from './directory-fakes.ts';
import { fakeMount } from './mount-fakes.ts';

const root = new URL('../../', import.meta.url);
const cache = new URL('.cache/browser-shell/', root);
const nativeFetch = globalThis.fetch;
const hashes = {
  sh: '362fa346d75afaa0744739b0fb29c158e2873487b5daa7b8ecedf2ff70d25153',
  cat: '0077933f172648eee22f902f14c83ca6c732afda50d1a7c1c47163ec4e587374',
  ls: 'a9cefa72d5504acd98396a84c00192e12d18458cf4baef17aae26adc66124dc0',
  cp: '49b588fd6d9e0e801324565fa982e69473b2d1d11042b7b1bf04b6047cef0efb',
  head: '5755b581894044882ddbaba6a636b91372b050f69329a22925565519fe07da26',
  wc: '4d6d3305006f692a7a1d98a866da141ca410572f7520590ebe0c233f9d58e3b0',
  sort: '2b605186e7ae3481fd63ba4452f9fe25820f805fe83b45392a07ca2dcdbd08e9',
};
const modules = new Map<string, Uint8Array>();
beforeAll(async () => {
  await mkdir(cache, { recursive: true });
  for (const [name, hash] of Object.entries(hashes)) {
    const file = new URL(`${name}.wasm`, cache);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file));
    } catch {
      const response = await nativeFetch(
        `https://download.mooncakes.io/prebuild/cli/${name}@0.2.1/${name}.wasm`,
      );
      if (!response.ok) throw new Error(`cannot fetch cli/${name}: ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      await writeFile(file, bytes);
    }
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
    modules.set(name, bytes);
  }
}, 30000);
afterEach(() => vi.unstubAllGlobals());

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const encode = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const data = 'pear\napple\npear\n';
const binary = Uint8Array.from({ length: 4097 }, (_, i) => i % 256);
const assets: Readonly<Record<string, string>> = {
  'moonrun-diag.wasm': 'diagnostics/moonrun-diag.wasm',
  'moonrun-policy.wasm': 'domains/policy/moonrun-policy.wasm',
  'tls-engine.wasm': 'domains/tls/tls-engine.wasm',
  'sqlite-engine.wasm': 'domains/sqlite/sqlite-engine.wasm',
};
function bytes(name: string): Uint8Array {
  const wasm = modules.get(name);
  if (!wasm) throw new Error(name);
  return wasm;
}
function mount(kind: 'uncached' | 'cached' | 'directory') {
  const files = { data, '.added/x.wasm': binary };
  if (kind !== 'directory') return fakeMount(files, { cache: kind === 'cached', writable: true });
  const memory = new MemoryVfs(files, '/');
  return { provider: directoryHandleProvider(new Folder(memory)), memory };
}
async function setup(kind: 'uncached' | 'cached' | 'directory') {
  vi.stubGlobal('fetch', async (input: URL) => {
    const file = assets[input.pathname.split('/').at(-1) ?? ''];
    if (!file) throw new Error('unknown component');
    return new Response(new Uint8Array(await readFile(new URL(`src/${file}`, root))));
  });
  const mounted = mount(kind);
  let stdout = '';
  let stderr = '';
  const host = await createBrowserHost({
    mounts: { '/mnt': mounted.provider },
    env: { MOONBIT_ASYNC_CHECK_FD_LEAK: '1' },
    resolveCommand: async (name) => modules.get(name),
    stdout: (b) => {
      stdout += text(b);
    },
    stderr: (b) => {
      stderr += text(b);
    },
  });
  return { host, ...mounted, output: () => ({ stdout, stderr }) };
}

describe('real cli 0.2.1 guests with browser mounts', () => {
  for (const kind of ['uncached', 'cached', 'directory'] as const) {
    for (const [command, args, expected] of [
      ['cat', ['/mnt/data'], data],
      ['head', ['-n', '2', '/mnt/data'], 'pear\napple\n'],
      ['wc', ['-l', '/mnt/data'], '3 /mnt/data\n'],
      ['sort', ['/mnt/data'], 'apple\npear\npear\n'],
      ['ls', ['/mnt/.added'], 'x.wasm\n'],
    ] as const) {
      it(`${command} reads a ${kind} mount`, async () => {
        const { host, output } = await setup(kind);
        expect(await host.run(bytes(command), { name: command, args })).toEqual({
          kind: 'completed',
        });
        expect(output()).toEqual({ stdout: expected, stderr: '' });
      });
    }
    it(`cp copies binary files in both directions with a ${kind} mount, including child Host views`, async () => {
      const { host, memory, output } = await setup(kind);
      // cli/cp rejects mode preservation through its public async fs API, independently
      // of the Host. Test byte copying with that guest feature disabled.
      expect(
        await host.run(bytes('sh'), {
          name: 'sh',
          args: [
            '-c',
            'cp --no-preserve=mode /mnt/.added/x.wasm /work/x.wasm; echo $?; cp --no-preserve=mode /work/x.wasm /mnt/roundtrip.wasm; echo $?',
          ],
        }),
      ).toEqual({ kind: 'completed' });
      expect(output()).toEqual({ stdout: '0\n0\n', stderr: '' });
      expect(value(host.fs.readFile('/work/x.wasm'))).toEqual(binary);
      expect(value(memory.fs.readFile('/roundtrip.wasm'))).toEqual(binary);
    });
    it(`keeps statx, fstatx, size/time, realpath and access jobs asynchronous with a ${kind} mount`, async () => {
      const { host, memory } = await setup(kind);
      const kernel = createAsyncKernel(host);
      const issue = async (payload: FilesystemPayload) => {
        const handle = kernel.pool.insertJob(payload);
        value(kernel.pool.runJob(handle));
        const deadline = Date.now() + 5000;
        while (!kernel.pool.job(handle).ok) {
          if (Date.now() > deadline) throw new Error('filesystem job did not finish');
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const job = value(kernel.pool.job(handle));
        expect(job.err).toBeUndefined();
        return { handle, job };
      };
      try {
        const opened = await issue({
          kind: 'open',
          path: '/mnt/data',
          access: 0,
          create: 0,
          append: false,
          sync: 0,
          mode: 0,
          request: OPEN_IDENTITY_REQUEST,
          result: undefined,
        });
        const fd = value(kernel.openJobFd(opened.handle));
        const resource = () => acquire(value(kernel.resources.get(fd)));
        // An outside change must be seen on a fresh async fstat for cache:false providers.
        value(memory.fs.writeFile('/data', encode(`${data}changed\n`)));
        const stat = await issue({
          kind: 'fstatx',
          resource: resource(),
          request: OPEN_IDENTITY_REQUEST,
          result: undefined,
        });
        if (stat.job.payload.kind !== 'fstatx') throw new Error('wrong job');
        expect(stat.job.payload.result).toEqual({
          kind: 'regular',
          deviceId: 2n,
          fileId: value(kernel.openJobProperty(opened.handle, 'ino')),
        });
        const size = await issue({ kind: 'file-size', resource: resource(), result: 0n });
        if (size.job.payload.kind !== 'file-size') throw new Error('wrong job');
        expect(size.job.payload.result).toBe(
          BigInt(kind === 'cached' ? data.length : data.length + 8),
        );
        await issue({ kind: 'file-time', resource: resource(), result: undefined });
        await issue({
          kind: 'statx',
          path: '/mnt/data',
          parent: undefined,
          follow: true,
          request: OPEN_IDENTITY_REQUEST,
          result: undefined,
        });
        await issue({ kind: 'access', path: '/mnt/data', access: 1 });
        const canonical = await issue({
          kind: 'realpath',
          path: '/mnt/.added/../data',
          result: undefined,
        });
        if (
          canonical.job.payload.kind !== 'realpath' ||
          canonical.job.payload.result?.state !== 'unpublished'
        )
          throw new Error('missing realpath');
        expect(text(canonical.job.payload.result.bytes)).toBe('/mnt/data\0');
        // The stdio adapter still synthesizes its synchronous metadata.
        for (const raw of [0, 1, 2]) {
          const fd = raw as Parameters<typeof host.files.fstat>[0];
          expect(await host.files.async.fstat(fd)).toEqual(host.files.fstat(fd));
        }
        if (kind !== 'cached') {
          const raw = value(
            await host.files.async.open('/mnt/data', {
              access: 'read',
              append: false,
              create: false,
              exclusive: false,
              truncate: false,
            }),
          );
          try {
            expect(host.files.fstat(raw)).toEqual({ ok: false, error: { code: 'EAGAIN' } });
          } finally {
            host.files.close(raw);
          }
        }
      } finally {
        kernel.teardown();
      }
    });
  }
});
