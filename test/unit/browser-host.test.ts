import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteEngine } from '../../src/domains/sqlite/engine.ts';
import { executeBrowserRun, type WorkerReply } from '../../src/hosts/browser/execute.ts';
import { createBrowserHost } from '../../src/hosts/browser/host.ts';
import { runInWorker } from '../../src/hosts/browser/index.ts';
import { take } from '../../src/hosts/browser/mount-provider.ts';
import { compileBytes, run } from '../../src/index.ts';
import { fakeMount } from './mount-fakes.ts';

const assets: Readonly<Record<string, string>> = {
  'moonrun-diag.wasm': 'diagnostics/moonrun-diag.wasm',
  'moonrun-policy.wasm': 'domains/policy/moonrun-policy.wasm',
  'tls-engine.wasm': 'domains/tls/tls-engine.wasm',
  'sqlite-engine.wasm': 'domains/sqlite/sqlite-engine.wasm',
};
function wat(name: string): Uint8Array {
  const result = spawnSync('wasm-tools', [
    'parse',
    new URL(`../wat/${name}.wat`, import.meta.url).pathname,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return new Uint8Array(result.stdout);
}
function stubAssets(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: URL | string | Request) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const name = url.split('/').at(-1) ?? '';
    const file = assets[name];
    if (file === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(
      new Uint8Array(await readFile(new URL(`../../src/${file}`, import.meta.url))),
    );
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}
afterEach(() => vi.unstubAllGlobals());

describe('browser host under Node Web APIs', () => {
  it('canonicalizes a cwd reached through a mounted symlink', async () => {
    stubAssets();
    const { provider, memory } = fakeMount({ 'dir/file': 'data' });
    take(memory.files.symlink('dir', '/alias'));
    const host = await createBrowserHost({ cwd: '/mnt/alias', mounts: { '/mnt': provider } });
    expect(host.fs.cwd()).toEqual({ ok: true, value: '/mnt/dir' });
    const fd = take(
      await host.files.async.open('file', {
        access: 'read',
        create: false,
        append: false,
        exclusive: false,
        truncate: false,
      }),
    );
    expect(take(await host.files.async.fstat(fd)).size).toBe(4n);
    host.files.close(fd);
  });
  for (const legacy of [false, true]) {
    it(`${legacy ? 'legacy' : 'WASI'} synchronous paths see mounts only after async caching`, async () => {
      const source = legacy
        ? `(module
        (import "_" "/work/mnt/data.txt" (global $path externref))
        (import "__moonbit_fs_unstable" "read_file_to_string" (func $read (param externref) (result externref)))
        (func (export "_start") global.get $path call $read drop))`
        : `(module
        (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
        (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
        (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
        (memory (export "memory") 1)
        (data (i32.const 0) "mnt/data.txt")
        (func (export "_start") (local $error i32)
          (local.set $error (call $open (i32.const 3) (i32.const 1) (i32.const 0) (i32.const 12) (i32.const 0) (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 32)))
          (if (local.get $error) (then (call $exit (local.get $error))))
          (i32.store (i32.const 40) (i32.const 128)) (i32.store (i32.const 44) (i32.const 5))
          (local.set $error (call $read (i32.load (i32.const 32)) (i32.const 40) (i32.const 1) (i32.const 48)))
          (if (local.get $error) (then (call $exit (local.get $error))))
          (if (i32.ne (i32.load (i32.const 48)) (i32.const 5)) (then unreachable))
          (if (i32.ne (i32.load (i32.const 128)) (i32.const 0x6c6c6568)) (then unreachable))
          (if (i32.ne (i32.load8_u (i32.const 132)) (i32.const 111)) (then unreachable))))`;
      const compiled = spawnSync('wasm-tools', ['parse', '-'], { input: source });
      if (compiled.status !== 0) throw new Error(compiled.stderr.toString());
      for (const cached of [false, true]) {
        stubAssets();
        const { provider } = fakeMount({ 'data.txt': 'hello' });
        let stderr = '';
        const host = await createBrowserHost({
          mounts: { '/work/mnt': provider },
          stderr: (b) => {
            stderr += new TextDecoder().decode(b);
          },
        });
        if (cached) {
          const fd = take(
            await host.files.async.open('/work/mnt/data.txt', {
              access: 'read',
              create: false,
              append: false,
              exclusive: false,
              truncate: false,
            }),
          );
          take(await host.files.async.read(fd, new Uint8Array(5)));
          take(host.files.close(fd));
        }
        const outcome = await host.run(new Uint8Array(compiled.stdout));
        expect(outcome).toEqual(
          cached
            ? { kind: 'completed' }
            : legacy
              ? { kind: 'signaled', signal: 6 }
              : { kind: 'exited', code: 6 },
        );
        if (!cached && legacy) expect(stderr).toContain('Failed to read file: /work/mnt/data.txt');
      }
    });
  }
  it('precompiles all four components, uses byte callbacks/input and per-run environment', async () => {
    const fetch = stubAssets();
    const host = await createBrowserHost({
      env: { TEST: 'value' },
      stdin: new TextEncoder().encode('input'),
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(host.components.policy()).toEqual(host.components.policy());
    host.env.set('LOCAL', 'yes');
    host.env.unset('TEST');
    expect(host.env.entries()).toEqual([['LOCAL', 'yes']]);
    const buffer = new Uint8Array(3);
    expect(host.stdio.readStdin(buffer)).toBe(3);
    expect(new TextDecoder().decode(buffer)).toBe('inp');
    expect(await host.stdio.readStdinAsync(buffer)).toBe(2);
    expect(host.stdio.readStdin(buffer)).toBe(0);
    const random = new Uint8Array(131073);
    host.random.fill(random);
    expect(random.some((b) => b !== 0)).toBe(true);
    expect(host.clock.monotonicNs()).toBeGreaterThanOrEqual(0n);
    expect(
      await host.process.spawn({
        program: 'x',
        argv: [],
        env: [],
        cwd: undefined,
        stdio: [{ kind: 'inherit' }, { kind: 'inherit' }, { kind: 'inherit' }],
        extraFds: [],
      }),
    ).toEqual({ ok: false, error: { code: 'ENOSYS' } });
    expect(host.process.kill(0, 0)).toEqual({ ok: false, error: { code: 'ENOSYS' } });
    expect(host.process.openPolicyTransfer(buffer)).toEqual({
      ok: false,
      error: { code: 'ENOSYS' },
    });
    expect(host.signals.capture(2, () => {})()).toBeUndefined();
    expect(() => host.signals.raise(2)).toThrow('ENOSYS');
    expect(host.trustStore.systemRoots()).toEqual({ ok: true, value: [] });
  });
  it('runs a guest with browser args/env, streams both byte outputs and reports exit', async () => {
    stubAssets();
    let output = '';
    const host = await createBrowserHost({
      env: { TEST: 'value' },
      stdout: (b) => {
        output += new TextDecoder().decode(b);
      },
    });
    const loaded = compileBytes(wat('wasi-args-env'), '/work/guest.wasm', host.diagnostics);
    if (!loaded.ok) throw new Error(loaded.error.chain.join(': '));
    expect(await run(loaded.value, host, { args: ['arg', '日本語'] })).toEqual({
      kind: 'completed',
    });
    expect(output).toContain('/work/guest.wasm\narg\n日本語\n');
    expect(output).toContain('TEST=value\n');
    const replies: WorkerReply[] = [];
    await executeBrowserRun(
      { wasm: wat('wasi-stdio'), stdin: new TextEncoder().encode('browser input\n') },
      (r) => replies.push(r),
    );
    expect(replies.at(-1)).toEqual({ type: 'outcome', outcome: { kind: 'completed' } });
    const text = (type: string): string =>
      replies
        .flatMap((r) =>
          r.type === type && 'bytes' in r ? [new TextDecoder().decode(r.bytes)] : [],
        )
        .join('');
    expect(text('stdout')).toContain('hello world\n');
    expect(text('stdout')).toContain('browser input\n');
    expect(text('stderr')).toBe('err!\n');
    const exits: WorkerReply[] = [];
    await executeBrowserRun({ wasm: wat('wasi-exit'), args: ['37'] }, (r) => exits.push(r));
    expect(exits.at(-1)).toEqual({ type: 'outcome', outcome: { kind: 'exited', code: 37 } });
  });
  it('loads relay roots before running and permits an explicit trust-store override', async () => {
    const assets = stubAssets();
    const assetFetch = globalThis.fetch;
    const rootUrls: string[] = [];
    vi.stubGlobal('fetch', async (input: URL) => {
      if (input.pathname === '/roots') {
        rootUrls.push(input.href);
        return new Response('["AAEC"]');
      }
      return assetFetch(input);
    });
    const host = await createBrowserHost({ relay: 'ws://relay.invalid/relay?token=test' });
    expect(rootUrls).toEqual(['http://relay.invalid/roots?token=test']);
    expect(host.trustStore.systemRoots()).toEqual({ ok: true, value: [new Uint8Array([0, 1, 2])] });
    await createBrowserHost({ relay: 'ws://relay.invalid/relay?token=test', roots: [] });
    expect(rootUrls).toHaveLength(1);
    expect(assets).toHaveBeenCalledTimes(8);
  });
  it('commits SQLite data through the memory FilePort and reopens the database', async () => {
    stubAssets();
    const host = await createBrowserHost();
    const module = host.components.sqliteEngine();
    if (!module.ok) throw new Error(module.error.code);
    const engine = new SqliteEngine(module.value, host, { authorize: () => 0, progress: () => 0 });
    const open = (): number => {
      const name = engine.allocate(new TextEncoder().encode('/work/test.db'), 1);
      const out = engine.scratch(4);
      expect(engine.x.sqlite3_open_v2(name.ptr, out, 6, 0)).toBe(0);
      name.free();
      return engine.u32(out);
    };
    const exec = (db: number, sql: string): bigint => {
      const text = new Uint16Array(sql.length);
      for (let i = 0; i < sql.length; i++) text[i] = sql.charCodeAt(i);
      const input = engine.allocate(new Uint8Array(text.buffer), 2);
      const out = engine.scratch(8);
      expect(engine.x.sqlite3_prepare16_v2(db, input.ptr, text.byteLength, out, out + 4)).toBe(0);
      input.free();
      const stmt = engine.u32(out);
      const code = engine.x.sqlite3_step(stmt);
      expect(code).toBe(sql.startsWith('SELECT') ? 100 : 101);
      const result = code === 100 ? engine.x.sqlite3_column_int64(stmt, 0) : 0n;
      expect(engine.x.sqlite3_finalize(stmt)).toBe(0);
      return result;
    };
    let db = open();
    try {
      exec(db, 'CREATE TABLE t(n)');
      exec(db, 'INSERT INTO t VALUES(42)');
      expect(engine.x.sqlite3_close(db)).toBe(0);
      db = open();
      expect(exec(db, 'SELECT n FROM t')).toBe(42n);
      const file = host.fs.readFile('test.db');
      if (!file.ok) throw new Error(file.error.code);
      expect(new TextDecoder().decode(file.value.subarray(0, 15))).toBe('SQLite format 3');
    } finally {
      engine.x.sqlite3_close(db);
      engine.vfs.closeAll();
    }
  });
  it('turns preparation/compile failures into an outcome', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const replies: WorkerReply[] = [];
    await executeBrowserRun({ wasm: new Uint8Array() }, (r) => replies.push(r));
    expect(replies).toMatchObject([{ type: 'outcome', outcome: { kind: 'host-failure' } }]);
    stubAssets();
    replies.length = 0;
    await executeBrowserRun({ wasm: new Uint8Array() }, (r) => replies.push(r));
    expect(replies).toMatchObject([{ type: 'outcome', outcome: { kind: 'host-failure' } }]);
  });
  it('runs the real Worker entry using a Node transport bridge and terminates it', async () => {
    let terminated = false;
    // Node has no Web Worker constructor. Only the transport and file: asset fetch differ.
    class WorkerBridge {
      onmessage: ((e: { data: WorkerReply }) => void) | null = null;
      onerror: ((e: { message: string }) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      readonly worker: NodeWorker;
      constructor(url: URL, options: { type: string }) {
        expect(options.type).toBe('module');
        const entry = url.href.replace(/\.js$/, '.ts');
        const src = new URL('../../src/', import.meta.url).href;
        this.worker = new NodeWorker(
          `
          const { parentPort } = require('node:worker_threads');
          const { readFile } = require('node:fs/promises');
          globalThis.fetch = async (input) => {
            const name = String(input).split('/').at(-1);
            const file = ${JSON.stringify(assets)}[name];
            if (!file) throw new Error('unknown asset');
            return new Response(new Uint8Array(await readFile(new URL(file, ${JSON.stringify(src)}))));
          };
          globalThis.postMessage = (data) => parentPort.postMessage(data);
          import(${JSON.stringify(entry)}).then(() => parentPort.on('message', (data) => globalThis.onmessage({ data })));
        `,
          { eval: true, execArgv: [] },
        );
        this.worker.on('message', (data: WorkerReply) => this.onmessage?.({ data }));
        this.worker.on('error', (e) => this.onerror?.({ message: e.message }));
      }
      postMessage(data: unknown): void {
        this.worker.postMessage(data);
      }
      terminate(): void {
        terminated = true;
        void this.worker.terminate();
      }
    }
    vi.stubGlobal('Worker', WorkerBridge);
    let stderr = '';
    const result = await runInWorker({
      wasm: wat('wasi-stdio'),
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    expect(result).toEqual({ kind: 'completed' });
    expect(stderr).toBe('err!\n');
    expect(terminated).toBe(true);
  });
});
