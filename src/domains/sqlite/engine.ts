// One instance of sqlite-engine.wasm (crates/sqlite-engine): SQLite 3.53.2 with the VFS of
// vfs.ts. The engine has its own linear memory; inputs are copied in and outputs copied
// out, and views of its memory are recreated after every call because SQLite may grow it.
import type { VfsDeps } from './vfs.ts';
import { Vfs } from './vfs.ts';

/** A pointer into the engine's memory (`sqlite3*`, `sqlite3_stmt*`, ...); 0 is NULL. */
export type EnginePtr = number;

/** The engine's exports (scripts/build-sqlite.ts `ENGINE_EXPORTS` and engine.c). */
export interface EngineExports {
  readonly memory: WebAssembly.Memory;
  sqlite3_open_v2(filename: number, out: number, flags: number, vfs: number): number;
  sqlite3_close(db: number): number;
  sqlite3_errmsg16(db: number): number;
  sqlite3_errcode(db: number): number;
  sqlite3_extended_errcode(db: number): number;
  sqlite3_changes64(db: number): bigint;
  sqlite3_total_changes64(db: number): bigint;
  sqlite3_db_mutex(db: number): number;
  sqlite3_mutex_enter(mutex: number): void;
  sqlite3_mutex_leave(mutex: number): void;
  sqlite3_prepare16_v2(db: number, sql: number, bytes: number, out: number, tail: number): number;
  sqlite3_bind_null(stmt: number, index: number): number;
  sqlite3_bind_int64(stmt: number, index: number, value: bigint): number;
  sqlite3_bind_double(stmt: number, index: number, value: number): number;
  sqlite3_step(stmt: number): number;
  sqlite3_reset(stmt: number): number;
  sqlite3_clear_bindings(stmt: number): number;
  sqlite3_stmt_busy(stmt: number): number;
  sqlite3_stmt_readonly(stmt: number): number;
  sqlite3_finalize(stmt: number): number;
  sqlite3_column_count(stmt: number): number;
  sqlite3_data_count(stmt: number): number;
  sqlite3_column_name16(stmt: number, column: number): number;
  sqlite3_column_type(stmt: number, column: number): number;
  sqlite3_column_int64(stmt: number, column: number): bigint;
  sqlite3_column_double(stmt: number, column: number): number;
  sqlite3_column_text16(stmt: number, column: number): number;
  sqlite3_column_bytes16(stmt: number, column: number): number;
  sqlite3_column_blob(stmt: number, column: number): number;
  sqlite3_column_bytes(stmt: number, column: number): number;
  sqlite3_libversion(): number;
  sqlite3_sourceid(): number;
  mr_set_authorizer(db: number): number;
  mr_progress(db: number, enable: number): void;
  mr_bind_text16(stmt: number, index: number, value: number, bytes: number): number;
  mr_bind_blob(stmt: number, index: number, value: number, bytes: number): number;
  mr_utf16_length(ptr: number): number;
  mr_malloc(size: number): number;
  mr_free(ptr: number): void;
}

const REQUIRED_EXPORTS = [
  'memory',
  'sqlite3_open_v2',
  'sqlite3_close',
  'sqlite3_errmsg16',
  'sqlite3_errcode',
  'sqlite3_extended_errcode',
  'sqlite3_changes64',
  'sqlite3_total_changes64',
  'sqlite3_db_mutex',
  'sqlite3_mutex_enter',
  'sqlite3_mutex_leave',
  'sqlite3_prepare16_v2',
  'sqlite3_bind_null',
  'sqlite3_bind_int64',
  'sqlite3_bind_double',
  'sqlite3_step',
  'sqlite3_reset',
  'sqlite3_clear_bindings',
  'sqlite3_stmt_busy',
  'sqlite3_stmt_readonly',
  'sqlite3_finalize',
  'sqlite3_column_count',
  'sqlite3_data_count',
  'sqlite3_column_name16',
  'sqlite3_column_type',
  'sqlite3_column_int64',
  'sqlite3_column_double',
  'sqlite3_column_text16',
  'sqlite3_column_bytes16',
  'sqlite3_column_blob',
  'sqlite3_column_bytes',
  'sqlite3_libversion',
  'sqlite3_sourceid',
  'mr_set_authorizer',
  'mr_progress',
  'mr_bind_text16',
  'mr_bind_blob',
  'mr_utf16_length',
  'mr_malloc',
  'mr_free',
] as const;

/** The SQL policy and Job scheduling the engine calls back into. */
export interface EngineHooks {
  /** The authorizer (`untrusted_authorizer`); a missing argument is SQLite's NULL. */
  authorize(
    action: number,
    argument1: Uint8Array | undefined,
    argument2: Uint8Array | undefined,
    database: Uint8Array | undefined,
    trigger: Uint8Array | undefined,
  ): number;
  /** The progress callback of a running Job; a promise suspends the engine call. */
  progress(): number | Promise<number>;
}

/** A buffer in engine memory owned by one caller. */
export interface EngineBuffer {
  readonly ptr: EnginePtr;
  readonly len: number;
  free(): void;
}

export class SqliteEngine {
  readonly x: EngineExports;
  readonly vfs: Vfs;
  /** `sqlite3_step` under `WebAssembly.promising`, for Jobs that may yield. */
  readonly stepAsync: (stmt: EnginePtr) => Promise<number>;
  #scratch = 0;
  #scratchSize = 0;

  constructor(module: WebAssembly.Module, deps: VfsDeps, hooks: EngineHooks) {
    let exports: EngineExports | undefined;
    const memory = (): ArrayBuffer => {
      if (exports === undefined) {
        throw new Error('sqlite-engine: import called during instantiation');
      }
      return exports.memory.buffer;
    };
    this.vfs = new Vfs(deps, memory);
    const text = (ptr: number): Uint8Array | undefined =>
      ptr === 0 ? undefined : this.cstring(ptr);
    const instance = new WebAssembly.Instance(module, {
      host: this.vfs.imports({
        authorize: (action, a1, a2, db, trigger) =>
          hooks.authorize(action, text(a1), text(a2), text(db), text(trigger)),
        progress: () => hooks.progress(),
      }),
    });
    for (const name of REQUIRED_EXPORTS) {
      if (!(name in instance.exports)) {
        throw new Error(`sqlite-engine: export \`${name}\` is missing`);
      }
    }
    exports = instance.exports as unknown as EngineExports;
    this.x = exports;
    this.stepAsync = WebAssembly.promising(exports.sqlite3_step as (stmt: number) => number) as (
      stmt: EnginePtr,
    ) => Promise<number>;
  }

  /** A fresh view of `len` bytes of engine memory at `ptr`. */
  bytes(ptr: EnginePtr, len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, ptr, len);
  }

  /** The bytes of the NUL-terminated string at `ptr`, without the NUL (copied). */
  cstring(ptr: EnginePtr): Uint8Array {
    const memory = new Uint8Array(this.x.memory.buffer);
    const end = memory.indexOf(0, ptr);
    return memory.slice(ptr, end < 0 ? memory.length : end);
  }

  /**
   * `len` bytes of scratch space, reused by every synchronous call (never NULL, even for
   * zero bytes). A call that may suspend uses {@link allocate} instead.
   */
  scratch(len: number): EnginePtr {
    if (len > this.#scratchSize || this.#scratch === 0) {
      if (this.#scratch !== 0) {
        this.x.mr_free(this.#scratch);
      }
      const size = Math.max(len, 256, this.#scratchSize * 2);
      const ptr = this.x.mr_malloc(size);
      if (ptr === 0) {
        throw new Error('sqlite-engine: out of memory');
      }
      this.#scratch = ptr;
      this.#scratchSize = size;
    }
    return this.#scratch;
  }

  /** A private copy of `bytes` (plus `extra` zero bytes) in engine memory. */
  allocate(bytes: Uint8Array, extra = 0): EngineBuffer {
    const len = bytes.length + extra;
    const ptr = this.x.mr_malloc(Math.max(len, 1));
    if (ptr === 0) {
      throw new Error('sqlite-engine: out of memory');
    }
    const view = this.bytes(ptr, len);
    view.set(bytes);
    view.fill(0, bytes.length);
    return { ptr, len, free: () => this.x.mr_free(ptr) };
  }

  u32(ptr: EnginePtr): number {
    return new DataView(this.x.memory.buffer).getUint32(ptr, true);
  }

  /** UTF-16 code units before the NUL at `ptr`. */
  utf16Length(ptr: EnginePtr): number {
    return this.x.mr_utf16_length(ptr);
  }

  /** `SQLITE_VERSION` of the engine. */
  get version(): string {
    return new TextDecoder().decode(this.cstring(this.x.sqlite3_libversion()));
  }
}
