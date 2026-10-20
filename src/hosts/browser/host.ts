import { Diagnostics } from '../../diagnostics/diag.ts';
import { DIAGNOSTICS_URL } from '../../diagnostics/diag-url.ts';
import { POLICY_URL } from '../../domains/policy/policy-url.ts';
import { TLS_ENGINE_URL } from '../../domains/tls/engine-url.ts';
import type { RunOutcome } from '../../engine/run.ts';
import type { Host } from '../../ports/host.ts';
import type { SpawnRequest } from '../../ports/process.ts';
import { ok } from '../../ports/result.ts';
import {
  type BrowserMemoryFs,
  type MemoryFsRequest,
  type MemoryFsResults,
  memoryFilesystem,
  memoryFsError,
} from './memory-fs.ts';
import type { BrowserMounts } from './mount-provider.ts';
import { MountedVfs } from './mounted-vfs.ts';
import { BrowserDns, browserNet } from './net.ts';
import { allocatePid, browserProcess, childEnvironment, type ResolveCommand } from './process.ts';
import { BrowserControl, runBrowserGuest } from './runtime.ts';
import { type BrowserIo, BrowserStdin, callbackWriter } from './streams.ts';
import { type BrowserFiles, MemoryVfs } from './vfs.ts';

export interface BrowserHostOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly files?: BrowserFiles;
  readonly mounts?: BrowserMounts;
  readonly stdout?: (bytes: Uint8Array) => void;
  readonly stderr?: (bytes: Uint8Array) => void;
  /** A synchronous byte source (read into the buffer, return count), or finite input. Default EOF. */
  readonly stdin?: Uint8Array | BrowserStdin | ((buffer: Uint8Array) => number);
  readonly resolveCommand?: ResolveCommand;
  /** Execute VFS paths and search child PATH. Defaults on with a resolver or nonempty mounts. */
  readonly execPaths?: boolean;
  /** WebSocket URL, including any relay authentication query. No relay means ENOSYS. */
  readonly relay?: string;
  /** DER roots for TrustSystemRoot. By default fetch the relay's /roots endpoint, or use none. */
  readonly roots?: readonly Uint8Array[];
}
export interface BrowserSignalOptions {
  readonly target: 'group';
}
export interface BrowserHost extends Host {
  readonly diagnostics: Diagnostics;
  /** Async embedder facade; `fs` remains the core synchronous FsPort. */
  readonly memoryFs: BrowserMemoryFs;
  run(
    wasm: Uint8Array | WebAssembly.Module,
    options?: { readonly name?: string; readonly args?: readonly string[] },
  ): Promise<RunOutcome>;
  /** Deliver to the top Run by default, or to the top Run and all its live descendants. */
  signal(signal: number): void;
  signal(signal: number, options: BrowserSignalOptions): boolean;
}
async function compile(url: URL): Promise<WebAssembly.Module> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot load ${url.href}: HTTP ${response.status}`);
  return WebAssembly.compile(await response.arrayBuffer());
}
async function relayRoots(relay: string | undefined): Promise<readonly Uint8Array[]> {
  if (relay === undefined) return [];
  const url = new URL(relay);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/roots';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot load relay roots: HTTP ${response.status}`);
  const values: unknown = await response.json();
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string'))
    throw new Error('invalid relay roots');
  return values.map((v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
}

/** Fetch/compile before entering the synchronous ports. Call in a dedicated Worker for runs. */
export async function createBrowserHost(options: BrowserHostOptions = {}): Promise<BrowserHost> {
  const [diag, policy, tls, sqlite, roots] = await Promise.all([
    compile(DIAGNOSTICS_URL),
    compile(POLICY_URL),
    compile(TLS_ENGINE_URL),
    compile(new URL('./sqlite-engine.wasm', import.meta.url)),
    options.roots === undefined ? relayRoots(options.relay) : Promise.resolve(options.roots),
  ]);
  const hasMounts = options.mounts !== undefined && Object.keys(options.mounts).length > 0;
  const execPaths = options.execPaths ?? (options.resolveCommand !== undefined || hasMounts);
  const vfs = hasMounts
    ? new MountedVfs(options.files, options.cwd, options.mounts)
    : new MemoryVfs(options.files, options.cwd);
  let rootCwd = options.cwd ?? '/work';
  if (vfs instanceof MountedVfs) {
    const cwd = await vfs.files.async.realpath(rootCwd);
    if (!cwd.ok) throw new Error(`browser cwd: ${cwd.error.code}`);
    rootCwd = new TextDecoder().decode(cwd.value);
    const stat = await vfs.files.async.statAt(undefined, rootCwd, true);
    if (!stat.ok || stat.value.kind !== 'dir') throw new Error('browser cwd: ENOTDIR');
  }
  const tree = { controls: new Map<number, BrowserControl>(), closed: false };
  const rootPid = allocatePid();
  const source = options.stdin;
  let offset = 0;
  const read = (buffer: Uint8Array): number => {
    if (typeof source === 'function') return source(buffer);
    const bytes =
      source instanceof Uint8Array ? source.subarray(offset, offset + buffer.length) : undefined;
    if (bytes === undefined) return 0;
    buffer.set(bytes);
    offset += bytes.length;
    return bytes.length;
  };
  const rootIo: BrowserIo = {
    stdin: source instanceof BrowserStdin ? source : { read, readAsync: async (b) => read(b) },
    stdout: callbackWriter((b) => options.stdout?.(b.slice())),
    stderr: callbackWriter((b) => options.stderr?.(b.slice())),
  };
  const make = (
    io: BrowserIo,
    cwd: string,
    initialEnv: Readonly<Record<string, string>>,
    control: BrowserControl,
    pid: number,
    child: boolean,
  ): BrowserHost => {
    const view = vfs.view(cwd);
    const fstat = (fd: Parameters<typeof view.files.fstat>[0]) => {
      if (fd < 0 || fd > 2) return view.files.fstat(fd);
      const base = view.files.stat('/');
      return base.ok
        ? ok({ ...base.value, kind: 'other' as const, mode: 0o010666n, ino: BigInt(fd), size: 0n })
        : base;
    };
    const files = {
      ...view.files,
      fstat,
      async: {
        ...view.files.async,
        // Only stdio uses synthetic metadata; mounted descriptors must await their provider.
        fstat: async (fd: Parameters<typeof fstat>[0]) =>
          fd >= 0 && fd <= 2 ? fstat(fd) : view.files.async.fstat(fd),
      },
    };
    const env = new Map(Object.entries(initialEnv));
    const dns = new BrowserDns();
    const host: BrowserHost = {
      memoryFs: memoryFilesystem(async <R extends MemoryFsRequest>(request: R) => {
        if (tree.closed || control.abort.signal.aborted)
          throw memoryFsError({ code: 'EBADF', message: 'Run has ended' });
        const result = vfs.memory(request);
        if (!result.ok)
          throw memoryFsError({
            ...result.error,
            message: `${request.kind} ${request.path}: ${result.error.code}`,
          });
        return result.value as MemoryFsResults[R['kind']];
      }),
      diagnostics: new Diagnostics(diag, {
        readFile: (p) => {
          const r = view.fs.readFile(p);
          return r.ok ? r.value : undefined;
        },
      }),
      run: async (wasm, runOptions = {}) => {
        try {
          return await runBrowserGuest(
            wasm,
            runOptions.name ?? '/work/program.wasm',
            runOptions.args ?? [],
            host,
            control,
            child ? io : undefined,
          );
        } finally {
          if (!child) {
            tree.closed = true;
            for (const [key, active] of tree.controls) if (key !== pid) active.stop(9);
            tree.controls.clear();
          }
        }
      },
      signal,
      stdio: {
        writeStdout: (b) => {
          io.stdout.write(b);
        },
        writeStderr: (b) => {
          io.stderr.write(b);
        },
        readStdin: (b) => io.stdin.read(b),
        readStdinAsync: async (b) => control.readStdin(io.stdin, b),
      },
      env: {
        get: (k) => env.get(k),
        entries: () => [...env],
        set: (k, v) => {
          env.set(k, v);
        },
        unset: (k) => {
          env.delete(k);
        },
      },
      clock: {
        nowMs: () => Date.now(),
        monotonicNs: () => BigInt(Math.floor(performance.now() * 1e6)),
      },
      random: {
        fill: (b) => {
          for (let i = 0; i < b.length; i += 65536)
            crypto.getRandomValues(b.subarray(i, i + 65536));
        },
      },
      fs: view.fs,
      files,
      dns,
      net: browserNet(dns, options.relay),
      components: {
        policy: () => ok(policy),
        tlsEngine: () => ok(tls),
        sqliteEngine: () => ok(sqlite),
      },
      get process() {
        return port;
      },
      signals:
        execPaths || options.resolveCommand !== undefined || source instanceof BrowserStdin
          ? control.signals
          : {
              capture: () => () => {},
              raise: () => {
                throw Object.assign(new Error('browser signals: ENOSYS'), { code: 'ENOSYS' });
              },
            },
      trustStore: { systemRoots: () => ok(roots) },
      platform: { currentExe: undefined, pid },
    };
    const port = browserProcess({
      resolver: options.resolveCommand,
      execPaths,
      parent: host,
      io,
      vfs,
      tree,
      child: (request: SpawnRequest, streams: BrowserIo, next: BrowserControl, childPid: number) =>
        make(streams, request.cwd ?? cwd, childEnvironment(request.env), next, childPid, true),
    });
    function signal(s: number): void;
    function signal(s: number, options: BrowserSignalOptions): boolean;
    function signal(s: number, options?: BrowserSignalOptions): boolean | undefined {
      if (options?.target !== 'group') {
        control.send(s);
        return;
      }
      let delivered = false;
      // Snapshot membership before delivery: the top Run's default action may end the tree.
      for (const [key, active] of [...tree.controls]) {
        if (active.abort.signal.aborted) continue;
        if (key === rootPid) {
          active.send(s);
          delivered = true;
        } else if (port.kill(key, s).ok) delivered = true;
      }
      return delivered;
    }
    return host;
  };
  const control = new BrowserControl();
  tree.controls.set(rootPid, control);
  return make(rootIo, rootCwd, options.env ?? {}, control, rootPid, false);
}
