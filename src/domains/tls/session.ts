// moonrun's TLS handle state machine (`async_host/mod.rs:3756-4039`,
// `async_host/tls/mod.rs`) on top of the rustls engine. See CONTRACT.md.
//
// A session starts `pending` (tls/connection/new) and becomes a connection
// once set_client / set_server_files succeeds. Status codes and error texts
// follow moonrun; only failures that moonrun raises as host errors
// (`AsyncHostError::Inval`) are returned as `Err`.
import type { ClockPort } from '../../ports/clock.ts';
import type { RandomPort } from '../../ports/random.ts';
import { err, type HostError, hostError, ok, type Result } from '../../ports/result.ts';
import type { TrustStorePort } from '../../ports/tls.ts';
import {
  type EngineBytes,
  type EngineConn,
  type EngineRoots,
  TlsEngine,
  type TlsFileType,
} from './engine.ts';

export const TLS_SUCCESS = 0;
export const TLS_ERROR = -1;
export const TLS_CLOSED = -2;
export const TLS_WOULD_BLOCK = -3;
export const TLS_RENEGOTIATION = -4;

/** Values returned by connect / accept (`TlsState`, tls/mod.rs:46-55). */
export const TlsState = {
  Completed: 0,
  WantRead: 1,
  WantWrite: 2,
  Error: 3,
  Eof: 4,
  ReNegotiation: 5,
} as const;

/** `TlsTrust` ABI (tls/mod.rs:105-117). */
export type TlsTrust = 0 | 1 | 2;

const UNKNOWN_ERROR = 'unknown TLS error';
const NOT_CONFIGURED = 'TLS handle is not configured';

export interface TlsDomainDeps {
  /** The compiled tls-engine.wasm; instantiated lazily, once per domain. */
  readonly engineModule: () => Result<WebAssembly.Module, string>;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly trustStore: TrustStorePort;
  /** Reads a server key / certificate file (already authorized by policy). */
  readonly readFile: (path: string) => Result<Uint8Array, HostError>;
  /**
   * Policy check before reading server files; the error string is moonrun's
   * `{error:?}` rendering. Absent = everything is readable.
   */
  readonly authorizeRead?: (path: string) => Result<void, string>;
}

type State =
  | { readonly kind: 'pending'; readonly roots: Uint8Array[]; lastError: string | undefined }
  | { readonly kind: 'connection'; readonly conn: EngineConn }
  | { readonly kind: 'freed' };

/** All TLS state of one Run: the engine instance and the system roots. */
export class TlsDomain {
  private engine: TlsEngine | undefined;
  private systemRoots: Result<EngineRoots, string> | undefined;

  private readonly deps: TlsDomainDeps;

  constructor(deps: TlsDomainDeps) {
    this.deps = deps;
  }

  /** `tls/connection/new`. */
  create(): TlsSession {
    return new TlsSession(this);
  }

  /** `tls/error/take_global`: moonrun never stores a global TLS error (mod.rs:3770-3777). */
  takeGlobalError(): string {
    return UNKNOWN_ERROR;
  }

  /** @internal */
  getEngine(): Result<TlsEngine, string> {
    if (this.engine === undefined) {
      const module = this.deps.engineModule();
      if (!module.ok) {
        return module;
      }
      const engine = TlsEngine.instantiate(module.value, this.deps);
      if (!engine.ok) {
        return engine;
      }
      this.engine = engine.value;
    }
    return ok(this.engine);
  }

  /** @internal */
  getSystemRoots(engine: TlsEngine): Result<EngineRoots, string> {
    if (this.systemRoots === undefined) {
      const roots = this.deps.trustStore.systemRoots();
      this.systemRoots = roots.ok
        ? engine.newRoots(roots.value, false)
        : err(roots.error.message ?? roots.error.code);
    }
    return this.systemRoots;
  }

  /** @internal */
  get files(): Pick<TlsDomainDeps, 'readFile' | 'authorizeRead'> {
    return this.deps;
  }
}

export class TlsSession {
  private state: State = { kind: 'pending', roots: [], lastError: undefined };

  private readonly domain: TlsDomain;

  /** @internal */
  constructor(domain: TlsDomain) {
    this.domain = domain;
  }

  private connected(): { engine: TlsEngine; conn: EngineConn } | undefined {
    if (this.state.kind === 'connection') {
      const engine = this.domain.getEngine();
      if (engine.ok) {
        return { engine: engine.value, conn: this.state.conn };
      }
    }
    if (this.state.kind === 'pending') {
      this.state.lastError = NOT_CONFIGURED;
    }
    return undefined;
  }

  private pendingError(message: string): number {
    if (this.state.kind === 'pending') {
      this.state.lastError = message;
    }
    return TLS_ERROR;
  }

  /** `tls/connection/set_client` (mod.rs:3787-3806, openssl.rs:55-100). */
  setClient(host: string, sni: boolean, trust: number): Result<number, HostError> {
    if (trust !== 0 && trust !== 1 && trust !== 2) {
      return err(hostError('EINVAL'));
    }
    const state = this.state;
    if (state.kind !== 'pending') {
      return err(hostError('EINVAL'));
    }
    if (trust !== 2 && state.roots.length > 0) {
      return ok(this.pendingError('TLS root certificates require custom root trust'));
    }
    const engine = this.domain.getEngine();
    if (!engine.ok) {
      return ok(this.pendingError(`failed to create TLS client context: ${engine.error}`));
    }
    let roots: EngineRoots | null = null;
    let ownedRoots = false;
    if (trust === 1) {
      const system = this.domain.getSystemRoots(engine.value);
      if (!system.ok) {
        return ok(this.pendingError(`failed to load system TLS roots: ${system.error}`));
      }
      roots = system.value;
    } else if (trust === 2) {
      const custom = engine.value.newRoots(state.roots, true);
      if (!custom.ok) {
        return ok(this.pendingError(custom.error));
      }
      roots = custom.value;
      ownedRoots = true;
    }
    const conn = engine.value.newClient(host, sni, roots);
    if (ownedRoots && roots !== null) {
      engine.value.freeRoots(roots); // the connection keeps its own reference
    }
    if (!conn.ok) {
      return ok(this.pendingError(conn.error));
    }
    this.state = { kind: 'connection', conn: conn.value };
    return ok(TLS_SUCCESS);
  }

  /** `tls/connection/add_root_certificate` (tls/mod.rs:167-171): DER, parsed at set_client. */
  addRootCertificate(der: Uint8Array): Result<number, HostError> {
    if (this.state.kind !== 'pending') {
      return err(hostError('EINVAL'));
    }
    this.state.lastError = undefined;
    this.state.roots.push(der.slice());
    return ok(TLS_SUCCESS);
  }

  /** `tls/connection/set_server_files` (mod.rs:3816-3856, openssl.rs:102-145). */
  setServerFiles(
    privateKeyFile: string,
    privateKeyType: number,
    certificateFile: string,
    certificateType: number,
  ): Result<number, HostError> {
    if (!isFileType(privateKeyType) || !isFileType(certificateType)) {
      return err(hostError('EINVAL'));
    }
    const { readFile, authorizeRead } = this.domain.files;
    if (authorizeRead !== undefined) {
      for (const [label, path] of [
        ['TLS private key', privateKeyFile],
        ['TLS certificate', certificateFile],
      ] as const) {
        const allowed = authorizeRead(path);
        if (!allowed.ok) {
          if (this.state.kind !== 'pending') {
            return err(hostError('EINVAL'));
          }
          return ok(this.pendingError(`failed to access ${label} file: ${allowed.error}`));
        }
      }
    }
    const state = this.state;
    if (state.kind !== 'pending') {
      return err(hostError('EINVAL'));
    }
    if (state.roots.length > 0) {
      return ok(this.pendingError('TLS root certificates require client custom root trust'));
    }
    const certificate = readFile(certificateFile);
    if (!certificate.ok) {
      const what = certificateType === 1 ? 'TLS certificate chain' : 'TLS certificate';
      return ok(this.pendingError(`failed to load ${what}: ${describe(certificate.error)}`));
    }
    const privateKey = readFile(privateKeyFile);
    if (!privateKey.ok) {
      return ok(this.pendingError(`failed to load TLS private key: ${describe(privateKey.error)}`));
    }
    const engine = this.domain.getEngine();
    if (!engine.ok) {
      return ok(this.pendingError(`failed to create TLS server context: ${engine.error}`));
    }
    const conn = engine.value.newServer(
      certificate.value,
      certificateType,
      privateKey.value,
      privateKeyType,
    );
    if (!conn.ok) {
      return ok(this.pendingError(conn.error));
    }
    this.state = { kind: 'connection', conn: conn.value };
    return ok(TLS_SUCCESS);
  }

  /**
   * `tls/connection/set_server_pfx` (mod.rs:3858-3880). moonrun on Linux has
   * no PKCS#12 support (openssl.rs:116-123); moonrun-js always behaves as Linux.
   */
  setServerPfx(_pfx: Uint8Array): Result<number, HostError> {
    const state = this.state;
    if (state.kind !== 'pending') {
      return err(hostError('EINVAL'));
    }
    if (state.roots.length > 0) {
      return ok(this.pendingError('TLS root certificates require client custom root trust'));
    }
    return ok(
      this.pendingError('TLS PFX server certificates are supported only by SChannel on Windows'),
    );
  }

  /** `tls/connection/connect`: a `TlsState` code. */
  connect(input: Uint8Array, output: Uint8Array): number {
    const c = this.connected();
    return c === undefined ? TlsState.Error : c.engine.connect(c.conn, input, output);
  }

  /** `tls/connection/accept`: a `TlsState` code. */
  accept(input: Uint8Array, output: Uint8Array): number {
    const c = this.connected();
    return c === undefined ? TlsState.Error : c.engine.accept(c.conn, input, output);
  }

  /** `tls/connection/read_plain`: plaintext length or a negative status. */
  readPlain(input: Uint8Array, output: Uint8Array, plain: Uint8Array): number {
    const c = this.connected();
    return c === undefined ? TLS_ERROR : c.engine.readPlain(c.conn, input, output, plain);
  }

  /** `tls/connection/write_plain`: plaintext accepted or a negative status. `input` is not consumed. */
  writePlain(_input: Uint8Array, output: Uint8Array, plain: Uint8Array): number {
    const c = this.connected();
    return c === undefined ? TLS_ERROR : c.engine.writePlain(c.conn, output, plain);
  }

  bytesRead(): number {
    const c = this.connected();
    return c === undefined ? 0 : c.engine.bytesRead(c.conn);
  }

  bytesToWrite(): number {
    const c = this.connected();
    return c === undefined ? 0 : c.engine.bytesToWrite(c.conn);
  }

  wantsRead(): boolean {
    const c = this.connected();
    return c === undefined ? false : c.engine.wantsRead(c.conn);
  }

  wantsWrite(): boolean {
    const c = this.connected();
    return c === undefined ? false : c.engine.wantsWrite(c.conn);
  }

  /** `tls/connection/shutdown`: only marks the session; close_notify goes out on the next connect/accept. */
  shutdown(): number {
    const c = this.connected();
    return c === undefined ? TLS_ERROR : c.engine.shutdown(c.conn);
  }

  /**
   * `tls/connection/peer_certificate`: DER, an empty array when there is none,
   * or `null` on error (the guest then calls take_error).
   */
  peerCertificate(): Uint8Array | null {
    const c = this.connected();
    if (c === undefined) {
      return null;
    }
    return bytesOrEmpty(c.engine.peerCertificate(c.conn));
  }

  /** `tls/connection/unique_channel_binding`: `null` when unavailable or on error. */
  uniqueChannelBinding(): Uint8Array | null {
    const c = this.connected();
    return c === undefined ? null : bytesOrNull(c.engine.uniqueChannelBinding(c.conn));
  }

  /** `tls/connection/server_endpoint_channel_binding`: `null` when unavailable or on error. */
  serverEndpointChannelBinding(): Uint8Array | null {
    const c = this.connected();
    return c === undefined ? null : bytesOrNull(c.engine.serverEndpointChannelBinding(c.conn));
  }

  /** `tls/connection/take_error` (mod.rs:3756-3768). */
  takeError(): string {
    switch (this.state.kind) {
      case 'pending': {
        const message = this.state.lastError ?? UNKNOWN_ERROR;
        this.state.lastError = undefined;
        return message;
      }
      case 'connection': {
        const engine = this.domain.getEngine();
        return (engine.ok ? engine.value.takeError(this.state.conn) : undefined) ?? UNKNOWN_ERROR;
      }
      case 'freed':
        return UNKNOWN_ERROR;
    }
  }

  /** `tls/connection/free`. */
  free(): void {
    if (this.state.kind === 'connection') {
      const engine = this.domain.getEngine();
      if (engine.ok) {
        engine.value.freeConnection(this.state.conn);
      }
    }
    this.state = { kind: 'freed' };
  }
}

function isFileType(value: number): value is TlsFileType {
  return value === 1 || value === 2;
}

function describe(error: HostError): string {
  return error.message ?? error.code;
}

function bytesOrEmpty(result: EngineBytes): Uint8Array | null {
  switch (result.kind) {
    case 'some':
      return result.bytes;
    case 'none':
      return new Uint8Array(0);
    case 'error':
      return null;
  }
}

function bytesOrNull(result: EngineBytes): Uint8Array | null {
  return result.kind === 'some' ? result.bytes : null;
}
