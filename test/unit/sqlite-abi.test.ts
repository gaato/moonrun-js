import { afterEach, describe, expect, it } from 'vitest';
import { createAsyncKernel } from '../../src/abi/async/index.ts';
import type { RunContext } from '../../src/abi/context.ts';
import { GuestMemory } from '../../src/abi/memory.ts';
import { sqlite } from '../../src/abi/sqlite/index.ts';
import { ambientPolicy } from '../../src/engine/run.ts';
import { SQLITE_IMPORTS } from '../../src/generated/sqlite-imports.ts';
import { nodeHost } from '../../src/hosts/node/index.ts';
import { asHandle, NULL_HANDLE } from '../../src/kernel/handles.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function setup() {
  const host = nodeHost();
  const kernel = createAsyncKernel(host);
  const memory = new GuestMemory();
  const backing = new WebAssembly.Memory({ initial: 1 });
  memory.bind(backing);
  const policy = ambientPolicy(host);
  let summary: () => string | undefined = () => undefined;
  const imports = sqlite({
    host,
    memory,
    asyncKernel: kernel,
    policy: () => policy,
    onTeardown: (f: () => void) => cleanups.push(f),
    onLeakCheck: (f: () => string | undefined) => {
      summary = f;
    },
  } as unknown as RunContext);
  cleanups.push(() => kernel.teardown());
  const call = (name: string, ...args: unknown[]): unknown => {
    const def = imports[`sqlite3_${name}`];
    if (def?.kind !== 'function') throw new Error(name);
    return (def.impl as (...args: unknown[]) => unknown)(...args);
  };
  const utf16 = (s: string): number => {
    for (let i = 0; i < s.length; i++) memory.setU16(1024 + 2 * i, s.charCodeAt(i));
    return s.length;
  };
  memory.write(64, new TextEncoder().encode(':memory:'));
  const open = (): bigint => {
    expect(call('open_v2', 64, 8, 32, 6, NULL_HANDLE)).toBe(0);
    return memory.u64(32);
  };
  const prepare = (db: bigint, sql: string, tail = 40): bigint => {
    expect(call('prepare16_v2', db, 1024, 0, utf16(sql), 32, tail)).toBe(0);
    return memory.u64(32);
  };
  const run = (j: unknown): bigint => {
    const key = asHandle(j as bigint);
    const r = kernel.pool.runJob(key);
    expect(r.ok).toBe(true);
    return key;
  };
  const free = (j: bigint): void => {
    expect(kernel.pool.freeJob(asHandle(j)).ok).toBe(true);
  };
  return {
    call,
    memory,
    backing,
    imports,
    kernel,
    open,
    prepare,
    utf16,
    run,
    free,
    summary: () => summary(),
  };
}

describe('SQLite ABI and pool ownership', () => {
  it('implements all 40 generated signatures with SQLite 3.53.2', () => {
    const s = setup();
    expect(Object.keys(s.imports).sort()).toEqual(Object.keys(SQLITE_IMPORTS).sort());
    expect(Object.keys(s.imports)).toHaveLength(40);
    const db = s.open();
    const stmt = s.prepare(db, 'SELECT sqlite_version()');
    expect(s.call('step', stmt)).toBe(100);
    expect(s.call('column_text16', stmt, 0, 256, 20)).toBe(6);
    expect(s.memory.utf16(256, 6)).toBe('3.53.2');
    s.call('finalize', stmt);
    s.call('close', db);
    expect(s.summary()).toBeUndefined();
  });
  it('copies UTF-16 views, preserves absolute tails and supports an omitted tail', () => {
    const s = setup();
    const db = s.open();
    const sql = 'xxSELECT 1; SELECT 2';
    s.utf16(sql);
    expect(s.call('prepare16_v2', db, 1024, 2, sql.length - 2, 32, 40)).toBe(0);
    expect(s.memory.u32(40)).toBe(11);
    s.call('finalize', s.memory.u64(32));
    s.call('finalize', s.prepare(db, 'SELECT 3', 0));
    s.call('close', db);
  });
  it('copies binding inputs and leaves a short output untouched across memory growth', () => {
    const s = setup();
    const db = s.open();
    const stmt = s.prepare(db, 'SELECT ?1, ?2');
    s.utf16('日本\0語');
    expect(s.call('bind_text16', stmt, 1, 1024, 0, 4)).toBe(0);
    s.memory.write(128, new Uint8Array([0, 255, 3]));
    expect(s.call('bind_blob', stmt, 2, 128, 0, 3)).toBe(0);
    s.memory.view(1024, 8).fill(0);
    s.memory.view(128, 3).fill(0);
    s.backing.grow(1);
    expect(s.call('step', stmt)).toBe(100);
    s.memory.view(256, 8).fill(0xcc);
    expect(s.call('column_text16', stmt, 0, 256, 1)).toBe(4);
    expect(s.memory.u16(256)).toBe(0xcccc);
    expect(s.call('column_text16', stmt, 0, 256, 4)).toBe(4);
    expect(s.memory.utf16(256, 4)).toBe('日本\0語');
    expect(s.call('column_blob', stmt, 1, 300, 3)).toBe(3);
    expect([...s.memory.copyOut(300, 3)]).toEqual([0, 255, 3]);
    expect(s.call('clear_bindings', stmt)).toBe(21);
    expect(s.call('reset', stmt)).toBe(0);
    expect(s.call('clear_bindings', stmt)).toBe(0);
    s.call('finalize', stmt);
    s.call('close', db);
  });
  it('validates current rows, handles and recursive mutex lifetimes', () => {
    const s = setup();
    const db = s.open();
    const stmt = s.prepare(db, 'SELECT 1');
    expect(() => s.call('column_int64', stmt, 0)).toThrow('failed: Fault');
    const mutex = s.call('db_mutex', db);
    expect(s.call('db_mutex', db)).toBe(mutex);
    s.call('mutex_enter', mutex);
    s.call('mutex_enter', mutex);
    s.call('mutex_leave', mutex);
    expect(() => s.call('close', db)).toThrow('failed: Fault');
    s.call('mutex_leave', mutex);
    expect(() => s.call('mutex_leave', mutex)).toThrow('failed: Fault');
    expect(s.call('close', db)).toBe(5);
    s.call('finalize', stmt);
    expect(s.call('close', db)).toBe(0);
    expect(() => s.call('mutex_enter', mutex)).toThrow('failed: InvalidHandle');
    expect(() => s.call('close', db)).toThrow('failed: InvalidHandle');
    expect(s.call('close', NULL_HANDLE)).toBe(0);
  });
  it('uses upstream SQL policy and initializes output before rejecting input', () => {
    const s = setup();
    const db = s.open();
    for (const sql of [
      'PRAGMA foreign_keys=OFF',
      "ATTACH ':memory:' AS other",
      'PRAGMA hard_heap_limit=1',
    ]) {
      expect(s.call('prepare16_v2', db, 1024, 0, s.utf16(sql), 32, 0)).toBe(23);
      expect(s.memory.u64(32)).toBe(NULL_HANDLE);
    }
    expect(() => s.call('open_v2', 0, 8, 32, 6, NULL_HANDLE)).toThrow('failed: Fault');
    expect(s.memory.u64(32)).toBe(NULL_HANDLE);
    expect(() => s.call('prepare16_v2', db, 1025, 0, 1, 32, 40)).toThrow('failed: Fault');
    expect(s.memory.u64(32)).toBe(NULL_HANDLE);
    s.call('close', db);
  });
  it('pins prepared statements and connections until a job is freed', () => {
    const s = setup();
    const db = s.open();
    const stmt = s.prepare(db, 'SELECT 42');
    const job = s.call('make_step_job', db, stmt) as bigint;
    expect(() => s.call('step', stmt)).toThrow('failed: Fault');
    expect(() => s.call('close', db)).toThrow('failed: Fault');
    s.run(job);
    s.call('job_result', job, 256);
    expect(s.memory.u32(256)).toBe(100);
    expect(s.memory.u32(264)).toBe(0xffffffff);
    expect(s.memory.u32(268)).toBe(0);
    expect(() => s.call('column_int64', stmt, 0)).toThrow('failed: Fault');
    s.free(job);
    expect(s.call('column_int64', stmt, 0)).toBe(42n);
    s.call('finalize', stmt);
    s.call('close', db);
  });
  it('transfers job results once and preserves them after invalid output memory', () => {
    const s = setup();
    const job = s.run(s.call('make_open_job', 64, 8, 6));
    expect(() => s.call('job_result', job, 0)).toThrow('failed: Fault');
    s.call('job_result', job, 256);
    expect(s.memory.u32(256)).toBe(0);
    const db = s.call('take_job_handle', job) as bigint;
    expect(() => s.call('take_job_handle', job)).toThrow('failed: Fault');
    expect(s.call('close', db)).toBe(0);
    s.call('job_result', job, 256);
    s.free(job);
    expect(s.summary()).toBeUndefined();
  });
  it('discards unclaimed prepare results without publishing a handle', () => {
    const s = setup();
    const db = s.open();
    const j = s.run(s.call('make_prepare_job', db, 1024, 0, s.utf16('SELECT 7')));
    const discard = s.call('make_discard_job', j) as bigint;
    s.free(j);
    expect(() => s.call('close', db)).toThrow('failed: Fault');
    s.run(discard);
    s.free(discard);
    expect(s.call('close', db)).toBe(0);
    expect(s.summary()).toBeUndefined();
  });
  it('captures errors and changes in the 24-byte job record', () => {
    const s = setup();
    const db = s.open();
    const bad = s.run(s.call('make_prepare_job', db, 1024, 0, s.utf16('SELECT nonexistent')));
    s.call('job_result', bad, 256);
    expect(s.memory.u32(256)).toBe(1);
    expect(s.call('job_message16_length', bad)).toBeGreaterThan(0);
    expect(() => s.call('take_job_handle', bad)).toThrow('failed: Fault');
    s.free(bad);
    for (const sql of ['CREATE TABLE t(n)', 'INSERT INTO t VALUES(1),(2)']) {
      const stmt = s.prepare(db, sql);
      const j = s.run(s.call('make_step_job', db, stmt));
      s.call('job_result', j, 256);
      expect(s.memory.u32(256)).toBe(101);
      expect(s.memory.u32(268)).toBe(1);
      expect(s.memory.u64(272)).toBe(sql.startsWith('INSERT') ? 2n : 0n);
      s.free(j);
      s.call('finalize', stmt);
    }
    s.call('close', db);
  });
});
