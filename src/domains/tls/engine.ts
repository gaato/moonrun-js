// Synchronous wrapper around one instance of tls-engine.wasm (crates/tls-engine).
// The engine has its own linear memory: inputs are copied in, outputs copied
// out. Views of the engine memory are recreated after every call because the
// engine may grow its memory.
import type { ClockPort } from '../../ports/clock.ts';
import type { RandomPort } from '../../ports/random.ts';
import { err, ok, type Result } from '../../ports/result.ts';

declare const connBrand: unique symbol;
declare const rootsBrand: unique symbol;
/** A connection inside one engine instance. */
export type EngineConn = number & { readonly [connBrand]: true };
/** A parsed root store inside one engine instance. */
export type EngineRoots = number & { readonly [rootsBrand]: true };

/** `TlsFileType` ABI values (moonrun `tls/mod.rs:86-87`). */
export type TlsFileType = 1 | 2;

/** Outcome of the certificate / channel-binding queries. */
export type EngineBytes =
  | { readonly kind: 'some'; readonly bytes: Uint8Array }
  | { readonly kind: 'none' }
  | { readonly kind: 'error' };

interface Exports {
  readonly memory: WebAssembly.Memory;
  tls_alloc(len: number): number;
  tls_dealloc(ptr: number, len: number): void;
  tls_result_ptr(): number;
  tls_result_len(): number;
  tls_roots_new(ptr: number, len: number, strict: number): number;
  tls_roots_free(id: number): void;
  tls_client_new(host: number, hostLen: number, sni: number, verify: number, roots: number): number;
  tls_server_new(
    cert: number,
    certLen: number,
    certType: number,
    key: number,
    keyLen: number,
    keyType: number,
  ): number;
  tls_conn_free(id: number): void;
  tls_connect(
    id: number,
    input: number,
    inputLen: number,
    output: number,
    outputLen: number,
  ): number;
  tls_accept(
    id: number,
    input: number,
    inputLen: number,
    output: number,
    outputLen: number,
  ): number;
  tls_read_plain(
    id: number,
    input: number,
    inputLen: number,
    output: number,
    outputLen: number,
    plain: number,
    plainLen: number,
  ): number;
  tls_write_plain(
    id: number,
    output: number,
    outputLen: number,
    plain: number,
    plainLen: number,
  ): number;
  tls_bytes_read(id: number): number;
  tls_bytes_to_write(id: number): number;
  tls_wants_read(id: number): number;
  tls_wants_write(id: number): number;
  tls_shutdown(id: number): number;
  tls_take_error(id: number): number;
  tls_peer_certificate(id: number): number;
  tls_unique_channel_binding(id: number): number;
  tls_server_endpoint_channel_binding(id: number): number;
}

const STATE_ERROR = 3;
const FAULT_BYTES: EngineBytes = { kind: 'error' };

const REQUIRED_EXPORTS = [
  'memory',
  'tls_alloc',
  'tls_dealloc',
  'tls_result_ptr',
  'tls_result_len',
  'tls_roots_new',
  'tls_roots_free',
  'tls_client_new',
  'tls_server_new',
  'tls_conn_free',
  'tls_connect',
  'tls_accept',
  'tls_read_plain',
  'tls_write_plain',
  'tls_bytes_read',
  'tls_bytes_to_write',
  'tls_wants_read',
  'tls_wants_write',
  'tls_shutdown',
  'tls_take_error',
  'tls_peer_certificate',
  'tls_unique_channel_binding',
  'tls_server_endpoint_channel_binding',
] as const;

/** A growable region of engine memory reused across calls. */
class Scratch {
  ptr = 0;
  capacity = 0;
  private readonly x: Exports;
  constructor(x: Exports) {
    this.x = x;
  }

  /** Ensures `len` bytes; may grow (and thus detach) engine memory. */
  reserve(len: number): number {
    if (len > this.capacity) {
      if (this.capacity > 0) {
        this.x.tls_dealloc(this.ptr, this.capacity);
      }
      const capacity = Math.max(len, 4096, this.capacity * 2);
      this.ptr = this.x.tls_alloc(capacity);
      this.capacity = capacity;
    }
    return this.ptr;
  }
}

export interface TlsEngineDeps {
  readonly clock: ClockPort;
  readonly random: RandomPort;
}

export class TlsEngine {
  private readonly input: Scratch;
  private readonly output: Scratch;
  private readonly plain: Scratch;
  private readonly x: Exports;

  private constructor(x: Exports) {
    this.x = x;
    this.input = new Scratch(x);
    this.output = new Scratch(x);
    this.plain = new Scratch(x);
  }

  /** Instantiates the engine module. One instance serves every connection of a Run. */
  static instantiate(module: WebAssembly.Module, deps: TlsEngineDeps): Result<TlsEngine, string> {
    let memory: WebAssembly.Memory | undefined;
    const env = {
      now_unix_ms: (): number => deps.clock.nowMs(),
      random_fill: (ptr: number, len: number): void => {
        if (memory === undefined) {
          throw new Error('tls-engine requested randomness before instantiation finished');
        }
        deps.random.fill(new Uint8Array(memory.buffer, ptr, len));
      },
    };
    let instance: WebAssembly.Instance;
    try {
      instance = new WebAssembly.Instance(module, { env });
    } catch (error) {
      return err(`failed to instantiate tls-engine.wasm: ${String(error)}`);
    }
    const exports = instance.exports;
    for (const name of REQUIRED_EXPORTS) {
      if (!(name in exports)) {
        return err(`tls-engine.wasm does not export ${name}`);
      }
    }
    const x = exports as unknown as Exports;
    memory = x.memory;
    return ok(new TlsEngine(x));
  }

  private bytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, ptr, len);
  }

  private copyIn(scratch: Scratch, data: Uint8Array): number {
    const ptr = scratch.reserve(data.length);
    this.bytes(ptr, data.length).set(data);
    return ptr;
  }

  private result(): Uint8Array {
    return this.bytes(this.x.tls_result_ptr(), this.x.tls_result_len()).slice();
  }

  private resultText(): string {
    return new TextDecoder().decode(this.result());
  }

  /**
   * A trap (a Rust panic or an engine bug) leaves the instance's state
   * inconsistent, so the first one poisons the engine: every later call
   * fails with the given fallback and take_error reports the fault.
   */
  private fault: string | undefined;

  private guard<T>(fallback: () => T, f: () => T): T {
    if (this.fault !== undefined) {
      return fallback();
    }
    try {
      return f();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        this.fault = error.message;
        return fallback();
      }
      throw error;
    }
  }

  private faultError(): Result<never, string> {
    return err(`TLS engine fault: ${this.fault ?? 'trap'}`);
  }

  /** `strict`: every DER must parse (custom roots); otherwise bad entries are skipped. */
  newRoots(ders: readonly Uint8Array[], strict: boolean): Result<EngineRoots, string> {
    return this.guard(
      () => this.faultError(),
      () => {
        const total = ders.reduce((n, d) => n + 4 + d.length, 0);
        const encoded = new Uint8Array(total);
        const view = new DataView(encoded.buffer);
        let at = 0;
        for (const der of ders) {
          view.setUint32(at, der.length, true);
          encoded.set(der, at + 4);
          at += 4 + der.length;
        }
        const ptr = this.copyIn(this.input, encoded);
        const id = this.x.tls_roots_new(ptr, total, strict ? 1 : 0);
        return id === 0 ? err(this.resultText()) : ok(id as EngineRoots);
      },
    );
  }

  freeRoots(roots: EngineRoots): void {
    this.guard(
      () => undefined,
      () => {
        this.x.tls_roots_free(roots);
      },
    );
  }

  /** `roots` = null for trust mode 0 (no verification). */
  newClient(host: string, sni: boolean, roots: EngineRoots | null): Result<EngineConn, string> {
    return this.guard(
      () => this.faultError(),
      () => {
        const encoded = new TextEncoder().encode(host);
        const ptr = this.copyIn(this.input, encoded);
        const id = this.x.tls_client_new(
          ptr,
          encoded.length,
          sni ? 1 : 0,
          roots === null ? 0 : 1,
          roots ?? 0,
        );
        return id === 0 ? err(this.resultText()) : ok(id as EngineConn);
      },
    );
  }

  newServer(
    certificate: Uint8Array,
    certificateType: TlsFileType,
    privateKey: Uint8Array,
    privateKeyType: TlsFileType,
  ): Result<EngineConn, string> {
    return this.guard(
      () => this.faultError(),
      () => {
        const certPtr = this.copyIn(this.input, certificate);
        const keyPtr = this.copyIn(this.plain, privateKey);
        const id = this.x.tls_server_new(
          certPtr,
          certificate.length,
          certificateType,
          keyPtr,
          privateKey.length,
          privateKeyType,
        );
        return id === 0 ? err(this.resultText()) : ok(id as EngineConn);
      },
    );
  }

  freeConnection(conn: EngineConn): void {
    this.guard(
      () => undefined,
      () => {
        this.x.tls_conn_free(conn);
      },
    );
  }

  private handshakeStep(
    fn: (id: number, i: number, il: number, o: number, ol: number) => number,
    conn: EngineConn,
    input: Uint8Array,
    output: Uint8Array,
  ): number {
    const inPtr = this.input.reserve(input.length);
    const outPtr = this.output.reserve(output.length);
    this.bytes(inPtr, input.length).set(input);
    const state = fn(conn, inPtr, input.length, outPtr, output.length);
    this.copyOut(conn, outPtr, output);
    return state;
  }

  private copyOut(conn: EngineConn, outPtr: number, output: Uint8Array): void {
    const n = this.x.tls_bytes_to_write(conn);
    if (n > 0) {
      output.set(this.bytes(outPtr, n));
    }
  }

  /** Returns a `TlsState` code (0..5); see CONTRACT.md. */
  connect(conn: EngineConn, input: Uint8Array, output: Uint8Array): number {
    return this.guard(
      () => STATE_ERROR,
      () => {
        return this.handshakeStep((...a) => this.x.tls_connect(...a), conn, input, output);
      },
    );
  }

  accept(conn: EngineConn, input: Uint8Array, output: Uint8Array): number {
    return this.guard(
      () => STATE_ERROR,
      () => {
        return this.handshakeStep((...a) => this.x.tls_accept(...a), conn, input, output);
      },
    );
  }

  /** Returns plaintext bytes written to `plain` or a negative status. */
  readPlain(conn: EngineConn, input: Uint8Array, output: Uint8Array, plain: Uint8Array): number {
    return this.guard(
      () => -1,
      () => {
        const inPtr = this.input.reserve(input.length);
        const outPtr = this.output.reserve(output.length);
        const plainPtr = this.plain.reserve(plain.length);
        this.bytes(inPtr, input.length).set(input);
        const n = this.x.tls_read_plain(
          conn,
          inPtr,
          input.length,
          outPtr,
          output.length,
          plainPtr,
          plain.length,
        );
        this.copyOut(conn, outPtr, output);
        if (n > 0) {
          plain.set(this.bytes(plainPtr, n));
        }
        return n;
      },
    );
  }

  /** Returns plaintext bytes accepted from `plain` or a negative status. Never consumes input. */
  writePlain(conn: EngineConn, output: Uint8Array, plain: Uint8Array): number {
    return this.guard(
      () => -1,
      () => {
        const outPtr = this.output.reserve(output.length);
        const plainPtr = this.plain.reserve(plain.length);
        this.bytes(plainPtr, plain.length).set(plain);
        const n = this.x.tls_write_plain(conn, outPtr, output.length, plainPtr, plain.length);
        this.copyOut(conn, outPtr, output);
        return n;
      },
    );
  }

  bytesRead(conn: EngineConn): number {
    return this.guard(
      () => 0,
      () => {
        return this.x.tls_bytes_read(conn);
      },
    );
  }

  bytesToWrite(conn: EngineConn): number {
    return this.guard(
      () => 0,
      () => {
        return this.x.tls_bytes_to_write(conn);
      },
    );
  }

  wantsRead(conn: EngineConn): boolean {
    return this.guard(
      () => false,
      () => {
        return this.x.tls_wants_read(conn) !== 0;
      },
    );
  }

  wantsWrite(conn: EngineConn): boolean {
    return this.guard(
      () => false,
      () => {
        return this.x.tls_wants_write(conn) !== 0;
      },
    );
  }

  shutdown(conn: EngineConn): number {
    return this.guard(
      () => -1,
      () => {
        return this.x.tls_shutdown(conn);
      },
    );
  }

  takeError(conn: EngineConn): string | undefined {
    if (this.fault !== undefined) {
      return `TLS engine fault: ${this.fault}`;
    }
    return this.guard(
      () => undefined,
      () => (this.x.tls_take_error(conn) === 1 ? this.resultText() : undefined),
    );
  }

  private query(status: number): EngineBytes {
    if (status === 1) {
      return { kind: 'some', bytes: this.result() };
    }
    return status === 0 ? { kind: 'none' } : { kind: 'error' };
  }

  peerCertificate(conn: EngineConn): EngineBytes {
    return this.guard(
      () => FAULT_BYTES,
      () => {
        return this.query(this.x.tls_peer_certificate(conn));
      },
    );
  }

  uniqueChannelBinding(conn: EngineConn): EngineBytes {
    return this.guard(
      () => FAULT_BYTES,
      () => {
        return this.query(this.x.tls_unique_channel_binding(conn));
      },
    );
  }

  serverEndpointChannelBinding(conn: EngineConn): EngineBytes {
    return this.guard(
      () => FAULT_BYTES,
      () => {
        return this.query(this.x.tls_server_endpoint_channel_binding(conn));
      },
    );
  }
}
