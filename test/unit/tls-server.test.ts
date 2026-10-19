// The engine as a TLS server against Node's TLS client, and engine against engine.
import { createHash, X509Certificate } from 'node:crypto';
import * as tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { duplexPair, fixture, GuestTls, makeDomain, pemToDer, Transport } from './tls-harness.ts';

function serverPair(
  files: { key?: string; keyType?: number; cert?: string; certType?: number } = {},
  client: tls.ConnectionOptions = {},
) {
  const [guestEnd, nodeEnd] = duplexPair();
  const session = makeDomain().create();
  const configured = session.setServerFiles(
    files.key ?? 'leaf-key.pem',
    files.keyType ?? 1,
    files.cert ?? 'leaf-chain.pem',
    files.certType ?? 1,
  );
  const guest = new GuestTls(session, new Transport(guestEnd), false);
  const socket = tls.connect({
    socket: nodeEnd,
    ca: fixture('ca.pem'),
    servername: 'localhost',
    ...client,
  });
  const secure = new Promise<tls.TLSSocket>((resolve, reject) => {
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
  return { guest, session, configured, socket, secure };
}

describe('TLS engine as server', () => {
  for (const maxVersion of ['TLSv1.3', 'TLSv1.2'] as const) {
    it(`accepts a verifying Node client (${maxVersion})`, async () => {
      const { guest, session, configured, secure } = serverPair({}, { maxVersion });
      expect(configured).toEqual({ ok: true, value: 0 });
      const [, socket] = await Promise.all([guest.handshake(), secure]);
      expect(socket.authorized).toBe(true);
      expect(socket.getProtocol()).toBe(maxVersion);

      socket.write('hello server');
      expect(Buffer.from(await guest.read()).toString()).toBe('hello server');
      await guest.write(Buffer.from('hello client'));
      const reply = await new Promise<Buffer>((resolve) => socket.once('data', resolve));
      expect(reply.toString()).toBe('hello client');

      // The server sees no client certificate: an empty buffer, not an error.
      expect(session.peerCertificate()).toEqual(new Uint8Array(0));
      const leaf = new X509Certificate(fixture('leaf.pem'));
      expect(Buffer.from(session.serverEndpointChannelBinding() ?? [])).toEqual(
        createHash('sha384').update(leaf.raw).digest(),
      );
      // OpenSSL's server returns the peer (client) Finished.
      expect(Buffer.from(session.uniqueChannelBinding() ?? [])).toEqual(socket.getFinished());

      const ended = new Promise<void>((resolve) => socket.once('end', resolve));
      socket.resume();
      await guest.shutdown();
      await ended;
    });
  }

  it('loads DER (ASN.1) certificate and key files', async () => {
    const { guest, configured, secure } = serverPair({
      key: 'leaf-key.der',
      keyType: 2,
      cert: 'leaf.der',
      certType: 2,
    });
    expect(configured).toEqual({ ok: true, value: 0 });
    await Promise.all([guest.handshake(), secure]);
  });

  it('reports server configuration errors like moonrun', () => {
    const domain = makeDomain();
    const mismatch = domain.create();
    expect(mismatch.setServerFiles('key.pem', 1, 'leaf.pem', 1)).toEqual({ ok: true, value: -1 });
    expect(mismatch.takeError()).toMatch(/^failed to load TLS private key: /);

    const missing = domain.create();
    expect(missing.setServerFiles('leaf-key.pem', 1, 'nope.pem', 1)).toEqual({
      ok: true,
      value: -1,
    });
    expect(missing.takeError()).toMatch(/^failed to load TLS certificate chain: /);

    const badType = domain.create();
    expect(badType.setServerFiles('leaf-key.pem', 3, 'leaf.pem', 1)).toMatchObject({
      ok: false,
      error: { code: 'EINVAL' },
    });

    const withRoots = domain.create();
    withRoots.addRootCertificate(pemToDer(fixture('ca.pem'))[0] ?? new Uint8Array());
    expect(withRoots.setServerFiles('leaf-key.pem', 1, 'leaf.pem', 1)).toEqual({
      ok: true,
      value: -1,
    });
    expect(withRoots.takeError()).toBe('TLS root certificates require client custom root trust');

    // moonrun on Linux has no PKCS#12 (openssl.rs:116-123).
    const pfx = domain.create();
    expect(pfx.setServerPfx(fixture('cert.pfx'))).toEqual({ ok: true, value: -1 });
    expect(pfx.takeError()).toBe(
      'TLS PFX server certificates are supported only by SChannel on Windows',
    );

    const server = domain.create();
    expect(server.setServerFiles('leaf-key.pem', 1, 'leaf.pem', 1)).toEqual({ ok: true, value: 0 });
    expect(server.connect(new Uint8Array(), new Uint8Array(64))).toBe(3);
    expect(server.takeError()).toBe('TLS connect requires a client handle');
    expect(server.setServerPfx(new Uint8Array(1))).toMatchObject({ ok: false });
  });

  it('applies the policy check before reading files', () => {
    const read: string[] = [];
    const domain = makeDomain(undefined, {
      authorizeRead: (file) =>
        file.includes('key')
          ? { ok: false, error: 'PermissionDenied' }
          : { ok: true, value: undefined },
      readFile: (file) => {
        read.push(file);
        return { ok: true, value: new Uint8Array() };
      },
    });
    const session = domain.create();
    expect(session.setServerFiles('leaf-key.pem', 1, 'leaf.pem', 1)).toEqual({
      ok: true,
      value: -1,
    });
    expect(session.takeError()).toBe('failed to access TLS private key file: PermissionDenied');
    expect(read).toEqual([]);
  });
});

describe('TLS engine against itself', () => {
  async function pair(clientHost: string, trust: number, roots: readonly Uint8Array[]) {
    const [a, b] = duplexPair();
    const domain = makeDomain();
    const serverSession = domain.create();
    expect(serverSession.setServerFiles('leaf-key.pem', 1, 'leaf-chain.pem', 1)).toEqual({
      ok: true,
      value: 0,
    });
    const clientSession = domain.create();
    for (const root of roots) {
      clientSession.addRootCertificate(root);
    }
    expect(clientSession.setClient(clientHost, true, trust)).toEqual({ ok: true, value: 0 });
    const server = new GuestTls(serverSession, new Transport(a), false, 512);
    const client = new GuestTls(clientSession, new Transport(b), true, 512);
    return { server, client, serverSession, clientSession };
  }

  it('round-trips data, bindings and close_notify through small buffers', async () => {
    const { server, client, serverSession, clientSession } = await pair(
      'localhost',
      2,
      pemToDer(fixture('ca.pem')),
    );
    await Promise.all([server.handshake(), client.handshake()]);
    const big = Buffer.alloc(100_000, 0x61);
    const received = (async () => {
      const parts: Uint8Array[] = [];
      let n = 0;
      while (n < big.length) {
        const chunk = await server.read();
        parts.push(chunk);
        n += chunk.length;
      }
      return Buffer.concat(parts);
    })();
    await client.write(big);
    expect((await received).equals(big)).toBe(true);
    expect(clientSession.uniqueChannelBinding()).toEqual(serverSession.uniqueChannelBinding());
    expect(clientSession.serverEndpointChannelBinding()).toEqual(
      serverSession.serverEndpointChannelBinding(),
    );
    await client.shutdown();
    expect((await server.readAll()).length).toBe(0); // server saw close_notify and replied
    expect((await client.readAll()).length).toBe(0);
  });

  it('queues an alert for the peer when verification fails', async () => {
    const { server, client } = await pair('localhost', 2, pemToDer(fixture('valid_root_cert.pem')));
    const serverDone = server.handshake().then(
      () => 'completed',
      (error: unknown) => String(error),
    );
    await expect(client.handshake()).rejects.toThrow(/UnknownIssuer/);
    // Like OpenSSL, the failing call produced an alert (the guest drops it
    // unflushed when it raises; flush it here to check what the peer sees).
    expect(client.writeBuf.length).toBeGreaterThan(0);
    client.flushWrite();
    client.transport.peer.end();
    expect(await serverDone).toMatch(/received fatal alert: UnknownCA/);
  });
});
