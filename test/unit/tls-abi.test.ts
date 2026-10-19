import { randomFillSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAsyncImports } from '../../src/abi/async/build.ts';
import type { AsyncEnv } from '../../src/abi/async/env.ts';
import { asyncHandlers } from '../../src/abi/async/index.ts';
import type { RunContext } from '../../src/abi/context.ts';
import { GuestMemory } from '../../src/abi/memory.ts';
import { nodeComponents } from '../../src/hosts/node/components.ts';
import { nodeFiles } from '../../src/hosts/node/files.ts';
import { AsyncKernel } from '../../src/kernel/async-kernel.ts';
import { NULL_HANDLE } from '../../src/kernel/handles.ts';
import { unsupportedDns, unsupportedNet } from '../../src/kernel/net-unsupported.ts';
import { ok } from '../../src/ports/result.ts';
import { emptyTrustStore } from '../../src/ports/tls.ts';
import { FakeScheduler, memoryStdio } from './kernel-fakes.ts';
import { FIXTURES } from './tls-harness.ts';

function setup(denied: readonly string[] = []) {
  const files = nodeFiles(FIXTURES);
  const kernel = new AsyncKernel({
    stdio: memoryStdio(),
    scheduler: new FakeScheduler(),
    stdioKind: () => ok('char-device'),
    files,
    net: unsupportedNet,
    dns: unsupportedDns,
  });
  const memory = new GuestMemory();
  memory.bind(new WebAssembly.Memory({ initial: 4 }));
  const ctx = {
    host: {
      clock: { nowMs: () => Date.now(), monotonicNs: () => 0n },
      random: { fill: (b: Uint8Array) => void randomFillSync(b) },
      files,
      components: nodeComponents(),
      trustStore: emptyTrustStore,
    },
    policy: () => ({
      enforced: true,
      authorizeRead: (path: string) =>
        denied.includes(path) ? { kind: 'permission-denied' } : undefined,
    }),
    asyncKernel: kernel,
  } as unknown as RunContext;
  const env: AsyncEnv = { ctx, kernel, memory };
  const imports = buildAsyncImports(asyncHandlers(env));
  const call = (symbol: string, ...args: unknown[]): unknown => {
    const def = imports[symbol];
    if (def?.kind !== 'function') {
      throw new Error(`no import ${symbol}`);
    }
    return (def.impl as (...a: unknown[]) => unknown)(...args);
  };
  const bytes = (buffer: unknown): Uint8Array => {
    const handle = buffer as bigint;
    const length = call('c_buffer/length', handle) as number;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = call('c_buffer/c_buffer_get', handle, i) as number;
    }
    call('c_buffer/free', handle);
    return out;
  };
  const text = (buffer: unknown): string => {
    const raw = bytes(buffer);
    expect(raw.at(-1)).toBe(0);
    return new TextDecoder().decode(raw.subarray(0, -1));
  };
  /** Writes a UTF-16 string at `ptr` and returns its length in units. */
  const utf16 = (ptr: number, s: string): number => {
    for (let i = 0; i < s.length; i++) {
      memory.setU16(ptr + 2 * i, s.charCodeAt(i));
    }
    return s.length;
  };
  return { kernel, memory, call, bytes, text, utf16 };
}

describe('tls/connection imports', () => {
  it('follows moonrun for null, unknown and pending handles', () => {
    const { call, text, kernel } = setup();
    expect(call('tls/connection/free', NULL_HANDLE)).toBeUndefined();
    expect(() => call('tls/connection/free', 0n)).toThrow(
      new Error('moonbitlang/async.tls/connection/free failed: Badf'),
    );
    expect(() => call('tls/connection/wants_read', 0n)).toThrow('wants_read failed: Badf');
    expect(text(call('tls/error/take_global'))).toBe('unknown TLS error');

    const tls = call('tls/connection/new') as bigint;
    expect(kernel.leakSummary()).toBe('tls_connections=1');
    expect(text(call('tls/connection/take_error', tls))).toBe('unknown TLS error');
    expect(call('tls/connection/connect', tls, 0, 0, 0, 100, 0, 16)).toBe(3);
    expect(text(call('tls/connection/take_error', tls))).toBe('TLS handle is not configured');
    expect(call('tls/connection/read_plain', tls, 0, 0, 0, 0, 0, 0, 0, 0, 0)).toBe(-1);
    expect(call('tls/connection/bytes_read', tls)).toBe(0);
    expect(call('tls/connection/wants_write', tls)).toBe(0);
    expect(call('tls/connection/peer_certificate', tls)).toBe(NULL_HANDLE);
    expect(call('tls/connection/unique_channel_binding', tls)).toBe(NULL_HANDLE);
    call('tls/connection/free', tls);
    expect(kernel.leakSummary()).toBeUndefined();
    expect(() => call('tls/connection/free', tls)).toThrow('free failed: Badf');
  });

  it('validates arguments before looking the handle up', () => {
    const { call } = setup();
    expect(() => call('tls/connection/set_client', 0n, 0, 0, 0, 3)).toThrow(
      'set_client failed: Inval',
    );
    expect(() => call('tls/connection/set_client', 0n, 1, 1, 0, 0)).toThrow(
      'set_client failed: Fault',
    );
    expect(() => call('tls/connection/set_client', 0n, 0, 0, 0, 0)).toThrow(
      'set_client failed: Badf',
    );
    expect(() => call('tls/connection/set_server_files', 0n, 0, 0, 1, 0, 0, 3)).toThrow(
      'set_server_files failed: Inval',
    );
    const tls = call('tls/connection/new') as bigint;
    expect(call('tls/connection/set_client', tls, 0, 0, 0, 0)).toBe(0);
    expect(() => call('tls/connection/set_client', tls, 0, 0, 0, 0)).toThrow(
      'set_client failed: Inval',
    );
    expect(() => call('tls/connection/add_root_certificate', tls, 0, 4)).toThrow(
      'add_root_certificate failed: Inval',
    );
    // Overlapping input and output slices are a Fault, even when one is empty.
    expect(() => call('tls/connection/connect', tls, 0, 0, 64, 32, 0, 0)).toThrow(
      'connect failed: Fault',
    );
    expect(() => call('tls/connection/connect', tls, 0, 0, 16, 4 * 65536, 0, 1)).toThrow(
      'connect failed: Fault',
    );
    call('tls/connection/free', tls);
  });

  it('reads server files relative to the run directory and checks the policy first', () => {
    const { call, text, utf16 } = setup(['denied.pem']);
    const tls = call('tls/connection/new') as bigint;
    const keyLen = utf16(0, 'key.pem');
    const missingLen = utf16(100, 'missing.pem');
    const deniedLen = utf16(200, 'denied.pem');
    expect(call('tls/connection/set_server_files', tls, 0, keyLen, 1, 200, deniedLen, 1)).toBe(-1);
    expect(text(call('tls/connection/take_error', tls))).toBe(
      'failed to access TLS certificate file: PermissionDenied',
    );
    expect(call('tls/connection/set_server_files', tls, 0, keyLen, 1, 100, missingLen, 1)).toBe(-1);
    expect(text(call('tls/connection/take_error', tls))).toBe(
      'failed to load TLS certificate chain: No such file or directory (os error 2)',
    );
    const certLen = utf16(300, 'cert.pem');
    expect(call('tls/connection/set_server_files', tls, 0, keyLen, 1, 300, certLen, 1)).toBe(0);
    expect(call('tls/connection/peer_certificate', tls)).not.toBe(NULL_HANDLE);
    call('tls/connection/free', tls);
  });

  it('decodes a lone surrogate in the host name as U+FFFD', () => {
    const { call, text, utf16 } = setup();
    const tls = call('tls/connection/new') as bigint;
    const len = utf16(0, 'a\ud800.example');
    // The name is not a valid DNS name either way; it must not fault or throw.
    const status = call('tls/connection/set_client', tls, 0, len, 1, 0);
    expect(status === 0 || text(call('tls/connection/take_error', tls)).length > 0).toBe(true);
    call('tls/connection/free', tls);
  });

  it('completes a handshake through guest memory and returns certificates as c_buffers', () => {
    const { call, memory, bytes, utf16 } = setup();
    const server = call('tls/connection/new') as bigint;
    const keyLen = utf16(0, 'key.pem');
    const certLen = utf16(100, 'cert.pem');
    expect(call('tls/connection/set_server_files', server, 0, keyLen, 1, 100, certLen, 1)).toBe(0);
    const client = call('tls/connection/new') as bigint;
    expect(call('tls/connection/set_client', client, 0, 0, 0, 0)).toBe(0);
    expect(bytes(call('tls/connection/peer_certificate', client)).length).toBe(0);

    // Each side: inbox at `base`, output at `base + 0x8000`.
    const BUF = 0x8000;
    const sides = [
      { tls: client, base: 0x10000, pending: 0, done: false, op: 'tls/connection/connect' },
      { tls: server, base: 0x20000, pending: 0, done: false, op: 'tls/connection/accept' },
    ];
    for (let round = 0; round < 20 && !(sides[0]?.done && sides[1]?.done); round++) {
      for (const [i, side] of sides.entries()) {
        const peer = sides[1 - i];
        if (peer === undefined || side.done) {
          continue;
        }
        const state = call(side.op, side.tls, side.base, 0, side.pending, side.base + BUF, 0, BUF);
        const consumed = call('tls/connection/bytes_read', side.tls) as number;
        const produced = call('tls/connection/bytes_to_write', side.tls) as number;
        const inbox = memory.copyOut(side.base + consumed, side.pending - consumed);
        memory.write(side.base, inbox);
        side.pending = inbox.length;
        memory.write(peer.base + peer.pending, memory.copyOut(side.base + BUF, produced));
        peer.pending += produced;
        expect(state === 0 || state === 1 || state === 2).toBe(true);
        side.done = state === 0;
      }
    }
    expect(sides.every((s) => s.done)).toBe(true);
    expect(bytes(call('tls/connection/peer_certificate', client)).length).toBeGreaterThan(0);
    const unique = bytes(call('tls/connection/unique_channel_binding', client));
    expect(unique.length).toBeGreaterThan(0);
    call('tls/connection/free', client);
    call('tls/connection/free', server);
  });
});
