// Test harness: drives a TlsSession exactly like moonbitlang/async's
// src/tls/tls.wasm.mbt does (connect/accept loop, `_direct_read`,
// `write_once`, shutdown), over an in-memory byte stream.
import { randomFillSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import {
  TlsDomain,
  type TlsDomainDeps,
  type TlsSession,
  TlsState,
} from '../../src/domains/tls/index.ts';
import { nodeTlsEngineModule } from '../../src/hosts/node/tls-engine.ts';
import { err, hostError, ok } from '../../src/ports/result.ts';
import { emptyTrustStore, type TrustStorePort } from '../../src/ports/tls.ts';

export const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/tls');
export const fixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

export function pemToDer(pem: string | Buffer): Uint8Array[] {
  const text = pem.toString();
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    (m) => new Uint8Array(Buffer.from((m[1] ?? '').replace(/\s+/g, ''), 'base64')),
  );
}

export function makeDomain(
  trustStore: TrustStorePort = emptyTrustStore,
  overrides: Partial<TlsDomainDeps> = {},
): TlsDomain {
  return new TlsDomain({
    engineModule: nodeTlsEngineModule,
    clock: { nowMs: () => Date.now(), monotonicNs: () => process.hrtime.bigint() },
    random: { fill: (b) => void randomFillSync(b) },
    trustStore,
    readFile: (file) => {
      try {
        return ok(new Uint8Array(readFileSync(path.resolve(FIXTURES, file))));
      } catch (error) {
        return err(hostError('ENOENT', String(error)));
      }
    },
    ...overrides,
  });
}

/** One end of an in-memory byte pipe, as the guest's transport sees it. */
export class Transport {
  readonly inbox: Buffer[] = [];
  private waiter: (() => void) | undefined;
  ended = false;
  readonly peer: Duplex;
  constructor(peer: Duplex) {
    this.peer = peer;
    peer.on('data', (chunk: Buffer) => {
      this.inbox.push(chunk);
      this.wake();
    });
    peer.on('end', () => {
      this.ended = true;
      this.wake();
    });
    peer.on('close', () => {
      this.ended = true;
      this.wake();
    });
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
  /** Resolves with the next chunk, or undefined at EOF. */
  async next(): Promise<Buffer | undefined> {
    while (this.inbox.length === 0 && !this.ended) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.inbox.shift();
  }
  write(bytes: Uint8Array): void {
    if (bytes.length > 0) {
      this.peer.write(Buffer.from(bytes));
    }
  }
}

/** A connected pair of Duplex streams: bytes written to one are read from the other. */
export function duplexPair(): [Duplex, Duplex] {
  let a: Duplex | undefined;
  let b: Duplex | undefined;
  const make = (other: () => Duplex | undefined): Duplex =>
    new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        other()?.push(chunk);
        cb();
      },
      final(cb) {
        other()?.push(null);
        cb();
      },
    });
  a = make(() => b);
  b = make(() => a);
  return [a, b];
}

export class TlsError extends Error {}
export class ConnectionClosed extends Error {}

/** The guest's `Tls` value (tls.wasm.mbt:260-268) with a configurable write buffer. */
export class GuestTls {
  readBuf = new Uint8Array(0);
  writeBuf = new Uint8Array(0);
  closed = false;
  readonly states: number[] = [];
  readonly session: TlsSession;
  readonly transport: Transport;
  readonly isClient: boolean;
  readonly writeBufferSize: number;
  constructor(
    session: TlsSession,
    transport: Transport,
    isClient: boolean,
    writeBufferSize = 4096,
  ) {
    this.session = session;
    this.transport = transport;
    this.isClient = isClient;
    this.writeBufferSize = writeBufferSize;
  }

  private outSpace(): Uint8Array {
    return new Uint8Array(this.writeBufferSize - this.writeBuf.length);
  }
  private drop(n: number): void {
    this.readBuf = this.readBuf.subarray(n);
  }
  private append(out: Uint8Array, n: number): void {
    if (n > 0) {
      this.writeBuf = Buffer.concat([this.writeBuf, out.subarray(0, n)]);
    }
  }
  flushWrite(): void {
    this.transport.write(this.writeBuf);
    this.writeBuf = new Uint8Array(0);
  }
  async readMore(): Promise<void> {
    if (this.closed) {
      throw new ConnectionClosed();
    }
    const chunk = await this.transport.next();
    if (chunk === undefined) {
      this.closed = true;
    } else {
      this.readBuf = Buffer.concat([this.readBuf, chunk]);
    }
  }

  /** `Tls::connect` / `Tls::accept` (tls.wasm.mbt:290-351). */
  async handshake(): Promise<void> {
    for (;;) {
      const out = this.outSpace();
      const state = this.isClient
        ? this.session.connect(this.readBuf, out)
        : this.session.accept(this.readBuf, out);
      this.states.push(state);
      this.drop(this.session.bytesRead());
      this.append(out, this.session.bytesToWrite());
      switch (state) {
        case TlsState.Completed:
          this.flushWrite();
          return;
        case TlsState.WantRead:
          this.flushWrite();
          await this.readMore();
          break;
        case TlsState.WantWrite:
          this.flushWrite();
          break;
        case TlsState.Eof:
          throw new ConnectionClosed();
        case TlsState.Error:
          throw new TlsError(this.session.takeError());
        default:
          throw new Error(`unexpected TLS state ${state}`);
      }
    }
  }

  /** `_direct_read` (tls.wasm.mbt:478-533). */
  async read(max = 16384): Promise<Uint8Array> {
    for (;;) {
      const out = this.outSpace();
      const plain = new Uint8Array(max);
      const n = this.session.readPlain(this.readBuf, out, plain);
      const bytesRead = this.session.bytesRead();
      this.drop(bytesRead);
      const bytesToWrite = this.session.bytesToWrite();
      this.append(out, bytesToWrite);
      if (bytesToWrite > 0) {
        this.flushWrite();
      }
      if (n > 0) {
        return plain.subarray(0, n);
      }
      switch (n) {
        case -2:
          await this.shutdown();
          return new Uint8Array(0);
        case -4:
          await this.handshake();
          break;
        case -3:
          if (bytesRead > 0 || bytesToWrite > 0) {
            break;
          }
          if (this.closed && this.readBuf.length === 0) {
            return new Uint8Array(0);
          }
          if (this.session.wantsRead()) {
            await this.readMore();
          } else if (this.session.wantsWrite()) {
            this.flushWrite();
          } else {
            return new Uint8Array(0);
          }
          break;
        case -1:
          throw new TlsError(this.session.takeError());
        default:
          throw new Error(`unexpected status ${n} from TLS read`);
      }
    }
  }

  async readAll(): Promise<Buffer> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const chunk = await this.read();
      if (chunk.length === 0) {
        return Buffer.concat(parts);
      }
      parts.push(chunk);
    }
  }

  /** `write_once` (tls.wasm.mbt:541-591). */
  async writeOnce(data: Uint8Array): Promise<number> {
    this.flushWrite();
    for (;;) {
      const out = this.outSpace();
      const n = this.session.writePlain(this.readBuf, out, data);
      const bytesRead = this.session.bytesRead();
      this.drop(bytesRead);
      const bytesToWrite = this.session.bytesToWrite();
      this.append(out, bytesToWrite);
      if (bytesToWrite > 0) {
        this.flushWrite();
      }
      if (n >= 0) {
        return n;
      }
      switch (n) {
        case -4:
          await this.handshake();
          break;
        case -3:
          if (bytesRead > 0 || bytesToWrite > 0) {
            break;
          }
          if (this.session.wantsRead()) {
            await this.readMore();
            break;
          }
          return 0;
        case -2:
          throw new ConnectionClosed();
        case -1:
          throw new TlsError(this.session.takeError());
        default:
          throw new Error(`unexpected status ${n} from TLS write`);
      }
    }
  }

  async write(data: Uint8Array): Promise<void> {
    let rest = data;
    while (rest.length > 0) {
      const n = await this.writeOnce(rest);
      if (n === 0) {
        throw new Error('write made no progress');
      }
      rest = rest.subarray(n);
    }
  }

  private shutdownDone = false;
  /** `Tls::shutdown` (tls.wasm.mbt:605-625). */
  async shutdown(): Promise<void> {
    if (this.shutdownDone) {
      return;
    }
    this.shutdownDone = true;
    if (this.closed) {
      return;
    }
    this.flushWrite();
    const status = this.session.shutdown();
    if (status === -1) {
      throw new TlsError(this.session.takeError());
    }
    await this.handshake();
  }
}
