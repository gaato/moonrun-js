import { Diagnostics } from '../../diagnostics/diag.ts';
import { DIAGNOSTICS_URL } from '../../diagnostics/diag-url.ts';
import { POLICY_URL } from '../../domains/policy/policy-url.ts';
import { TLS_ENGINE_URL } from '../../domains/tls/engine-url.ts';
import type { Host } from '../../ports/host.ts';
import { err, ok } from '../../ports/result.ts';
import { BrowserDns, browserNet } from './net.ts';
import { type BrowserFiles, MemoryVfs } from './vfs.ts';

export interface BrowserHostOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly files?: BrowserFiles;
  readonly stdout?: (bytes: Uint8Array) => void;
  readonly stderr?: (bytes: Uint8Array) => void;
  /** A synchronous byte source (read into the buffer, return count), or finite input. Default EOF. */
  readonly stdin?: Uint8Array | ((buffer: Uint8Array) => number);
  /** WebSocket URL, including any relay authentication query. No relay means ENOSYS. */
  readonly relay?: string;
  /** DER roots for TrustSystemRoot. By default fetch the relay's /roots endpoint, or use none. */
  readonly roots?: readonly Uint8Array[];
}
export interface BrowserHost extends Host {
  readonly diagnostics: Diagnostics;
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
  const vfs = new MemoryVfs(options.files, options.cwd);
  const env = new Map(Object.entries(options.env ?? {}));
  const dns = new BrowserDns();
  let offset = 0;
  const source = options.stdin;
  const read = (buffer: Uint8Array): number => {
    if (typeof source === 'function') return source(buffer);
    const bytes = source?.subarray(offset, offset + buffer.length);
    if (bytes === undefined) return 0;
    buffer.set(bytes);
    offset += bytes.length;
    return bytes.length;
  };
  return {
    diagnostics: new Diagnostics(diag, {
      readFile: (p) => {
        const r = vfs.fs.readFile(p);
        return r.ok ? r.value : undefined;
      },
    }),
    stdio: {
      writeStdout: (bytes) => options.stdout?.(bytes.slice()),
      writeStderr: (bytes) => options.stderr?.(bytes.slice()),
      readStdin: read,
      readStdinAsync: async (buffer) => read(buffer),
    },
    env: {
      get: (key) => env.get(key),
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
      fill: (buffer) => {
        for (let offset = 0; offset < buffer.length; offset += 65536)
          crypto.getRandomValues(buffer.subarray(offset, offset + 65536));
      },
    },
    fs: vfs.fs,
    files: vfs.files,
    dns,
    net: browserNet(dns, options.relay),
    components: {
      policy: () => ok(policy),
      tlsEngine: () => ok(tls),
      sqliteEngine: () => ok(sqlite),
    },
    process: {
      spawn: async () => err({ code: 'ENOSYS' }),
      kill: () => err({ code: 'ENOSYS' }),
      openPolicyTransfer: () => err({ code: 'ENOSYS' }),
      closeFd: () => {},
    },
    // SignalPort cannot return errors. Capture is inert (the existing NO_SIGNALS convention).
    signals: {
      capture: () => () => {},
      raise: () => {
        throw Object.assign(new Error('browser signals: ENOSYS'), { code: 'ENOSYS' });
      },
    },
    trustStore: { systemRoots: () => ok(roots) },
    platform: { currentExe: undefined, pid: 0 },
  };
}
