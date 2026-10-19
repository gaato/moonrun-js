import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { startBrowserDemo } from '../../scripts/browser-demo.ts';
import { BrowserDns, browserNet } from '../../src/hosts/browser/net.ts';
import { Connection } from '../../src/kernel/socket.ts';
import type { SocketAddress } from '../../src/ports/net.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for socket event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function address(ip = [127, 0, 0, 1], port = 443): SocketAddress {
  return { family: 4, ip: new Uint8Array(ip), port, flowInfo: 0, scopeId: 0 };
}
async function tcpServer(handler: (s: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
    handler(s);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('address missing');
  return a.port;
}
async function relay(allow: string[] = []) {
  const demo = await startBrowserDemo({ allow });
  cleanup.push(() => demo.close());
  return demo;
}
async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, 'moonrun-tcp-v1');
  ws.binaryType = 'arraybuffer';
  cleanup.push(async () => {
    ws.close();
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  return ws;
}

describe('browser DNS', () => {
  it('uses stable per-run fake IPs, canonical names and untouched literals', async () => {
    const dns = new BrowserDns();
    const a = await dns.lookup('Example.COM.');
    expect(a).toEqual(await dns.lookup('example.com'));
    if (!a.ok || a.value[0] === undefined) throw new Error('lookup failed');
    expect(a.value[0].ip).toEqual(new Uint8Array([198, 18, 0, 1]));
    expect(dns.hostname({ ...address(), ip: a.value[0].ip })).toBe('example.com');
    a.value[0].ip.fill(0);
    expect(await dns.lookup('example.com')).toEqual({
      ok: true,
      value: [{ family: 4, ip: new Uint8Array([198, 18, 0, 1]), scopeId: 0 }],
    });
    expect(await dns.lookup('127.0.0.1')).toEqual({
      ok: true,
      value: [{ family: 4, ip: address().ip, scopeId: 0 }],
    });
    expect((await dns.lookup('::1')).ok).toBe(true);
    expect(await dns.lookup('bad name')).toEqual({
      ok: false,
      error: { kind: 'eai', code: 'EAI_NONAME' },
    });
    expect(await new BrowserDns().lookup('different.test')).toEqual(
      await new BrowserDns().lookup('example.com'),
    );
  });
});

describe('local relay protocol and browser NetPort', () => {
  it('moves opaque binary data, acknowledges writes, and forwards FIN', async () => {
    const port = await tcpServer((s) => {
      s.on('data', (b) => s.write(b));
      s.on('end', () => s.end());
    });
    const demo = await relay([`127.0.0.1:${port}`]);
    const ws = await open(demo.relay);
    const messages: unknown[] = [];
    ws.onmessage = (e) =>
      messages.push(
        typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data as ArrayBuffer),
      );
    ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port, credit: 131072 }));
    await until(() => messages.some((m) => JSON.stringify(m) === '{"type":"connected"}'));
    ws.send(new Uint8Array([0, 255, 13, 10]));
    await until(() => messages.some((m) => m instanceof Uint8Array));
    expect(messages).toContainEqual(new Uint8Array([0, 255, 13, 10]));
    await until(() => messages.some((m) => JSON.stringify(m) === '{"type":"ack","bytes":4}'));
    ws.send(JSON.stringify({ type: 'reset' }));
  });
  it('maps fake DNS names, preserves EAGAIN/drain and resumes a paused receive stream', async () => {
    const port = await tcpServer((s) => {
      s.on('data', (b) => s.write(b));
    });
    const demo = await relay([`localhost:${port}`]);
    const dns = new BrowserDns();
    const resolved = await dns.lookup('localhost');
    if (!resolved.ok || resolved.value[0] === undefined) throw new Error('lookup failed');
    const conn = new Connection('connecting', false);
    conn.stream = browserNet(dns, demo.relay).connect(
      {
        remote: { ...address(), port, ip: resolved.value[0].ip },
        noDelay: true,
        keepAliveSeconds: undefined,
      },
      conn.events,
    );
    cleanup.push(async () => conn.close());
    expect(conn.read(new Uint8Array(1)).ok).toBe(false);
    await until(() => conn.phase === 'open' || conn.phase === 'reset');
    expect(conn.phase).toBe('open');
    expect(conn.read(new Uint8Array(1))).toMatchObject({ ok: false });
    const payload = new Uint8Array(512 * 1024).map((_, i) => i % 251);
    expect(conn.write(payload)).toEqual({ ok: true, value: payload.length });
    expect(conn.needDrain).toBe(true);
    expect(conn.write(new Uint8Array([1])).ok).toBe(false);
    await until(() => !conn.needDrain);
    await until(() => conn.buffered >= 128 * 1024);
    expect(conn.buffered).toBeLessThanOrEqual(256 * 1024);
    const received = new Uint8Array(payload.length);
    let offset = 0;
    while (offset < received.length) {
      await until(() => conn.buffered > 0 || conn.error !== undefined);
      const r = conn.read(received.subarray(offset));
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      offset += r.value;
    }
    expect(received).toEqual(payload);
  });
  it('does not treat peer FIN as a reset and flushes a graceful close', async () => {
    let received = 0;
    let fin = false;
    const port = await tcpServer((s) => {
      s.end('bye');
      s.on('data', (b) => {
        received += b.length;
      });
      s.on('end', () => {
        fin = true;
      });
    });
    const demo = await relay([`127.0.0.1:${port}`]);
    const conn = new Connection('connecting', false);
    conn.stream = browserNet(new BrowserDns(), demo.relay).connect(
      { remote: address(undefined, port), noDelay: true, keepAliveSeconds: undefined },
      conn.events,
    );
    await until(() => conn.eof);
    expect(conn.error).toBeUndefined();
    expect(conn.read(new Uint8Array(3))).toEqual({ ok: true, value: 3 });
    expect(conn.read(new Uint8Array(1))).toEqual({ ok: true, value: 0 });
    conn.write(new Uint8Array(128 * 1024));
    conn.close();
    await until(() => fin);
    expect(received).toBe(128 * 1024);
  });
  it('rejects destinations, missing tokens, cross origins and invalid controls', async () => {
    const demo = await relay();
    const ws = await open(demo.relay);
    const messages: unknown[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: 22, credit: 131072 }));
    await until(() => messages.length > 0);
    expect(messages[0]).toEqual({ type: 'error', code: 'EACCES' });
    const denied = async (url: string, origin?: string): Promise<number> =>
      new Promise((resolve) => {
        const client = new WsClient(url, 'moonrun-tcp-v1', origin === undefined ? {} : { origin });
        client.on('unexpected-response', (_req, res) => {
          res.resume();
          client.terminate();
          resolve(res.statusCode ?? 0);
        });
        client.on('error', () => {});
      });
    expect(await denied(demo.relay.replace(/token=.*/, 'token=wrong'))).toBe(403);
    expect(await denied(demo.relay, 'https://evil.example')).toBe(403);
    expect((await fetch(new URL('/roots', demo.url))).status).toBe(403);
    const roots = new URL('/roots', demo.url);
    roots.search = new URL(demo.url).search;
    expect(Array.isArray(await (await fetch(roots)).json())).toBe(true);
    const invalid = await open(demo.relay);
    let error: unknown;
    invalid.onmessage = (e) => {
      error = JSON.parse(String(e.data));
    };
    invalid.send('{');
    await until(() => error !== undefined);
    expect(error).toEqual({ type: 'error', code: 'EINVAL' });
  });
  it('reports unavailable networking/listen/UDP asynchronously as ENOSYS', async () => {
    const errors: string[] = [];
    const port = browserNet(new BrowserDns());
    const events = {
      connected: () => {},
      data: () => {},
      end: () => {},
      drain: () => {},
      error: (e: { code: string }) => errors.push(e.code),
    };
    const stream = port.connect(
      { remote: address(), noDelay: true, keepAliveSeconds: undefined },
      events,
    );
    expect(errors).toEqual([]);
    await until(() => errors.length === 1);
    stream.close('reset');
    port.listen(
      { local: address(), ipv6Only: false, reusePort: false },
      { listening: () => {}, error: events.error, connection: () => events },
    );
    const udp = port.datagram(
      4,
      { reuseAddr: false, reusePort: false, ipv6Only: false },
      { listening: () => {}, connected: () => {}, message: () => {}, error: events.error },
    );
    udp.bind(address());
    await until(() => errors.length === 3);
    expect(errors).toEqual(['ENOSYS', 'ENOSYS', 'ENOSYS']);
    expect(udp.setOption({ kind: 'multicast-ttl', ttl: 1 })).toEqual({
      ok: false,
      error: { code: 'ENOSYS' },
    });
  });
});
