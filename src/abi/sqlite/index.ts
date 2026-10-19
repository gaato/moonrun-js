import {
  attempt,
  fault,
  type SqliteError,
  SqliteHost,
  SqliteWork,
} from '../../domains/sqlite/host.ts';
import { SQLITE_IMPORTS } from '../../generated/sqlite-imports.ts';
import { asHandle, canonical, NULL_HANDLE } from '../../kernel/handles.ts';
import type { Result } from '../../ports/result.ts';
import type { ImportFamily } from '../context.ts';
import { fn, type ImportDef, type JsArgs, type ValType } from '../define.ts';
import { GuestFault } from '../memory.ts';

type Table = typeof SQLITE_IMPORTS;
type Js<T> = T extends 'u64' | 'i64' ? bigint : T extends 'void' ? void : number;
type Args<P> = {
  -readonly [I in keyof P]: P[I] extends readonly [string, infer T] ? Js<T> : never;
};
type Handlers = {
  [K in keyof Table]: (...args: Args<Table[K]['params']>) => Js<Table[K]['result']>;
};

export const sqlite: ImportFamily = (ctx) => {
  const module = ctx.host.components.sqliteEngine();
  if (!module.ok) throw new Error(module.error.message ?? module.error.code);
  const policy = ctx.policy();
  const h = new SqliteHost(
    ctx.asyncKernel.keys,
    module.value,
    ctx.host,
    {
      authorize: (...args) => policy.sqliteAuthorize(...args),
      progress: () => 0,
    },
    (name, flags, vfs) => policy.sqliteAdmit(name, flags, vfs),
  );
  ctx.onTeardown(() => h.dispose());
  ctx.onLeakCheck(() => h.summary());
  const e = h.engine;
  const x = e.x;
  const m = ctx.memory;
  const pool = ctx.asyncKernel.pool;
  const check = <T>(r: Result<T, SqliteError>): T => {
    if (!r.ok) fault(r.error);
    return r.value;
  };
  const bytes = (ptr: number, offset: number, len: number, width = 1): Uint8Array => {
    if (ptr === 0 || ptr % width !== 0 || offset < 0 || len < 0) fault();
    if ((offset + len) * width > 0xffffffff || ptr + offset * width > 0xffffffff) fault('Overflow');
    return m.copyOut(ptr + offset * width, len * width);
  };
  const filename = (ptr: number, len: number): Uint8Array => {
    const b = bytes(ptr, 0, len);
    if (b.includes(0)) fault();
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      fault();
    }
    return b;
  };
  const validate = (ptr: number, len: number, width = 1): void => {
    if (len > 0xffffffff / width) fault('Overflow');
    if (len !== 0) {
      if (ptr === 0 || ptr % width !== 0) fault();
      m.view(ptr, len * width);
    }
  };
  const copy = (b: Uint8Array, out: number, cap: number, width = 2): number => {
    validate(out, cap, width);
    if (cap * width >= b.length && b.length !== 0) m.write(out, b);
    return b.length / width;
  };
  const write = (out: number, len: number): void => {
    if (out === 0) fault();
    validate(out, len);
  };
  const open = (name: Uint8Array, flags: number, vfs: bigint) => {
    const r = check(h.open(name, flags, vfs));
    return {
      code: r.code,
      handle: r.database === undefined ? NULL_HANDLE : h.databases.insert(r.database),
    };
  };
  const bind = (s: bigint, i: number, b: Uint8Array, text: boolean): number => {
    const ptr = check(h.stmt(s)).ptr;
    const input = e.allocate(b);
    try {
      return text
        ? x.mr_bind_text16(ptr, i, input.ptr, b.length)
        : x.mr_bind_blob(ptr, i, input.ptr, b.length);
    } finally {
      input.free();
    }
  };
  const columnBytes = (s: bigint, c: number, text: boolean): Uint8Array => {
    const ptr = check(h.column(s, c));
    const value = text ? x.sqlite3_column_text16(ptr, c) : x.sqlite3_column_blob(ptr, c);
    const len = text ? x.sqlite3_column_bytes16(ptr, c) : x.sqlite3_column_bytes(ptr, c);
    return value === 0 ? new Uint8Array() : e.bytes(value, len).slice();
  };
  const nameBytes = (s: bigint, c: number): Uint8Array | undefined => {
    const ptr = x.sqlite3_column_name16(check(h.column(s, c, true)), c);
    return ptr === 0 ? undefined : h.text(ptr);
  };
  const work = (raw: bigint): SqliteWork => {
    const r = pool.job(asHandle(raw));
    if (!r.ok) fault('InvalidHandle');
    if (r.value.payload.kind !== 'domain' || !(r.value.payload.work instanceof SqliteWork)) fault();
    return r.value.payload.work;
  };
  const insert = (w: SqliteWork): bigint => pool.insertJob({ kind: 'domain', work: w });
  const lease = (d: bigint, s: bigint) => {
    check(h.forJob(d));
    const key = canonical(asHandle(d));
    const stmt = check(h.stmt(s));
    if (stmt.database !== key) fault();
    return { key, stmt };
  };
  const handlers = {
    sqlite3_null_handle: () => NULL_HANDLE,
    sqlite3_open_v2: (name, len, out, flags, vfs) => {
      write(out, 8);
      m.setU64(out, NULL_HANDLE);
      const b = filename(name, len);
      const r = open(b, flags, vfs);
      m.setU64(out, r.handle);
      return r.code;
    },
    sqlite3_close: (d) => check(h.close(d)),
    sqlite3_errcode: (d) => x.sqlite3_errcode(check(h.db(d)).ptr),
    sqlite3_extended_errcode: (d) => x.sqlite3_extended_errcode(check(h.db(d)).ptr),
    sqlite3_errmsg16_length: (d) => h.message(check(h.db(d))).length / 2,
    sqlite3_errmsg16: (d, out, cap) => copy(h.message(check(h.db(d))), out, cap),
    sqlite3_changes64: (d) => x.sqlite3_changes64(check(h.ready(d)).ptr),
    sqlite3_db_mutex: (d) => check(h.mutex(d)),
    sqlite3_mutex_enter: (mutex) => check(h.enter(mutex, false)),
    sqlite3_mutex_leave: (mutex) => check(h.enter(mutex, true)),
    sqlite3_prepare16_v2: (d, sql, offset, len, out, tail) => {
      if (offset < 0 || len < 0) fault();
      write(out, 8);
      if (tail !== 0) write(tail, 4);
      m.setU64(out, NULL_HANDLE);
      if (tail !== 0) m.setU32(tail, offset);
      const b = bytes(sql, offset, len, 2);
      const r = check(h.prepare(canonical(asHandle(d)), b));
      m.setU64(out, r.statement === undefined ? NULL_HANDLE : h.statements.insert(r.statement));
      if (tail !== 0) m.setU32(tail, offset + r.tail);
      return r.code;
    },
    sqlite3_step: (s) => x.sqlite3_step(check(h.stmt(s)).ptr),
    sqlite3_reset: (s) => x.sqlite3_reset(check(h.stmt(s)).ptr),
    sqlite3_finalize: (s) => check(h.finalize(s)),
    sqlite3_clear_bindings: (s) => {
      const ptr = check(h.stmt(s)).ptr;
      return x.sqlite3_stmt_busy(ptr) !== 0 ? 21 : x.sqlite3_clear_bindings(ptr);
    },
    sqlite3_bind_null: (s, i) => x.sqlite3_bind_null(check(h.stmt(s)).ptr, i),
    sqlite3_bind_int64: (s, i, v) => x.sqlite3_bind_int64(check(h.stmt(s)).ptr, i, v),
    sqlite3_bind_double: (s, i, v) => x.sqlite3_bind_double(check(h.stmt(s)).ptr, i, v),
    sqlite3_bind_text16: (s, i, ptr, offset, len) => bind(s, i, bytes(ptr, offset, len, 2), true),
    sqlite3_bind_blob: (s, i, ptr, offset, len) => bind(s, i, bytes(ptr, offset, len), false),
    sqlite3_column_count: (s) => x.sqlite3_column_count(check(h.stmt(s)).ptr),
    sqlite3_column_type: (s, c) => x.sqlite3_column_type(check(h.column(s, c)), c),
    sqlite3_column_int64: (s, c) => x.sqlite3_column_int64(check(h.column(s, c)), c),
    sqlite3_column_double: (s, c) => x.sqlite3_column_double(check(h.column(s, c)), c),
    sqlite3_column_name16_length: (s, c) => {
      const b = nameBytes(s, c);
      return b === undefined ? -1 : b.length / 2;
    },
    sqlite3_column_name16: (s, c, out, cap) => {
      validate(out, cap, 2);
      const b = nameBytes(s, c);
      return b === undefined ? -1 : copy(b, out, cap);
    },
    sqlite3_column_text16_length: (s, c) => columnBytes(s, c, true).length / 2,
    sqlite3_column_text16: (s, c, out, cap) => copy(columnBytes(s, c, true), out, cap),
    sqlite3_column_blob_length: (s, c) => columnBytes(s, c, false).length,
    sqlite3_column_blob: (s, c, out, cap) => copy(columnBytes(s, c, false), out, cap, 1),
    sqlite3_make_open_job: (name, len, flags) =>
      insert(new SqliteWork(h, { kind: 'open', filename: filename(name, len), flags })),
    sqlite3_make_prepare_job: (d, sql, offset, len) => {
      const b = bytes(sql, offset, len, 2);
      check(h.forJob(d));
      return insert(new SqliteWork(h, { kind: 'prepare', sql: b }, canonical(asHandle(d))));
    },
    sqlite3_make_step_job: (d, s) => {
      const { key, stmt } = lease(d, s);
      return insert(
        new SqliteWork(h, { kind: 'step', ptr: stmt.ptr }, key, canonical(asHandle(s))),
      );
    },
    sqlite3_make_finalize_job: (d, s) => {
      const { key, stmt } = lease(d, s);
      h.statements.remove(asHandle(s));
      return insert(new SqliteWork(h, { kind: 'finalize', ptr: stmt.ptr }, key));
    },
    sqlite3_make_discard_job: (j) => {
      const w = check(work(j).discard());
      return w === undefined ? NULL_HANDLE : insert(w);
    },
    sqlite3_take_job_handle: (j) => check(work(j).take()),
    sqlite3_job_message16_length: (j) => check(work(j).result()).message.length / 2,
    sqlite3_job_message16: (j, out, cap) => copy(check(work(j).result()).message, out, cap),
    sqlite3_job_result: (j, out) => {
      write(out, 24);
      const r = check(work(j).result());
      m.setU32(out, r.code);
      m.setU32(out + 4, r.extended);
      m.setU32(out + 8, r.tail);
      m.setU32(out + 12, r.changes === undefined ? 0 : 1);
      m.setI64(out + 16, r.changes ?? 0n);
    },
  } satisfies Handlers;
  const imports: Record<string, ImportDef> = {};
  for (const symbol of Object.keys(SQLITE_IMPORTS) as (keyof Table)[]) {
    const entry = SQLITE_IMPORTS[symbol];
    const params = entry.params.map(([, type]) => type);
    const impl = handlers[symbol] as (...args: unknown[]) => unknown;
    const guarded = (...args: unknown[]): unknown => {
      try {
        const r = attempt(() => impl(...args));
        if (!r.ok) throw new Error(`moonbitlang/sqlite.${symbol} failed: ${r.error}`);
        return r.value;
      } catch (e) {
        if (e instanceof GuestFault) throw new Error(`moonbitlang/sqlite.${symbol} failed: Fault`);
        throw e;
      }
    };
    imports[symbol] = fn(
      params,
      entry.result,
      guarded as (...args: JsArgs<readonly ValType[]>) => never,
    );
  }
  return imports;
};
