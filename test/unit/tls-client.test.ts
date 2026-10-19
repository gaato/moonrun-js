// The engine as a TLS client against Node's TLS server, over an in-memory pipe.
import { createHash, randomFillSync, X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { type EngineConn, TlsEngine } from '../../src/domains/tls/index.ts';
import { nodeTlsEngineModule } from '../../src/hosts/node/tls-engine.ts';
import { nodeTrustStore } from '../../src/hosts/node/trust-store.ts';
import type { TrustStorePort } from '../../src/ports/tls.ts';
import {
  duplexPair,
  FIXTURES,
  fixture,
  GuestTls,
  makeDomain,
  pemToDer,
  TlsError,
  Transport,
} from './tls-harness.ts';

interface ServerOptions {
  readonly key?: Buffer;
  readonly cert?: Buffer;
  readonly maxVersion?: tls.SecureVersion;
}

interface ClientOptions {
  readonly host?: string;
  readonly sni?: boolean;
  readonly trust?: number;
  readonly roots?: readonly Uint8Array[];
  readonly trustStore?: TrustStorePort;
  readonly writeBufferSize?: number;
}

/** A Node TLS server on one end of a pipe and a guest-driven engine client on the other. */
function connectPair(server: ServerOptions = {}, client: ClientOptions = {}) {
  const [guestEnd, nodeEnd] = duplexPair();
  const tlsServer = tls.createServer({
    key: server.key ?? fixture('leaf-key.pem'),
    cert: server.cert ?? fixture('leaf-chain.pem'),
    ...(server.maxVersion === undefined ? {} : { maxVersion: server.maxVersion }),
  });
  const serverSocket = new Promise<tls.TLSSocket>((resolve, reject) => {
    tlsServer.on('secureConnection', resolve);
    tlsServer.on('tlsClientError', reject);
  });
  tlsServer.emit('connection', nodeEnd);
  const domain = makeDomain(client.trustStore);
  const session = domain.create();
  for (const root of client.roots ?? []) {
    expect(session.addRootCertificate(root)).toEqual({ ok: true, value: 0 });
  }
  const guest = new GuestTls(session, new Transport(guestEnd), true, client.writeBufferSize);
  const configured = session.setClient(
    client.host ?? 'localhost',
    client.sni ?? true,
    client.trust ?? 0,
  );
  return { guest, session, serverSocket, configured, tlsServer };
}

const caRoots = pemToDer(fixture('ca.pem'));

describe('TLS engine as client', () => {
  for (const maxVersion of ['TLSv1.3', 'TLSv1.2'] as const) {
    it(`handshakes, exchanges data and closes (${maxVersion})`, async () => {
      const { guest, session, serverSocket, configured } = connectPair({ maxVersion });
      expect(configured).toEqual({ ok: true, value: 0 });
      const [, socket] = await Promise.all([guest.handshake(), serverSocket]);
      expect(socket.getProtocol()).toBe(maxVersion);

      await guest.write(Buffer.from('ping'));
      const got = await new Promise<Buffer>((resolve) => socket.once('data', resolve));
      expect(got.toString()).toBe('ping');

      socket.write('pong'.repeat(10000));
      let received = '';
      while (received.length < 40000) {
        received += Buffer.from(await guest.read()).toString();
      }
      expect(received).toBe('pong'.repeat(10000));

      // Channel bindings match what OpenSSL (Node) sees on the other side.
      const leaf = new X509Certificate(fixture('leaf.pem'));
      expect(Buffer.from(session.peerCertificate() ?? [])).toEqual(leaf.raw);
      expect(Buffer.from(session.serverEndpointChannelBinding() ?? [])).toEqual(
        createHash('sha384').update(leaf.raw).digest(),
      );
      const unique = session.uniqueChannelBinding();
      expect(unique).not.toBeNull();
      expect(Buffer.from(unique ?? [])).toEqual(socket.getPeerFinished());

      const ended = new Promise<void>((resolve) => socket.once('end', resolve));
      socket.resume();
      await guest.shutdown();
      await ended; // Node saw close_notify
      socket.end(); // Node replies with close_notify and EOF
      expect((await guest.readAll()).length).toBe(0);
    });
  }

  it('reports the peer close_notify as end of stream', async () => {
    const { guest, serverSocket } = connectPair();
    const [, socket] = await Promise.all([guest.handshake(), serverSocket]);
    socket.end('bye');
    expect((await guest.readAll()).toString()).toBe('bye');
  });

  it('verifies against custom roots (trust 2) and checks the hostname', async () => {
    const good = connectPair({}, { trust: 2, roots: caRoots, host: 'localhost' });
    await Promise.all([good.guest.handshake(), good.serverSocket]);

    const wildcard = connectPair({}, { trust: 2, roots: caRoots, host: 'a.example.test' });
    await Promise.all([wildcard.guest.handshake(), wildcard.serverSocket]);

    const ip = connectPair({}, { trust: 2, roots: caRoots, host: '127.0.0.1' });
    await Promise.all([ip.guest.handshake(), ip.serverSocket]);

    const mismatch = connectPair({}, { trust: 2, roots: caRoots, host: 'other.test' });
    mismatch.serverSocket.catch(() => {});
    await expect(mismatch.guest.handshake()).rejects.toThrow(
      /^TLS handshake failed: invalid peer certificate: NotValidForName/,
    );

    const deepWildcard = connectPair({}, { trust: 2, roots: caRoots, host: 'a.b.example.test' });
    deepWildcard.serverSocket.catch(() => {});
    await expect(deepWildcard.guest.handshake()).rejects.toThrow(/NotValidForName/);
  });

  it('skips hostname verification and SNI for an empty host', async () => {
    const { guest, serverSocket } = connectPair({}, { trust: 2, roots: caRoots, host: '' });
    const [, socket] = await Promise.all([guest.handshake(), serverSocket]);
    expect(socket.servername).toBeFalsy();
  });

  it('sends SNI only when asked', async () => {
    const withSni = connectPair({}, { host: 'localhost', sni: true });
    const [, a] = await Promise.all([withSni.guest.handshake(), withSni.serverSocket]);
    expect(a.servername).toBe('localhost');

    const noSni = connectPair({}, { trust: 2, roots: caRoots, host: 'localhost', sni: false });
    const [, b] = await Promise.all([noSni.guest.handshake(), noSni.serverSocket]);
    expect(b.servername).toBeFalsy();
  });

  it('rejects an unknown issuer and an expired certificate', async () => {
    const unknown = connectPair({}, { trust: 2, roots: pemToDer(fixture('valid_root_cert.pem')) });
    unknown.serverSocket.catch(() => {});
    await expect(unknown.guest.handshake()).rejects.toThrow(/UnknownIssuer/);

    const expired = connectPair(
      { key: fixture('key.pem'), cert: fixture('cert.pem') },
      { trust: 2, roots: pemToDer(fixture('cert.pem')), host: 'whatever' },
    );
    expired.serverSocket.catch(() => {});
    await expect(expired.guest.handshake()).rejects.toThrow(/Expired/);
  });

  it('accepts a trusted self-signed root as the server certificate with a CN-only name (async test_keys)', async () => {
    const valid = connectPair(
      { key: fixture('valid_root_key.pem'), cert: fixture('valid_root_cert.pem') },
      { trust: 2, roots: pemToDer(fixture('valid_root_cert.pem')), host: 'whatever' },
    );
    await Promise.all([valid.guest.handshake(), valid.serverSocket]);

    const other = connectPair(
      { key: fixture('other_root_key.pem'), cert: fixture('other_root_cert.pem') },
      { trust: 2, roots: pemToDer(fixture('valid_root_cert.pem')), host: 'whatever' },
    );
    other.serverSocket.catch(() => {});
    await expect(other.guest.handshake()).rejects.toThrow(TlsError);

    const wrongName = connectPair(
      { key: fixture('valid_root_key.pem'), cert: fixture('valid_root_cert.pem') },
      { trust: 2, roots: pemToDer(fixture('valid_root_cert.pem')), host: 'whoever' },
    );
    wrongName.serverSocket.catch(() => {});
    await expect(wrongName.guest.handshake()).rejects.toThrow(/NotValidForName/);
  });

  it('uses the system trust store for trust 1', async () => {
    const trustStore = nodeTrustStore({
      env: (name) =>
        name === 'SSL_CERT_FILE'
          ? `${FIXTURES}/ca.pem`
          : name === 'SSL_CERT_DIR'
            ? '/nonexistent'
            : undefined,
    });
    const { guest, serverSocket } = connectPair({}, { trust: 1, trustStore });
    await Promise.all([guest.handshake(), serverSocket]);

    const empty = connectPair({}, { trust: 1 });
    empty.serverSocket.catch(() => {});
    await expect(empty.guest.handshake()).rejects.toThrow(/UnknownIssuer/);
  });

  it('keeps output that does not fit and reports wants_write', async () => {
    const { guest, serverSocket } = connectPair({}, { writeBufferSize: 64 });
    const [, socket] = await Promise.all([guest.handshake(), serverSocket]);
    expect(guest.states).toContain(2); // WantWrite
    await guest.write(Buffer.alloc(5000, 7));
    let total = 0;
    socket.on('data', (d: Buffer) => {
      total += d.length;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(total).toBe(5000);
  });

  it('follows moonrun for misconfiguration', async () => {
    const domain = makeDomain();
    const roots = domain.create();
    roots.addRootCertificate(caRoots[0] ?? new Uint8Array());
    expect(roots.setClient('localhost', true, 1)).toEqual({ ok: true, value: -1 });
    expect(roots.takeError()).toBe('TLS root certificates require custom root trust');
    expect(roots.takeError()).toBe('unknown TLS error');

    const invalid = domain.create();
    expect(invalid.setClient('localhost', true, 3)).toMatchObject({
      ok: false,
      error: { code: 'EINVAL' },
    });

    const badRoot = domain.create();
    badRoot.addRootCertificate(new Uint8Array([1, 2, 3]));
    expect(badRoot.setClient('localhost', true, 2)).toEqual({ ok: true, value: -1 });
    expect(badRoot.takeError()).toMatch(/^failed to parse TLS root certificate: /);

    const unconfigured = domain.create();
    expect(unconfigured.connect(new Uint8Array(), new Uint8Array(16))).toBe(3);
    expect(unconfigured.readPlain(new Uint8Array(), new Uint8Array(16), new Uint8Array(16))).toBe(
      -1,
    );
    expect(unconfigured.bytesRead()).toBe(0);
    expect(unconfigured.wantsWrite()).toBe(false);
    expect(unconfigured.peerCertificate()).toBeNull();
    expect(unconfigured.takeError()).toBe('TLS handle is not configured');
    expect(domain.takeGlobalError()).toBe('unknown TLS error');

    const twice = domain.create();
    expect(twice.setClient('localhost', true, 0)).toEqual({ ok: true, value: 0 });
    expect(twice.setClient('localhost', true, 0)).toMatchObject({
      ok: false,
      error: { code: 'EINVAL' },
    });
    expect(twice.addRootCertificate(new Uint8Array(1))).toMatchObject({ ok: false });
    // Before the first connect: no certificate (empty, not an error), no bindings.
    expect(twice.peerCertificate()).toEqual(new Uint8Array(0));
    expect(twice.uniqueChannelBinding()).toBeNull();
    expect(twice.readPlain(new Uint8Array(), new Uint8Array(16), new Uint8Array(16))).toBe(-4);
    expect(twice.writePlain(new Uint8Array(), new Uint8Array(64), new Uint8Array(4))).toBe(-4);
    expect(twice.readPlain(new Uint8Array(), new Uint8Array(16), new Uint8Array(0))).toBe(0);
    expect(twice.accept(new Uint8Array(), new Uint8Array(64))).toBe(3);
    expect(twice.takeError()).toBe('TLS accept requires a server handle');
    expect(twice.shutdown()).toBe(0);
    expect(twice.writePlain(new Uint8Array(), new Uint8Array(64), new Uint8Array(4))).toBe(-2);
    // Shutdown requested before the handshake: the next connect fails like SSL_shutdown in init.
    expect(twice.connect(new Uint8Array(), new Uint8Array(4096))).toBe(3);
    expect(twice.takeError()).toMatch(/^TLS shutdown failed: /);
    twice.free();
  });
});

describe('TLS engine faults', () => {
  it('poisons the instance after a trap instead of throwing', () => {
    const module = nodeTlsEngineModule();
    if (!module.ok) {
      throw new Error(module.error);
    }
    const engine = TlsEngine.instantiate(module.value, {
      clock: { nowMs: () => Date.now(), monotonicNs: () => 0n },
      random: { fill: (b) => void randomFillSync(b) },
    });
    if (!engine.ok) {
      throw new Error(engine.error);
    }
    // An unknown connection id panics inside the engine (a wrapper bug).
    const bogus = 999 as EngineConn;
    expect(engine.value.connect(bogus, new Uint8Array(), new Uint8Array(16))).toBe(3);
    expect(engine.value.takeError(bogus)).toMatch(/^TLS engine fault: /);
    expect(engine.value.newClient('localhost', true, null)).toMatchObject({ ok: false });
  });
});

const live = process.env['MOONRUN_JS_LIVE_TLS'];
describe.skipIf(live === undefined)('TLS engine against a real host', () => {
  it('fetches over HTTPS with system roots', async () => {
    const net = await import('node:net');
    const host = live === undefined || live === '1' ? 'example.com' : live;
    const socket = net.connect(443, host);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const session = makeDomain(nodeTrustStore()).create();
    expect(session.setClient(host, true, 1)).toEqual({ ok: true, value: 0 });
    const guest = new GuestTls(session, new Transport(socket), true);
    await guest.handshake();
    await guest.write(Buffer.from(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    const response = (await guest.readAll()).toString('latin1');
    expect(response).toMatch(/^HTTP\/1\.1 \d{3} /);
    socket.destroy();
  }, 20000);
});
