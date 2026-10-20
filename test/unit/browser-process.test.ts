import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerMessage, WorkerReply } from '../../src/hosts/browser/execute.ts';
import { createBrowserHost } from '../../src/hosts/browser/host.ts';
import { runInWorker } from '../../src/hosts/browser/index.ts';
import { type CommandContext, childExit } from '../../src/hosts/browser/process.ts';
import { BrowserStdin } from '../../src/hosts/browser/streams.ts';
import type { ChildProcess, SpawnRequest } from '../../src/ports/process.ts';
import { fakeMount } from './mount-fakes.ts';

const root = new URL('../../', import.meta.url);
const cache = new URL('.cache/browser-shell/', root);
const nativeFetch = globalThis.fetch;
const hashes: Readonly<Record<string, string>> = {
  sh: '362fa346d75afaa0744739b0fb29c158e2873487b5daa7b8ecedf2ff70d25153',
  tr: '9fbddcf123bd6b5c6b37c01686ab8b7c9b2769d974b3a7be2b589a213f0debf7',
  cat: '0077933f172648eee22f902f14c83ca6c732afda50d1a7c1c47163ec4e587374',
  ls: 'a9cefa72d5504acd98396a84c00192e12d18458cf4baef17aae26adc66124dc0',
  grep: '6c7e3e7a6ff8b76916f7c1085a48fda5085a24366cf63829b437895b95586341',
};
const modules = new Map<string, Uint8Array>();
let scratch: string;
const assets: Readonly<Record<string, string>> = {
  'moonrun-diag.wasm': 'diagnostics/moonrun-diag.wasm',
  'moonrun-policy.wasm': 'domains/policy/moonrun-policy.wasm',
  'tls-engine.wasm': 'domains/tls/tls-engine.wasm',
  'sqlite-engine.wasm': 'domains/sqlite/sqlite-engine.wasm',
};
beforeAll(async () => {
  await mkdir(cache, { recursive: true });
  scratch = await mkdtemp(new URL('tests-', cache).pathname);
  for (const name of ['sh', 'tr', 'cat', 'ls', 'grep']) {
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
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hashes[name]);
      await writeFile(file, bytes);
    }
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hashes[name]);
    modules.set(name, bytes);
  }
  const exit = (code: number): Uint8Array => {
    const result = spawnSync('wasm-tools', ['parse', '-'], {
      input: `(module (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32))) (memory (export "memory") 1) (func (export "_start") i32.const ${code} call $exit))`,
    });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return new Uint8Array(result.stdout);
  };
  modules.set('false', exit(1));
  modules.set('true', exit(0));
  const parent = spawnSync('wasm-tools', [
    'parse',
    new URL('test/fixtures/browser-signal-group.wat', root).pathname,
  ]);
  if (parent.status !== 0) throw new Error(parent.stderr.toString());
  modules.set('signal-parent', new Uint8Array(parent.stdout));
}, 30000);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());
function bytes(name: string): Uint8Array {
  const wasm = modules.get(name);
  if (wasm === undefined) throw new Error(name);
  return wasm;
}
function stubAssets(): void {
  vi.stubGlobal('fetch', async (input: URL) => {
    const file = assets[input.pathname.split('/').at(-1) ?? ''];
    if (file === undefined) throw new Error('unknown component');
    return new Response(new Uint8Array(await readFile(new URL(`src/${file}`, root))));
  });
}
function reference(script: string, input?: Uint8Array, interactive = false) {
  const result = spawnSync(
    process.execPath,
    [
      new URL('bin/moonrun-js', root).pathname,
      new URL('sh.wasm', cache).pathname,
      '--',
      ...(interactive ? ['-i'] : ['-c', script]),
    ],
    {
      cwd: scratch,
      input,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}
async function browser(script: string, stdin?: Uint8Array) {
  stubAssets();
  let stdout = '';
  let stderr = '';
  const requests: { program: string; args: readonly string[]; context: CommandContext }[] = [];
  const host = await createBrowserHost({
    ...(stdin === undefined ? {} : { stdin }),
    stdout: (b) => {
      stdout += new TextDecoder().decode(b);
    },
    stderr: (b) => {
      stderr += new TextDecoder().decode(b);
    },
    resolveCommand: async (program, args, context) => {
      requests.push({ program, args, context });
      return modules.get(program);
    },
  });
  const outcome = await host.run(bytes('sh'), { name: 'sh', args: ['-c', script] });
  const exit = childExit(outcome);
  return {
    stdout,
    stderr,
    code: exit.kind === 'exited' ? exit.code : -exit.signal,
    host,
    requests,
  };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function bridge(): () => Promise<void> {
  const workers: NodeWorker[] = [];
  class WorkerBridge {
    onmessage: ((event: { data: WorkerReply }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    readonly worker: NodeWorker;
    constructor(url: URL) {
      this.worker = new NodeWorker(
        `
        const {parentPort} = require('node:worker_threads');
        const {readFile} = require('node:fs/promises');
        globalThis.fetch = async (url) => {
          const file = ${JSON.stringify(assets)}[url.pathname.split('/').at(-1)];
          return new Response(new Uint8Array(await readFile(new URL('src/'+file, ${JSON.stringify(root.href)}))));
        };
        globalThis.postMessage = (data) => parentPort.postMessage(data);
        import(${JSON.stringify(url.href.replace(/\.js$/, '.ts'))}).then(() => parentPort.on('message', (data) => globalThis.onmessage({data})));
      `,
        { eval: true, execArgv: [] },
      );
      workers.push(this.worker);
      this.worker.on('message', (data: WorkerReply) => this.onmessage?.({ data }));
      this.worker.on('error', (e) => this.onerror?.({ message: e.message }));
    }
    postMessage(data: WorkerMessage): void {
      this.worker.postMessage(data);
    }
    terminate(): void {
      void this.worker.terminate();
    }
  }
  vi.stubGlobal('Worker', WorkerBridge);
  return async () => {
    await Promise.all(workers.map((w) => w.terminate()));
  };
}

function spawnRequest(program: string): SpawnRequest {
  return {
    program,
    argv: [program],
    cwd: undefined,
    env: [],
    stdio: [{ kind: 'inherit' }, { kind: 'inherit' }, { kind: 'inherit' }],
    extraFds: [],
  };
}

describe('browser wasm processes with cli/sh 0.2.1', () => {
  it('executes memory paths with spawn cwd, absolute paths, nested children and pipes', async () => {
    stubAssets();
    let stdout = '';
    let stderr = '';
    const host = await createBrowserHost({
      execPaths: true,
      files: {
        'prog.wasm': bytes('true'),
        '/bin/fail.wasm': bytes('false'),
        'sub/prog.wasm': bytes('false'),
        'shell.wasm': bytes('sh'),
        '/bin/tr.wasm': bytes('tr'),
      },
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    expect(
      await host.run(bytes('sh'), {
        name: 'sh',
        args: [
          '-c',
          './prog.wasm; echo $?; /bin/fail.wasm; echo $?; cd sub; ./prog.wasm; echo $?; ../shell.wasm -c "./prog.wasm; echo \\$?"; echo hello | /bin/tr.wasm a-z A-Z',
        ],
      }),
    ).toEqual({ kind: 'completed' });
    expect({ stdout, stderr }).toEqual({ stdout: '0\n1\n1\n1\nHELLO\n', stderr: '' });
    expect(host.process.kill(999999, 0)).toEqual({ ok: false, error: { code: 'ESRCH' } });
  });
  it('defaults path execution on with a resolver, leaving bare names exclusively to it', async () => {
    stubAssets();
    const resolveCommand = vi.fn(async () => bytes('false'));
    let stdout = '';
    const host = await createBrowserHost({
      files: { 'prog.wasm': bytes('true') },
      resolveCommand,
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
    });
    expect(
      await host.run(bytes('sh'), {
        args: ['-c', './prog.wasm; echo $?; prog.wasm; echo $?'],
      }),
    ).toEqual({ kind: 'completed' });
    expect(stdout).toBe('0\n1\n');
    expect(resolveCommand).toHaveBeenCalledExactlyOnceWith('prog.wasm', [], {
      cwd: '/work',
      env: { PWD: '/work' },
    });
  });
  it('lets execPaths:false retain resolver ownership of slash-containing names', async () => {
    stubAssets();
    const resolveCommand = vi.fn(async () => bytes('false'));
    const host = await createBrowserHost({
      execPaths: false,
      files: { 'prog.wasm': bytes('true') },
      resolveCommand,
    });
    expect(await host.run(bytes('sh'), { args: ['-c', './prog.wasm'] })).toEqual({
      kind: 'exited',
      code: 1,
    });
    expect(resolveCommand).toHaveBeenCalledExactlyOnceWith('./prog.wasm', [], {
      cwd: '/work',
      env: { PWD: '/work' },
    });
  });
  it('keeps processes unsupported without a resolver or path-execution capability', async () => {
    stubAssets();
    for (const options of [
      {},
      { mounts: {} },
      { execPaths: false, mounts: { '/mnt': fakeMount({}).provider } },
    ]) {
      const host = await createBrowserHost({ ...options, files: { 'prog.wasm': bytes('true') } });
      expect(await host.process.spawn(spawnRequest('./prog.wasm'))).toEqual({
        ok: false,
        error: { code: 'ENOSYS' },
      });
      expect(host.process.kill(999999, 0)).toEqual({ ok: false, error: { code: 'ENOSYS' } });
    }
    const host = await createBrowserHost({ execPaths: true, files: { prog: bytes('true') } });
    expect(await host.process.spawn(spawnRequest('prog'))).toEqual({
      ok: false,
      error: { code: 'ENOSYS' },
    });
  });
  for (const [name, contents, code, message] of [
    ['text', 'not an executable\n', 'ENOEXEC', 'Exec format error'],
    ['empty', '', 'ENOEXEC', 'Exec format error'],
    ['short', '\0as', 'ENOEXEC', 'Exec format error'],
    ['missing', undefined, 'ENOENT', 'No such file or directory'],
    ['directory', null, 'EACCES', 'Permission denied'],
  ] as const) {
    it(`matches real moonrun's cli/sh error and status for a ${name} path`, async () => {
      stubAssets();
      let stdout = '';
      let stderr = '';
      const resolveCommand = vi.fn(async () => bytes('true'));
      const host = await createBrowserHost({
        files: contents === undefined ? {} : { [name]: contents },
        resolveCommand,
        stdout: (b) => {
          stdout += new TextDecoder().decode(b);
        },
        stderr: (b) => {
          stderr += new TextDecoder().decode(b);
        },
      });
      expect(await host.process.spawn(spawnRequest(`./${name}`))).toEqual({
        ok: false,
        error: { code },
      });
      expect(await host.run(bytes('sh'), { args: ['-c', `./${name}; echo $?`] })).toEqual({
        kind: 'completed',
      });
      // Verified with moonrun 0.1.20261012: cli/sh uses 127 for all spawn errors, not 126.
      expect({ stdout, stderr }).toEqual({
        stdout: '127\n',
        stderr: `sh: OSError("@process.run(): ${message}")\n`,
      });
      expect(resolveCommand).not.toHaveBeenCalled();
    });
  }
  it('defaults paths on for mounts alone and loads uncached wasm through Worker RPC with short reads', async () => {
    const close = bridge();
    const mount = fakeMount(
      { 'prog.wasm': bytes('false'), bad: 'not wasm' },
      { cache: false, delay: async () => new Promise((resolve) => setTimeout(resolve, 1)) },
    );
    let stdout = '';
    let stderr = '';
    const handle = runInWorker({
      wasm: bytes('sh'),
      args: ['-c', '/mnt/prog.wasm; echo $?; cd /mnt; ./prog.wasm; echo $?; ./bad; echo $?'],
      mounts: {
        '/mnt': {
          ...mount.provider,
          open: async (path) => {
            const opened = await mount.provider.open(path);
            if (!opened.ok) return opened;
            return {
              ok: true,
              value: {
                ...opened.value,
                read: async (offset, length) => opened.value.read(offset, Math.min(length, 3)),
              },
            };
          },
        },
      },
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    try {
      expect(await handle).toEqual({ kind: 'completed' });
      expect({ stdout, stderr }).toEqual({
        stdout: '1\n1\n127\n',
        stderr: 'sh: OSError("@process.run(): Exec format error")\n',
      });
      expect(mount.calls.filter((c) => c.op === 'open')).toHaveLength(3);
      expect(mount.calls.filter((c) => c.op === 'close')).toHaveLength(3);
      expect(mount.calls.some((c) => c.op === 'read')).toBe(true);
    } finally {
      await close();
    }
  }, 15000);
  it('runs ls, cat and grep against delayed providers on the main thread, including nested mounts', async () => {
    const close = bridge();
    const delay = async () => new Promise<void>((resolve) => setTimeout(resolve, 1));
    const outer = fakeMount({ 'data.txt': 'apple\nbanana\napple pie\n', sub: null }, { delay });
    const inner = fakeMount({ 'nested.txt': 'nested\n' }, { delay });
    let stdout = '';
    let stderr = '';
    const handle = runInWorker({
      wasm: bytes('sh'),
      name: 'sh',
      args: [
        '-c',
        'echo LIST; ls /mnt/local; echo CAT; cat /mnt/local/data.txt; echo GREP; grep apple /mnt/local/data.txt; echo NESTED; cat /mnt/local/sub/nested.txt',
      ],
      mounts: { '/mnt/local': outer.provider, '/mnt/local/sub': inner.provider },
      resolveCommand: async (name) => modules.get(name),
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    try {
      expect(await handle).toEqual({ kind: 'completed' });
      expect(stderr).toBe('');
      expect(stdout).toMatch(
        /LIST\n[\s\S]*data.txt[\s\S]*sub[\s\S]*CAT\napple\nbanana\napple pie\nGREP\napple\napple pie\nNESTED\nnested\n/,
      );
      expect(outer.calls.some((c) => c.op === 'readdir')).toBe(true);
      expect(inner.calls.some((c) => c.op === 'read')).toBe(true);
      expect(outer.calls.some((c) => c.path.includes('nested.txt'))).toBe(false);
      expect(outer.calls.filter((c) => c.op === 'open')).toHaveLength(
        outer.calls.filter((c) => c.op === 'close').length,
      );
    } finally {
      await close();
    }
  }, 15000);
  it('uses asynchronous mounted descriptors for child input and output redirection', async () => {
    stubAssets();
    const { provider, memory } = fakeMount(
      { data: 'hello\n' },
      { writable: true, delay: async () => new Promise((resolve) => setTimeout(resolve, 1)) },
    );
    let stdout = '';
    let stderr = '';
    const host = await createBrowserHost({
      mounts: { '/mnt': provider },
      resolveCommand: async (name) => modules.get(name),
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    expect(
      await host.run(bytes('sh'), {
        name: 'sh',
        args: [
          '-c',
          'cat /mnt/data > /mnt/copy; cat < /mnt/copy; tr a-z A-Z < /mnt/data > /mnt/upper; cat /mnt/upper',
        ],
      }),
    ).toEqual({ kind: 'completed' });
    expect({ stdout, stderr }).toEqual({ stdout: 'hello\nHELLO\n', stderr: '' });
    expect(memory.fs.readFile('/copy')).toEqual({
      ok: true,
      value: new TextEncoder().encode('hello\n'),
    });
  }, 15000);
  for (const script of [
    'echo hello | tr a-z A-Z',
    'false; echo $?; definitely_missing_command; echo $?',
    "sh -c 'echo nested | tr a-z A-Z; false; echo $?'; sh -c 'exit 42'; echo $?",
    'false',
    "sh -c 'echo out; echo err >&2' 2>&1 | tr a-z A-Z",
  ]) {
    it(`matches the Node CLI with native commands: ${script}`, async () => {
      const actual = await browser(script);
      expect({ stdout: actual.stdout, stderr: actual.stderr, code: actual.code }).toEqual(
        reference(script),
      );
    });
  }
  it('uses the shared VFS for redirects and passes child cwd/env and argv through nested runs', async () => {
    stubAssets();
    const seen: { program: string; args: readonly string[]; context: CommandContext }[] = [];
    let stdout = '';
    const host = await createBrowserHost({
      files: { sub: null },
      env: { CUSTOM: 'value' },
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      resolveCommand: async (program, args, context) => {
        seen.push({ program, args, context });
        return modules.get(program);
      },
    });
    expect(
      await host.run(bytes('sh'), {
        name: 'sh',
        args: ['-c', "cd sub; echo file > data; tr a-z A-Z < data; sh -c 'echo $CUSTOM'"],
      }),
    ).toEqual({ kind: 'completed' });
    expect(stdout).toBe('FILE\nvalue\n');
    expect(host.fs.readFile('/work/sub/data')).toEqual({
      ok: true,
      value: new TextEncoder().encode('file\n'),
    });
    expect(seen.map((r) => r.context.cwd)).toEqual(['/work/sub', '/work/sub']);
    expect(seen[0]?.args).toEqual(['a-z', 'A-Z']);
    expect(seen[1]?.context.env['CUSTOM']).toBe('value');
  });
  it('runs a multi-megabyte pipeline with bounded pipe backpressure', async () => {
    const input = new TextEncoder().encode('hello pipeline\n'.repeat(100000));
    const script = 'tr a-z A-Z | tr A-Z a-z';
    const actual = await browser(script, input);
    expect({ stdout: actual.stdout, stderr: actual.stderr, code: actual.code }).toEqual(
      reference(script, input),
    );
    expect(actual.stdout.length).toBe(input.length);
  }, 15000);
  for (const execPaths of [false, true]) {
    it(`publishes increasing pids and SIGINT/SIGKILL wait completion (execPaths:${execPaths})`, async () => {
      stubAssets();
      const host = await createBrowserHost(
        execPaths
          ? { execPaths: true, files: { 'cat.wasm': bytes('cat') } }
          : { resolveCommand: async (name) => modules.get(name) },
      );
      const request = {
        program: execPaths ? './cat.wasm' : 'cat',
        argv: ['cat'],
        env: [],
        cwd: undefined,
        stdio: [{ kind: 'pipe' }, { kind: 'pipe' }, { kind: 'pipe' }] as const,
        extraFds: [],
      };
      const children: ChildProcess[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const result = await host.process.spawn(request);
          if (!result.ok) throw new Error(result.error.code);
          children.push(result.value);
          if (i === 0) {
            let received = false;
            result.value.stdout?.onData(() => {
              received = true;
            });
            expect(result.value.stdin?.write(new TextEncoder().encode('ready\n'))).toBe(true);
            await until(() => received);
          } else {
            let received = false;
            result.value.stdout?.onData(() => {
              received = true;
              result.value.stdout?.pause();
            });
            expect(result.value.stdin?.write(new Uint8Array(256 * 1024))).toBe(false);
            await until(() => received);
          }
          result.value.stderr?.onData(() => {});
        }
        expect(children[1]?.pid).toBeGreaterThan(children[0]?.pid ?? 0);
        for (const [index, child] of children.entries()) {
          const signal = index === 0 ? 2 : 9;
          expect(host.process.kill(child.pid, 0).ok).toBe(true);
          const exited = new Promise((resolve) => child.onExit(resolve));
          expect(host.process.kill(child.pid, signal).ok).toBe(true);
          expect(await exited).toEqual({ kind: 'signaled', signal });
          expect(host.process.kill(child.pid, 0)).toEqual({ ok: false, error: { code: 'ESRCH' } });
        }
      } finally {
        for (const child of children) host.process.kill(child.pid, 9);
      }
    });
  }
  it('maps traps/host failures like the CLI, truncates exit codes, and accepts precompiled commands', async () => {
    expect(childExit({ kind: 'guest-failure', diagnostic: 'trap' })).toEqual({
      kind: 'exited',
      code: 1,
    });
    expect(childExit({ kind: 'host-failure', failure: { chain: ['error'] } })).toEqual({
      kind: 'exited',
      code: 1,
    });
    expect(childExit({ kind: 'panicked', message: 'panic' })).toEqual({
      kind: 'exited',
      code: 101,
    });
    expect(childExit({ kind: 'exited', code: 257 })).toEqual({ kind: 'exited', code: 1 });
    stubAssets();
    const host = await createBrowserHost({
      resolveCommand: async () => WebAssembly.compile(bytes('false')),
    });
    expect(await host.run(bytes('sh'), { name: 'sh', args: ['-c', 'false'] })).toEqual({
      kind: 'exited',
      code: 1,
    });
  });
  it('reports actual child traps and compile failures as exit 1', async () => {
    const result = spawnSync('wasm-tools', ['parse', '-'], {
      input: '(module (func (export "_start") unreachable))',
    });
    expect(result.status).toBe(0);
    modules.set('trap', new Uint8Array(result.stdout));
    modules.set('invalid', new Uint8Array([1, 2, 3]));
    const actual = await browser('trap; echo $?; invalid; echo $?');
    expect(actual.stdout).toBe('1\n1\n');
    expect(actual.stderr).toContain('unreachable');
    expect(actual.stderr).toContain('failed to compile `invalid`');
  });
  it('feeds interactive sh line by line through the real Worker, resolving commands on the main thread', async () => {
    const close = bridge();
    let stdout = '';
    let stderr = '';
    const calls: string[] = [];
    const handle = runInWorker({
      wasm: bytes('sh'),
      name: 'sh',
      args: ['-i'],
      stdin: 'stream',
      resolveCommand: async (name) => {
        calls.push(name);
        const wasm = modules.get(name);
        return wasm === undefined
          ? undefined
          : WebAssembly.compile(wasm, { builtins: ['js-string'], importedStringConstants: '_' });
      },
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    try {
      await until(() => stdout.includes('$ ') || stderr.includes('$ '));
      await handle.write(new TextEncoder().encode('echo first\n'));
      await until(() => stdout.includes('first\n'));
      await handle.write(new TextEncoder().encode('echo second | tr a-z A-Z\n'));
      await until(() => stdout.includes('SECOND\n'));
      await handle.write(new TextEncoder().encode('exit 7\n'));
      handle.end();
      expect(await handle).toEqual({ kind: 'exited', code: 7 });
      const expected = reference(
        '',
        new TextEncoder().encode('echo first\necho second | tr a-z A-Z\nexit 7\n'),
        true,
      );
      expect({ stdout, stderr, code: 7 }).toEqual(expected);
      expect(calls).toEqual(['tr']);
    } finally {
      await close();
    }
  }, 15000);
  it('does not count host stdio adapters as leaked guest descriptors', async () => {
    stubAssets();
    let stdout = '';
    let stderr = '';
    const host = await createBrowserHost({
      env: { MOONBIT_ASYNC_CHECK_FD_LEAK: '1' },
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
      resolveCommand: async (name) => modules.get(name),
    });
    expect(
      await host.run(bytes('sh'), { name: 'sh', args: ['-c', 'echo hello | tr a-z A-Z; echo $?'] }),
    ).toEqual({ kind: 'completed' });
    expect(stdout).toBe('HELLO\n0\n');
    expect(stderr).toBe('');
  });
  for (const command of ['cat', 'cat | cat', "sh -c 'cat'"]) {
    it(`delivers group SIGINT to interactive sh and its ${command} descendants`, async () => {
      const close = bridge();
      let stdout = '';
      let stderr = '';
      const handle = runInWorker({
        wasm: bytes('sh'),
        name: 'sh',
        args: ['-i'],
        stdin: 'stream',
        resolveCommand: async (name) => modules.get(name),
        stdout: (b) => {
          stdout += new TextDecoder().decode(b);
        },
        stderr: (b) => {
          stderr += new TextDecoder().decode(b);
        },
      });
      const prompts = () => (stdout + stderr).match(/\$ /g)?.length ?? 0;
      try {
        await until(() => prompts() === 1);
        await handle.write(new TextEncoder().encode(`${command}\n`));
        await handle.write(new TextEncoder().encode('waiting\n'));
        await until(() => stdout.includes('waiting\n'));
        expect(await handle.signal(2, { target: 'group' })).toBe(true);
        expect(await handle).toEqual({ kind: 'signaled', signal: 2 });
        expect(prompts()).toBe(1);
        expect(await handle.signal(2, { target: 'group' })).toBe(false);
      } finally {
        await close();
      }
    }, 15000);
  }
  it('lets a guest that captures SIGINT survive group delivery and wait for child status -2', async () => {
    const close = bridge();
    let stdout = '';
    let stderr = '';
    const handle = runInWorker({
      wasm: bytes('signal-parent'),
      name: 'signal-parent',
      stdin: 'stream',
      resolveCommand: async (name) => modules.get(name),
      stdout: (b) => {
        stdout += new TextDecoder().decode(b);
      },
      stderr: (b) => {
        stderr += new TextDecoder().decode(b);
      },
    });
    try {
      await handle.write(new TextEncoder().encode('waiting\n'));
      await until(() => stdout.includes('waiting\n'));
      expect(await handle.signal(2, { target: 'group' })).toBe(true);
      expect(await handle).toEqual({ kind: 'completed' });
      expect(stdout).toBe('waiting\ncaught SIGINT; child=-2; parent alive\n');
      expect(stderr).toBe('');
    } finally {
      await close();
    }
  });
  for (const when of ['preparation', 'idle prompt']) {
    it(`delivers group signals with no children at ${when}, and reports false after exit`, async () => {
      const close = bridge();
      let prompted = false;
      const output = (b: Uint8Array) => {
        if (new TextDecoder().decode(b).includes('$ ')) prompted = true;
      };
      const handle = runInWorker({
        wasm: bytes('sh'),
        name: 'sh',
        args: ['-i'],
        stdin: 'stream',
        stdout: output,
        stderr: output,
      });
      try {
        if (when === 'idle prompt') await until(() => prompted);
        expect(await handle.signal(2, { target: 'group' })).toBe(true);
        expect(await handle).toEqual({ kind: 'signaled', signal: 2 });
        expect(await handle.signal(2, { target: 'group' })).toBe(false);
      } finally {
        await close();
      }
    });
  }
  it('signals a suspended Worker and ignores a late command-resolution result', async () => {
    const close = bridge();
    let resolve: ((wasm: Uint8Array) => void) | undefined;
    const handle = runInWorker({
      wasm: bytes('sh'),
      name: 'sh',
      args: ['-c', 'delayed-command'],
      resolveCommand: async () =>
        new Promise<Uint8Array>((ready) => {
          resolve = ready;
        }),
    });
    try {
      await until(() => resolve !== undefined);
      handle.signal(9);
      expect(await handle).toEqual({ kind: 'signaled', signal: 9 });
      if (resolve === undefined) throw new Error('missing resolver request');
      resolve(bytes('true'));
      await Promise.resolve();
    } finally {
      await close();
    }
  });
  it('delivers SIGINT to shell cancellation and the foreground child', async () => {
    stubAssets();
    const stdin = new BrowserStdin();
    let ready = false;
    const host = await createBrowserHost({
      stdin,
      stdout: () => {
        ready = true;
      },
      resolveCommand: async (name) => modules.get(name),
    });
    const running = host.run(bytes('sh'), { name: 'sh', args: ['-c', 'echo ready; tr a-z A-Z'] });
    try {
      await until(() => ready);
      await new Promise((resolve) => setTimeout(resolve, 40));
      host.signal(2);
      const outcome = await running;
      expect(outcome).toEqual({ kind: 'signaled', signal: 2 });
    } finally {
      stdin.end();
      host.signal(9);
    }
  }, 10000);
});
