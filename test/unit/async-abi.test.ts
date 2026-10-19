import { describe, expect, it } from 'vitest';
import { buildAsyncImports } from '../../src/abi/async/build.ts';
import { parentPath } from '../../src/abi/async/core.ts';
import type { AsyncEnv } from '../../src/abi/async/env.ts';
import { guestEvents } from '../../src/abi/async/event-bus.ts';
import { tmpPath } from '../../src/abi/async/fs-helpers.ts';
import { asyncHandlerGroups, asyncHandlers } from '../../src/abi/async/index.ts';
import type { RunContext } from '../../src/abi/context.ts';
import type { FunctionImport } from '../../src/abi/define.ts';
import { GuestMemory } from '../../src/abi/memory.ts';
import { ASYNC_IMPORTS } from '../../src/generated/async-imports.ts';
import { nodeFiles } from '../../src/hosts/node/files.ts';
import { AsyncKernel } from '../../src/kernel/async-kernel.ts';
import { NULL_HANDLE } from '../../src/kernel/handles.ts';
import { unsupportedDns, unsupportedNet } from '../../src/kernel/net-unsupported.ts';
import { EPOLLERR, EPOLLHUP, EPOLLIN, EPOLLOUT, EPOLLRDHUP } from '../../src/kernel/readiness.ts';
import { TerminationCell } from '../../src/kernel/termination.ts';
import { ok } from '../../src/ports/result.ts';
import { FakeScheduler, memoryStdio } from './kernel-fakes.ts';

function setup() {
  const kernel = new AsyncKernel({
    stdio: memoryStdio(),
    scheduler: new FakeScheduler(),
    stdioKind: () => ok('char-device'),
    files: nodeFiles(),
    net: unsupportedNet,
    dns: unsupportedDns,
  });
  const memory = new GuestMemory();
  memory.bind(new WebAssembly.Memory({ initial: 1 }));
  const ctx = {
    host: {
      platform: { currentExe: '/a/b.wasm', pid: 42 },
      clock: { nowMs: () => 1234.9, monotonicNs: () => 0n },
      random: { fill: (b: Uint8Array) => b.fill(1) },
      env: { get: (k: string) => (k === 'TMPDIR' ? '/var/tmp' : undefined) },
    },
    termination: new TerminationCell(),
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
  return { kernel, memory, env, imports, call };
}

describe('moonbitlang/async handler map', () => {
  it('has disjoint groups covering exactly the implemented symbols', () => {
    const { env } = setup();
    const seen = new Set<string>();
    for (const group of asyncHandlerGroups(env)) {
      for (const key of Object.keys(group)) {
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
    const implemented = Object.entries(ASYNC_IMPORTS)
      .filter(([, entry]) => entry.kind !== 'fake')
      .map(([symbol]) => symbol);
    expect([...seen].sort()).toEqual(implemented.sort());
  });

  it('declares the table signature and suspends only where the host may wait', () => {
    const { imports } = setup();
    expect(Object.keys(imports).length).toBe(Object.keys(ASYNC_IMPORTS).length);
    const wait = imports['event_bus/wait'] as FunctionImport;
    expect(wait.params).toEqual(['u64', 'i32']);
    expect(wait.result).toBe('i32');
    const suspending = Object.entries(imports)
      .filter(([, def]) => def.kind === 'function' && def.suspends)
      .map(([symbol]) => symbol);
    // Node binds and connects UDP sockets asynchronously, so these may suspend too.
    expect(suspending.sort()).toEqual([
      'event_bus/wait',
      'socket/bind',
      'socket/listen',
      'socket/sendto/unix',
      'socket/udp_client_connect',
    ]);
  });

  it('reports host errors with the AsyncHostError Debug name', () => {
    const { call } = setup();
    expect(() => call('event_bus/destroy', 0n)).toThrow(
      new Error('moonbitlang/async.event_bus/destroy failed: Badf'),
    );
    expect(() => call('c_buffer/strlen', NULL_HANDLE)).toThrow('c_buffer/strlen failed: Badf');
    expect(() => call('fd_util/get_atime_sec', 0xffff_fff0)).toThrow(
      'fd_util/get_atime_sec failed: Fault',
    );
    expect(() => call('event_bus/event_fd', 0n)).toThrow('event_bus/event_fd failed: Badf');
    expect(() => call('process/kill', 1)).toThrow(
      'moonbitlang/async.process/kill is not implemented yet',
    );
    expect(() => call('event_bus/event_pid', 0n)).toThrow(
      'platform-inactive moonbitlang/async import `event_bus/event_pid` was called',
    );
  });

  it('reports OS-shaped failures as -1 plus a Linux errno', () => {
    const { call } = setup();
    expect(call('fd_util/close_fd', 0x1_0000_0002n)).toBe(-1);
    expect(call('os_error/get_errno')).toBe(9);
    expect(call('fd_util/pipe', 65530, 2, 1, 1)).toBe(-1);
    expect(call('os_error/get_errno')).toBe(14);
    expect(call('stdio/get_stdio_handle', 3)).toBe(0x1_0000_0001n);
    expect(call('os_error/get_errno')).toBe(22);
  });

  it('exposes the reserved handles', () => {
    const { call } = setup();
    expect(call('fd_util/invalid_fd')).toBe(0x1_0000_0001n);
    expect(call('stdio/get_stdio_handle', 0)).toBe(0x1_0000_0002n);
    expect(call('stdio/get_stdio_handle', 2)).toBe(0x1_0000_0004n);
    expect(call('fd_util/kind_of_fd', 0x1_0000_0003n)).toBe(7);
    expect(call('fd_util/kind_of_fd', 0x1_0000_0001n)).toBe(-1);
    expect(call('c_buffer/is_null', NULL_HANDLE)).toBe(1);
    expect(call('c_buffer/is_null', 0n)).toBe(0);
  });

  it('creates pipes and moves bytes through io/read and io/write', () => {
    const { call, memory } = setup();
    expect(call('fd_util/pipe', 64, 2, 1, 1)).toBe(0);
    const reader = memory.u64(64);
    const writer = memory.u64(72);
    expect(call('fd_util/kind_of_fd', reader)).toBe(5);
    memory.write(200, new Uint8Array([1, 2, 3]));
    expect(call('io/write/unix', writer, 200, 1, 2)).toBe(2);
    expect(call('io/read/unix', reader, 300, 0, 8)).toBe(2);
    expect([...memory.view(300, 2)]).toEqual([2, 3]);
    expect(call('io/read/unix', reader, 300, 0, 8)).toBe(-1);
    expect(call('os_error/get_errno')).toBe(11);
    expect(call('os_error/is_nonblocking_io_error', 11)).toBe(1);
    expect(call('fd_util/close_fd', writer)).toBe(0);
    expect(call('io/read/unix', reader, 300, 0, 8)).toBe(0);
  });

  it('decodes strerror through c_buffer and os_string', () => {
    const { call, memory } = setup();
    const buffer = call('os_error/errno_to_string', 2) as bigint;
    const len = call('os_string/decode_len', buffer, 0, -1);
    expect(len).toBe('No such file or directory'.length);
    call('os_string/decode', buffer, 0, -1, 1000, len);
    expect(memory.utf16(1000, len as number)).toBe('No such file or directory');
    expect(() => call('os_string/decode', buffer, 0, -1, 1001, len)).toThrow('Fault');
    expect(() => call('os_string/decode', buffer, 0, -1, 1000, 3)).toThrow('Inval');
    call('os_error/free_errno_str', buffer);
    expect(() => call('os_error/free_errno_str', buffer)).toThrow('Badf');
    call('os_error/free_errno_str', NULL_HANDLE);
    const unknown = call('os_error/errno_to_string', 4000) as bigint;
    expect(call('c_buffer/strlen', unknown)).toBe('Unknown error 4000'.length);
  });

  it('copies between guest memory and c_buffers with bounds checks', () => {
    const { call, memory } = setup();
    const buffer = call('c_buffer/new', 4) as bigint;
    memory.write(10, new Uint8Array([9, 8, 7]));
    call('c_buffer/blit_to_c', buffer, 1, 10, 1, 2);
    expect(call('c_buffer/c_buffer_get', buffer, 1)).toBe(8);
    expect(call('c_buffer/c_buffer_get', buffer, 2)).toBe(7);
    expect(() => call('c_buffer/c_buffer_get', buffer, 4)).toThrow('Fault');
    expect(() => call('c_buffer/blit_to_c', buffer, 3, 10, 0, 2)).toThrow('Fault');
    call('c_buffer/blit_from_c', buffer, 1, 20, 0, 3);
    expect([...memory.view(20, 3)]).toEqual([8, 7, 0]);
    expect(call('c_buffer/length', buffer)).toBe(4);
  });

  it('runs a sleep job end to end through the wait import', async () => {
    const { call, memory, kernel } = setup();
    const scheduler = kernel.scheduler as FakeScheduler;
    const bus = call('event_bus/create') as bigint;
    const source = call('thread_pool/init_thread_pool', bus) as bigint;
    const job = call('thread_pool/make_sleep_job', 30);
    const worker = call('thread_pool/spawn_worker', 11, job);
    const waited = call('event_bus/wait', bus, -1) as Promise<number>;
    scheduler.advance(30);
    expect(await waited).toBe(1);
    expect(call('event_bus/get_event', bus, 0)).toBe(0n);
    expect(() => call('event_bus/get_event', bus, 1)).toThrow('Fault');
    expect(call('event_bus/event_fd', 0n)).toBe(source);
    expect(call('event_bus/event_events/unix', 0n)).toBe(1);
    expect(call('thread_pool/fetch_completion/unix', source, 400, 1024)).toBe(4);
    expect(memory.u32(400)).toBe(11);
    expect(call('thread_pool/cancel_worker_with_retry', worker)).toBe(2);
    expect(call('thread_pool/job_get_ret', job)).toBe(0);
    expect(call('thread_pool/job_get_err', job)).toBe(0);
    call('thread_pool/free_job', job);
    call('thread_pool/free_worker', worker);
    call('event_bus/destroy', bus);
    call('thread_pool/destroy_thread_pool');
    expect(kernel.leakSummary()).toBeUndefined();
  });

  it('encodes epoll bits as async ReadEvent/WriteEvent', () => {
    expect(guestEvents(EPOLLIN)).toBe(1);
    expect(guestEvents(EPOLLOUT)).toBe(2);
    expect(guestEvents(EPOLLIN | EPOLLOUT)).toBe(3);
    for (const bit of [EPOLLERR, EPOLLHUP, EPOLLRDHUP]) {
      expect(guestEvents(bit | EPOLLIN)).toBe(3);
    }
  });

  it('derives paths like moonrun', () => {
    expect(tmpPath(undefined)).toBe('/tmp/');
    expect(tmpPath('')).toBe('/tmp/');
    expect(tmpPath('/var/tmp')).toBe('/var/tmp/');
    expect(tmpPath('/x/')).toBe('/x/');
    expect(parentPath('/a/b.wasm')).toBe('/a');
    expect(parentPath('/b.wasm')).toBe('/');
    expect(parentPath('/a//b/')).toBe('/a');
    expect(parentPath('/')).toBeUndefined();
  });

  it('reads process-shaped values from the host', () => {
    const { call } = setup();
    expect(call('env_util/getpid')).toBe(42);
    expect(call('time/get_ms_since_epoch')).toBe(1234n);
    expect(call('runtime/get_platform')).toBe(0);
    expect(call('signal/get_signal_by_index', 1)).toBe(15);
    expect(call('signal/get_signal_by_index', 3)).toBe(-1);
    expect(call('fs/get_tmp_path_len')).toBe('/var/tmp/'.length);
  });
});
