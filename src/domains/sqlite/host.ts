// SQLite Host payloads and lifetimes (moonrun sqlite/{connection,statement,mutex,jobs}).
import {
  asHandle,
  canonical,
  type Handle,
  Handles,
  type HostKeys,
  NULL_HANDLE,
} from '../../kernel/handles.ts';
import type { DomainWork } from '../../kernel/job.ts';
import { err, ok, type Result } from '../../ports/result.ts';
import type { EngineHooks } from './engine.ts';
import { SqliteEngine } from './engine.ts';
import type { VfsDeps } from './vfs.ts';

export type SqliteError = 'InvalidHandle' | 'Fault' | 'Overflow';
export interface Database {
  ptr: number;
  ready: boolean;
  mutex: Handle | undefined;
}
export interface Statement {
  ptr: number;
  database: Handle;
}
interface Mutex {
  database: Handle;
  depth: number;
}
export interface Outcome {
  code: number;
  extended: number;
  message: Uint8Array;
  tail: number;
  changes: bigint | undefined;
  owned:
    | { kind: 'database'; value: Database }
    | { kind: 'statement'; value: Statement }
    | undefined;
}
export class SqliteHost {
  readonly engine: SqliteEngine;
  readonly databases: Handles<Database>;
  readonly statements: Handles<Statement>;
  readonly mutexes: Handles<Mutex>;
  readonly leases = new Set<SqliteWork>();
  readonly admit: (filename: Uint8Array, flags: number, vfs: bigint) => number;
  constructor(
    keys: HostKeys,
    module: WebAssembly.Module,
    deps: VfsDeps,
    hooks: EngineHooks,
    admit: (filename: Uint8Array, flags: number, vfs: bigint) => number,
  ) {
    this.admit = admit;
    this.engine = new SqliteEngine(module, deps, hooks);
    this.databases = new Handles(keys, 'sqlite-database');
    this.statements = new Handles(keys, 'sqlite-statement');
    this.mutexes = new Handles(keys, 'sqlite-database-mutex');
  }
  db(raw: bigint): Result<Database, SqliteError> {
    const database = this.databases.get(asHandle(raw));
    return database === undefined ? err('InvalidHandle') : ok(database);
  }
  stmt(raw: bigint): Result<Statement, SqliteError> {
    const key = canonical(asHandle(raw));
    const statement = this.statements.get(key);
    if (statement === undefined) return err('InvalidHandle');
    if ([...this.leases].some((w) => w.statement === key)) return err('Fault');
    return ok(statement);
  }
  ready(raw: bigint): Result<Database, SqliteError> {
    const database = this.db(raw);
    if (!database.ok) return database;
    return database.value.ready ? database : err('Fault');
  }
  entered(database: Database): boolean {
    return database.mutex !== undefined && (this.mutexes.get(database.mutex)?.depth ?? 0) !== 0;
  }
  forJob(raw: bigint): Result<Database, SqliteError> {
    const database = this.ready(raw);
    if (!database.ok) return database;
    return this.entered(database.value) ? err('Fault') : database;
  }
  open(
    filename: Uint8Array,
    flags: number,
    vfs: bigint,
  ): Result<{ code: number; database: Database | undefined }, SqliteError> {
    const normalized = this.admit(filename, flags, vfs);
    if (normalized < 0) return ok({ code: -normalized, database: undefined });
    const e = this.engine;
    const name = e.allocate(filename, 1);
    const out = e.scratch(4);
    e.bytes(out, 4).fill(0);
    let code = e.x.sqlite3_open_v2(name.ptr, out, normalized, 0);
    name.free();
    const ptr = e.u32(out);
    if (ptr === 0) return ok({ code, database: undefined });
    if (code === 0) code = e.x.mr_set_authorizer(ptr);
    return ok({ code, database: { ptr, ready: code === 0, mutex: undefined } });
  }
  close(raw: bigint): Result<number, SqliteError> {
    if (raw === NULL_HANDLE) return ok(0);
    const key = canonical(asHandle(raw));
    const found = this.db(raw);
    if (!found.ok) return found;
    const db = found.value;
    if (this.entered(db) || [...this.leases].some((w) => w.database === key)) return err('Fault');
    const code = this.engine.x.sqlite3_close(db.ptr);
    if (code === 0) {
      this.databases.remove(key);
      if (db.mutex !== undefined) this.mutexes.remove(db.mutex);
    }
    return ok(code);
  }
  prepare(
    database: Handle,
    sql: Uint8Array,
  ): Result<{ code: number; statement: Statement | undefined; tail: number }, SqliteError> {
    const found = this.db(database);
    if (!found.ok) return found;
    const db = found.value;
    if (!db.ready) return ok({ code: 21, statement: undefined, tail: 0 });
    if (sql.length > 0x7fffffff) return err('Overflow');
    const e = this.engine;
    const input = e.allocate(sql, 2);
    const out = e.scratch(8);
    e.bytes(out, 8).fill(0);
    const code = e.x.sqlite3_prepare16_v2(db.ptr, input.ptr, sql.length, out, out + 4);
    const ptr = e.u32(out);
    const tailPtr = e.u32(out + 4);
    const tail = tailPtr === 0 ? 0 : (tailPtr - input.ptr) / 2;
    input.free();
    return ok({ code, statement: ptr === 0 ? undefined : { ptr, database }, tail });
  }
  finalize(raw: bigint): Result<number, SqliteError> {
    if (raw === NULL_HANDLE) return ok(0);
    const stmt = this.stmt(raw);
    if (!stmt.ok) return stmt;
    this.statements.remove(asHandle(raw));
    return ok(this.engine.x.sqlite3_finalize(stmt.value.ptr));
  }
  mutex(raw: bigint): Result<Handle, SqliteError> {
    const found = this.ready(raw);
    if (!found.ok) return found;
    const db = found.value;
    if (db.mutex !== undefined) return ok(db.mutex);
    if (this.engine.x.sqlite3_db_mutex(db.ptr) === 0) return ok(NULL_HANDLE);
    db.mutex = this.mutexes.insert({ database: canonical(asHandle(raw)), depth: 0 });
    return ok(db.mutex);
  }
  enter(raw: bigint, leave: boolean): Result<void, SqliteError> {
    if (raw === NULL_HANDLE) return ok(undefined);
    const mutex = this.mutexes.get(asHandle(raw));
    if (mutex === undefined) return err('InvalidHandle');
    const db = this.db(mutex.database);
    if (!db.ok) return db;
    if (leave && mutex.depth === 0) return err('Fault');
    const ptr = this.engine.x.sqlite3_db_mutex(db.value.ptr);
    if (leave) {
      this.engine.x.sqlite3_mutex_leave(ptr);
      mutex.depth--;
    } else {
      this.engine.x.sqlite3_mutex_enter(ptr);
      mutex.depth++;
    }
    return ok(undefined);
  }
  column(raw: bigint, column: number, metadata = false): Result<number, SqliteError> {
    const stmt = this.stmt(raw);
    if (!stmt.ok) return stmt;
    const ptr = stmt.value.ptr;
    const count = metadata
      ? this.engine.x.sqlite3_column_count(ptr)
      : this.engine.x.sqlite3_data_count(ptr);
    return column < 0 || column >= count ? err('Fault') : ok(ptr);
  }
  text(ptr: number): Uint8Array {
    return ptr === 0
      ? new Uint8Array()
      : this.engine.bytes(ptr, this.engine.utf16Length(ptr) * 2).slice();
  }
  message(db: Database): Uint8Array {
    return this.text(this.engine.x.sqlite3_errmsg16(db.ptr));
  }
  summary(): string | undefined {
    const parts: string[] = [];
    if (this.databases.size !== 0) parts.push(`databases=${this.databases.size}`);
    if (this.statements.size !== 0) parts.push(`statements=${this.statements.size}`);
    return parts.length === 0 ? undefined : `sqlite(${parts.join(', ')})`;
  }
  dispose(): void {
    for (const mutex of this.mutexes.takeAll()) {
      const db = this.databases.get(mutex.database);
      if (db === undefined) continue;
      const ptr = this.engine.x.sqlite3_db_mutex(db.ptr);
      for (let i = 0; i < mutex.depth; i++) this.engine.x.sqlite3_mutex_leave(ptr);
    }
    for (const w of [...this.leases]) w.release();
    for (const s of this.statements.takeAll()) this.engine.x.sqlite3_finalize(s.ptr);
    for (const db of this.databases.takeAll()) this.engine.x.sqlite3_close(db.ptr);
    this.engine.vfs.closeAll();
  }
}

export type WorkInput =
  | { kind: 'open'; filename: Uint8Array; flags: number }
  | { kind: 'prepare'; sql: Uint8Array }
  | { kind: 'step'; ptr: number }
  | { kind: 'finalize'; ptr: number }
  | { kind: 'close'; ptr: number };
/** One-shot pool work. Its lease survives execution until the Job is released. */
export class SqliteWork implements DomainWork {
  outcome: Outcome | undefined;
  #error: SqliteError = 'Fault';
  #input: WorkInput | undefined;
  readonly host: SqliteHost;
  readonly database: Handle | undefined;
  readonly statement: Handle | undefined;
  constructor(
    host: SqliteHost,
    input: WorkInput,
    database: Handle | undefined = undefined,
    statement: Handle | undefined = undefined,
  ) {
    this.host = host;
    this.database = database;
    this.statement = statement;
    this.#input = input;
    host.leases.add(this);
  }
  start(finish: (ret: number) => void): void {
    const input = this.#input;
    if (input === undefined) {
      finish(-1);
      return;
    }
    this.#input = undefined;
    const h = this.host;
    const e = h.engine;
    const x = e.x;
    const result: Outcome = {
      code: 0,
      extended: 0,
      message: new Uint8Array(),
      tail: -1,
      changes: undefined,
      owned: undefined,
    };
    const failed = (error: SqliteError): void => {
      this.#error = error;
      finish(-1);
    };
    const database = this.database === undefined ? ok(undefined) : h.db(this.database);
    if (!database.ok) {
      failed(database.error);
      return;
    }
    let db = database.value;
    switch (input.kind) {
      case 'open': {
        const opening = h.open(input.filename, input.flags, NULL_HANDLE);
        if (!opening.ok) {
          failed(opening.error);
          return;
        }
        const opened = opening.value;
        result.code = opened.code;
        db = opened.database;
        if (db !== undefined && result.code === 0) result.owned = { kind: 'database', value: db };
        break;
      }
      case 'prepare': {
        if (this.database === undefined) {
          failed('Fault');
          return;
        }
        const preparing = h.prepare(this.database, input.sql);
        if (!preparing.ok) {
          failed(preparing.error);
          return;
        }
        const prepared = preparing.value;
        result.code = prepared.code;
        if (prepared.statement !== undefined) {
          result.tail = prepared.tail;
          result.owned = { kind: 'statement', value: prepared.statement };
        }
        break;
      }
      case 'step': {
        if (db === undefined) {
          failed('Fault');
          return;
        }
        const readOnly = x.sqlite3_stmt_readonly(input.ptr) !== 0;
        const before = x.sqlite3_total_changes64(db.ptr);
        result.code = x.sqlite3_step(input.ptr);
        if (result.code === 101 && !readOnly)
          result.changes =
            before === x.sqlite3_total_changes64(db.ptr) ? 0n : x.sqlite3_changes64(db.ptr);
        break;
      }
      case 'finalize':
        result.code = x.sqlite3_finalize(input.ptr);
        break;
      case 'close':
        x.sqlite3_close(input.ptr);
        break;
    }
    result.extended = result.code;
    if (result.code !== 0 && result.code !== 100 && result.code !== 101 && db !== undefined) {
      result.extended = x.sqlite3_extended_errcode(db.ptr);
      result.message = h.message(db);
      if (input.kind === 'open') x.sqlite3_close(db.ptr);
    }
    this.outcome = result;
    finish(result.code);
  }
  result(): Result<Outcome, SqliteError> {
    return this.outcome === undefined ? err(this.#error) : ok(this.outcome);
  }
  take(): Result<Handle, SqliteError> {
    const result = this.result();
    if (!result.ok) return result;
    const r = result.value;
    if (r.code !== 0 || r.owned === undefined) return err('Fault');
    const owned = r.owned;
    r.owned = undefined;
    return ok(
      owned.kind === 'database'
        ? this.host.databases.insert(owned.value)
        : this.host.statements.insert(owned.value),
    );
  }
  discard(): Result<SqliteWork | undefined, SqliteError> {
    const result = this.result();
    if (!result.ok) return result;
    const r = result.value;
    const owned = r.owned;
    if (owned === undefined) return ok(undefined);
    r.owned = undefined;
    return ok(
      new SqliteWork(
        this.host,
        { kind: owned.kind === 'database' ? 'close' : 'finalize', ptr: owned.value.ptr },
        this.database,
      ),
    );
  }
  release(): void {
    if (!this.host.leases.delete(this)) return;
    const owned = this.outcome?.owned;
    if (owned?.kind === 'database') this.host.engine.x.sqlite3_close(owned.value.ptr);
    if (owned?.kind === 'statement') this.host.engine.x.sqlite3_finalize(owned.value.ptr);
    if (this.#input?.kind === 'finalize') this.host.engine.x.sqlite3_finalize(this.#input.ptr);
    if (this.#input?.kind === 'close') this.host.engine.x.sqlite3_close(this.#input.ptr);
    if (this.outcome !== undefined) this.outcome.owned = undefined;
    this.#input = undefined;
  }
}
