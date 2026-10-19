import { describe, expect, it } from 'vitest';
import { nodeFiles } from '../../src/hosts/node/files.ts';
import { AsyncKernel } from '../../src/kernel/async-kernel.ts';
import type { Handle } from '../../src/kernel/handles.ts';
import { NULL_HANDLE } from '../../src/kernel/handles.ts';
import { initIpv4 } from '../../src/kernel/net-codec.ts';
import { Poller } from '../../src/kernel/poller.ts';
import { EPOLLERR, EPOLLHUP, EPOLLIN, EPOLLOUT, EPOLLRDHUP } from '../../src/kernel/readiness.ts';
import { STREAM_RECEIVE_BUFFER, TcpSocket, UdpSocket } from '../../src/kernel/socket.ts';
import type {
  ByteStream,
  DatagramEvents,
  DatagramOption,
  DatagramSocket,
  DnsPort,
  ListenOptions,
  NetPort,
  ResolvedIp,
  ServerEvents,
  SocketAddress,
  StreamEvents,
} from '../../src/ports/net.ts';
import { ok } from '../../src/ports/result.ts';
import { FakeScheduler, memoryStdio } from './kernel-fakes.ts';

const v4 = (a: number, b: number, c: number, d: number, port: number): SocketAddress => ({
  family: 4,
  ip: Uint8Array.of(a, b, c, d),
  port,
  flowInfo: 0,
  scopeId: 0,
});
const LOCAL = v4(127, 0, 0, 1, 4000);
const PEER = v4(127, 0, 0, 1, 5000);
const inval = { ok: false, error: { kind: 'inval' } };
const errno = (code: string) => ({ ok: false, error: { kind: 'native', code } });

class FakeStream implements ByteStream {
  readonly written: Uint8Array[] = [];
  accept = true;
  paused = false;
  closed: 'graceful' | 'reset' | undefined;
  noDelay = false;
  events: StreamEvents | undefined;

  write(data: Uint8Array): boolean {
    this.written.push(data);
    return this.accept;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  close(mode: 'graceful' | 'reset'): void {
    this.closed = mode;
  }
  localAddress(): SocketAddress {
    return LOCAL;
  }
  remoteAddress(): SocketAddress {
    return PEER;
  }
  setNoDelay(enabled: boolean): void {
    this.noDelay = enabled;
  }
  setKeepAlive(): void {}
}

class FakeServer {
  closed = false;
  readonly options: ListenOptions;
  readonly events: ServerEvents;
  constructor(options: ListenOptions, events: ServerEvents) {
    this.options = options;
    this.events = events;
  }
  localAddress(): SocketAddress {
    return { ...this.options.local, port: this.options.local.port || 40000 };
  }
  close(): void {
    this.closed = true;
  }
  /** A peer connects; the stream is handed over paused. */
  connect(): FakeStream {
    const stream = new FakeStream();
    stream.paused = true;
    stream.events = this.events.connection(stream);
    return stream;
  }
}

class FakeDatagram implements DatagramSocket {
  readonly log: string[] = [];
  readonly sent: Array<{ data: Uint8Array; to: SocketAddress | undefined }> = [];
  local: SocketAddress | undefined;
  readonly events: DatagramEvents;
  constructor(events: DatagramEvents) {
    this.events = events;
  }
  bind(local: SocketAddress): void {
    this.log.push(`bind ${local.port}`);
    this.local = { ...local, port: local.port || 50000 };
  }
  connect(remote: SocketAddress): void {
    this.log.push(`connect ${remote.port}`);
    this.local ??= v4(127, 0, 0, 1, 50001);
  }
  disconnect(): void {
    this.log.push('disconnect');
  }
  send(data: Uint8Array, to: SocketAddress | undefined): void {
    this.log.push(`send ${data.length}`);
    this.sent.push({ data, to });
  }
  setOption(option: DatagramOption) {
    this.log.push(option.kind);
    return ok(undefined);
  }
  localAddress(): SocketAddress | undefined {
    return this.local;
  }
  close(): void {
    this.log.push('close');
  }
}

class FakeNet implements NetPort {
  readonly streams: FakeStream[] = [];
  readonly servers: FakeServer[] = [];
  readonly datagrams: FakeDatagram[] = [];
  connect(_options: unknown, events: StreamEvents): ByteStream {
    const stream = new FakeStream();
    stream.events = events;
    this.streams.push(stream);
    return stream;
  }
  listen(options: ListenOptions, events: ServerEvents): FakeServer {
    const server = new FakeServer(options, events);
    this.servers.push(server);
    return server;
  }
  datagram(_family: unknown, _options: unknown, events: DatagramEvents): FakeDatagram {
    const socket = new FakeDatagram(events);
    this.datagrams.push(socket);
    return socket;
  }
  interfaces() {
    return [
      {
        name: 'lo',
        index: 1,
        up: true,
        running: true,
        loopback: true,
        multicast: false,
        addresses: [],
      },
      {
        name: 'eth0',
        index: 2,
        up: true,
        running: true,
        loopback: false,
        multicast: true,
        addresses: [
          {
            family: 6 as const,
            ip: Uint8Array.of(0xfe, 0x80, ...new Uint8Array(13), 1),
            port: 0,
            flowInfo: 0,
            scopeId: 2,
          },
        ],
      },
    ];
  }
}

const masks = (socket: { watch(l: (m: number) => void): () => void }) => {
  const seen: number[] = [];
  socket.watch((m) => seen.push(m));
  return seen;
};

describe('TcpSocket (client)', () => {
  it('connects asynchronously: EINPROGRESS, no readiness, then an OUT edge', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    expect(socket.poll()).toBe(EPOLLOUT | EPOLLHUP);
    const wakes = masks(socket);
    expect(socket.connect(PEER)).toEqual(errno('EINPROGRESS'));
    expect(socket.connect(PEER)).toEqual(errno('EALREADY'));
    expect(socket.poll()).toBe(0);
    expect(socket.write(Uint8Array.of(1))).toEqual(errno('EAGAIN'));
    net.streams[0]?.events?.connected();
    expect(wakes).toEqual([EPOLLOUT]);
    expect(socket.poll()).toBe(EPOLLOUT);
    expect(socket.takeError()).toBeUndefined();
    expect(socket.getsockname()).toEqual(LOCAL);
    expect(socket.connect(PEER)).toEqual(errno('EISCONN'));
  });

  it('applies TCP_NODELAY given before the connection', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.setNoDelay();
    socket.connect(PEER);
    net.streams[0]?.events?.connected();
    socket.setNoDelay();
    expect(net.streams[0]?.noDelay).toBe(true);
  });

  it('rejects an address of the other family like Linux', () => {
    const net = new FakeNet();
    const v6addr: SocketAddress = { ...PEER, family: 6, ip: new Uint8Array(16) };
    expect(new TcpSocket(net, 4).connect(v6addr)).toEqual(errno('EAFNOSUPPORT'));
    expect(new TcpSocket(net, 6).connect(PEER)).toEqual(inval);
  });

  it('reports a refused connection through SO_ERROR once', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.connect(PEER);
    const wakes = masks(socket);
    net.streams[0]?.events?.error({ code: 'ECONNREFUSED' });
    expect((wakes[0] ?? 0) & (EPOLLERR | EPOLLHUP)).toBe(EPOLLERR | EPOLLHUP);
    expect(socket.poll() & EPOLLOUT).toBe(0);
    expect(socket.takeError()).toBe('ECONNREFUSED');
    expect(socket.takeError()).toBeUndefined();
  });

  it('applies write backpressure until drain', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.connect(PEER);
    const stream = net.streams[0] as FakeStream;
    stream.events?.connected();
    stream.accept = false;
    const data = Uint8Array.of(1, 2, 3);
    expect(socket.write(data)).toEqual({ ok: true, value: 3 });
    data[0] = 9;
    expect([...(stream.written[0] ?? [])]).toEqual([1, 2, 3]);
    expect(socket.write(data)).toEqual(errno('EAGAIN'));
    expect(socket.poll() & EPOLLOUT).toBe(0);
    const wakes = masks(socket);
    stream.events?.drain();
    expect(wakes).toEqual([EPOLLOUT]);
    expect(socket.poll() & EPOLLOUT).toBe(EPOLLOUT);
  });

  it('reads data, then EOF after FIN, with IN and RDHUP edges', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.connect(PEER);
    const stream = net.streams[0] as FakeStream;
    stream.events?.connected();
    const wakes = masks(socket);
    const dst = new Uint8Array(4);
    expect(socket.read(dst)).toEqual(errno('EAGAIN'));
    stream.events?.data(Uint8Array.of(1, 2, 3));
    stream.events?.data(Uint8Array.of(4, 5));
    expect(wakes).toEqual([EPOLLIN, EPOLLIN]);
    expect(socket.read(dst)).toEqual({ ok: true, value: 4 });
    expect([...dst]).toEqual([1, 2, 3, 4]);
    stream.events?.end();
    expect(socket.poll()).toBe(EPOLLIN | EPOLLRDHUP | EPOLLOUT);
    expect(socket.read(dst)).toEqual({ ok: true, value: 1 });
    expect(socket.read(dst)).toEqual({ ok: true, value: 0 });
    // Half-closed: still writable.
    expect(socket.write(Uint8Array.of(1))).toEqual({ ok: true, value: 1 });
  });

  it('reads buffered data before the reset, then the error, then EOF; writes fail with EPIPE', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.connect(PEER);
    const stream = net.streams[0] as FakeStream;
    stream.events?.connected();
    stream.events?.data(Uint8Array.of(7));
    stream.events?.error({ code: 'ECONNRESET' });
    expect(socket.poll()).toBe(EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR);
    const dst = new Uint8Array(4);
    expect(socket.read(dst)).toEqual({ ok: true, value: 1 });
    expect(socket.read(dst)).toEqual(errno('ECONNRESET'));
    expect(socket.read(dst)).toEqual({ ok: true, value: 0 });
    expect(socket.write(dst)).toEqual(errno('EPIPE'));
  });

  it('pauses the host stream when the receive buffer fills and resumes once drained', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.connect(PEER);
    const stream = net.streams[0] as FakeStream;
    stream.events?.connected();
    stream.events?.data(new Uint8Array(STREAM_RECEIVE_BUFFER));
    expect(stream.paused).toBe(true);
    socket.read(new Uint8Array(STREAM_RECEIVE_BUFFER / 4));
    expect(stream.paused).toBe(true);
    socket.read(new Uint8Array(STREAM_RECEIVE_BUFFER / 2));
    expect(stream.paused).toBe(false);
  });

  it('closes with FIN normally and with RST when unread data remains', () => {
    const net = new FakeNet();
    const a = new TcpSocket(net, 4);
    a.connect(PEER);
    net.streams[0]?.events?.connected();
    a.release();
    expect(net.streams[0]?.closed).toBe('graceful');
    const b = new TcpSocket(net, 4);
    b.connect(PEER);
    net.streams[1]?.events?.connected();
    net.streams[1]?.events?.data(Uint8Array.of(1));
    b.retain();
    b.release();
    expect(net.streams[1]?.closed).toBeUndefined();
    b.release();
    expect(net.streams[1]?.closed).toBe('reset');
  });
});

describe('TcpSocket (server)', () => {
  it('binds by listening on the host and accepts only after listen()', async () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    const done: unknown[] = [];
    expect(socket.bind(LOCAL, (e) => done.push(e))).toEqual({ ok: true, value: undefined });
    expect(socket.bind(LOCAL, () => {})).toEqual(inval);
    const server = net.servers[0] as FakeServer;
    server.events.listening();
    expect(done).toEqual([undefined]);
    expect(socket.getsockname().port).toBe(4000);
    const early = server.connect();
    expect(early.paused).toBe(true);
    // Bound but not listening: TCP_CLOSE readiness, and accept is EINVAL.
    expect(socket.poll()).toBe(EPOLLOUT | EPOLLHUP);
    expect(socket.accept()).toEqual(inval);
    const wakes = masks(socket);
    expect(await socket.listen()).toEqual({ ok: true, value: undefined });
    expect(wakes).toEqual([EPOLLIN]);
    const accepted = socket.accept();
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }
    expect(accepted.value.peer).toEqual(PEER);
    expect(early.paused).toBe(false);
    expect(socket.accept()).toEqual(errno('EAGAIN'));
    // The accepted socket sees the connection's data.
    early.events?.data(Uint8Array.of(42));
    const dst = new Uint8Array(1);
    expect(accepted.value.socket.read(dst)).toEqual({ ok: true, value: 1 });
  });

  it('returns to unbound when the host bind fails', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    const done: unknown[] = [];
    socket.bind(LOCAL, (e) => done.push(e));
    net.servers[0]?.events.error({ code: 'EADDRINUSE' });
    expect(done).toEqual([{ kind: 'native', code: 'EADDRINUSE' }]);
    expect(net.servers[0]?.closed).toBe(true);
    expect(socket.unbound).toBe(true);
  });

  it('binds the wildcard address on listen() of an unbound socket', async () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 6);
    const listening = socket.listen();
    expect(listening).toBeInstanceOf(Promise);
    expect(net.servers[0]?.options.local.family).toBe(6);
    expect(net.servers[0]?.options.local.port).toBe(0);
    net.servers[0]?.events.listening();
    expect(await listening).toEqual({ ok: true, value: undefined });
  });

  it('passes IPV6_V6ONLY and SO_REUSEPORT to the host listener', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 6);
    expect(socket.setIpv6Only(true).ok).toBe(true);
    socket.allowReusePort();
    socket.bind({ ...LOCAL, family: 6, ip: new Uint8Array(16) }, () => {});
    expect(net.servers[0]?.options).toMatchObject({ ipv6Only: true, reusePort: true });
    expect(socket.setIpv6Only(false)).toEqual(inval);
    expect(new TcpSocket(net, 4).setIpv6Only(true)).toEqual(errno('ENOPROTOOPT'));
  });

  it('resets queued connections when the listener closes', () => {
    const net = new FakeNet();
    const socket = new TcpSocket(net, 4);
    socket.bind(LOCAL, () => {});
    const server = net.servers[0] as FakeServer;
    server.events.listening();
    const pending = server.connect();
    socket.release();
    expect(server.closed).toBe(true);
    expect(pending.closed).toBe('reset');
  });

  it('is reported by an edge-triggered poller when registered fresh', () => {
    const scheduler = new FakeScheduler();
    const poller = new Poller(scheduler);
    const socket = new TcpSocket(new FakeNet(), 4);
    poller.register(socket, socket, EPOLLIN | EPOLLOUT | EPOLLRDHUP, 'edge', 9n);
    expect(poller.wait(0)).toBe(1);
    expect(poller.events).toEqual([{ data: 9n, events: EPOLLOUT | EPOLLHUP }]);
  });
});

describe('UdpSocket', () => {
  it('replays options set before the bind in order, then applies new ones at once', () => {
    const net = new FakeNet();
    const socket = new UdpSocket(net, 4, true);
    socket.setOption({ kind: 'multicast-ttl', ttl: 0 });
    socket.setOption({ kind: 'multicast-loopback', enabled: false });
    const done: unknown[] = [];
    socket.bind(LOCAL, (e) => done.push(e));
    const host = net.datagrams[0] as FakeDatagram;
    expect(host.log).toEqual(['bind 4000']);
    host.events.listening();
    expect(done).toEqual([undefined]);
    socket.setOption({ kind: 'multicast-ttl', ttl: 1 });
    expect(host.log).toEqual(['bind 4000', 'multicast-ttl', 'multicast-loopback', 'multicast-ttl']);
  });

  it('binds implicitly before the first sendto', async () => {
    const net = new FakeNet();
    const socket = new UdpSocket(net, 4, false);
    socket.setOption({ kind: 'multicast-loopback', enabled: false });
    const sent = socket.sendTo(Uint8Array.of(1, 2), PEER);
    expect(sent).toBeInstanceOf(Promise);
    const host = net.datagrams[0] as FakeDatagram;
    expect(host.log).toEqual(['bind 0']);
    host.events.listening();
    expect(await sent).toEqual({ ok: true, value: 2 });
    expect(host.log).toEqual(['bind 0', 'multicast-loopback', 'send 2']);
    expect(socket.sendTo(Uint8Array.of(3), PEER)).toEqual({ ok: true, value: 1 });
    expect(socket.sendTo(new Uint8Array(65_508), PEER)).toEqual(errno('EMSGSIZE'));
  });

  it('connects, then writes to the peer; unconnected writes are EDESTADDRREQ', async () => {
    const net = new FakeNet();
    const socket = new UdpSocket(net, 4, false);
    expect(socket.write(Uint8Array.of(1))).toEqual(errno('EDESTADDRREQ'));
    const connected = socket.connect(PEER);
    const host = net.datagrams[0] as FakeDatagram;
    host.events.listening();
    host.events.connected();
    expect(await connected).toEqual({ ok: true, value: undefined });
    expect(socket.getsockname().port).toBe(50001);
    expect(socket.write(Uint8Array.of(1))).toEqual({ ok: true, value: 1 });
    expect(host.sent.at(-1)?.to).toBeUndefined();
    // A second connect replaces the peer.
    const again = socket.connect(v4(127, 0, 0, 1, 6000));
    host.events.connected();
    expect(await again).toEqual({ ok: true, value: undefined });
    expect(host.log).toEqual(['connect 5000', 'send 1', 'disconnect', 'connect 6000']);
  });

  it('receives whole datagrams, truncating to the buffer, and reports async errors once', () => {
    const net = new FakeNet();
    const socket = new UdpSocket(net, 4, false);
    socket.bind(LOCAL, () => {});
    const host = net.datagrams[0] as FakeDatagram;
    host.events.listening();
    const wakes = masks(socket);
    host.events.message(Uint8Array.of(1, 2, 3), PEER);
    host.events.message(Uint8Array.of(4), PEER);
    expect(wakes).toEqual([EPOLLIN, EPOLLIN]);
    const dst = new Uint8Array(2);
    expect(socket.recvFrom(dst)).toEqual({ ok: true, value: { n: 2, from: PEER } });
    expect(socket.read(dst)).toEqual({ ok: true, value: 1 });
    expect(socket.read(dst)).toEqual(errno('EAGAIN'));
    host.events.error({ code: 'ECONNREFUSED' });
    expect(socket.poll()).toBe(EPOLLIN | EPOLLOUT | EPOLLERR);
    expect(socket.read(dst)).toEqual(errno('ECONNREFUSED'));
    expect(socket.poll()).toBe(EPOLLOUT);
  });

  it('fails the bind and becomes unbound again on a host error', () => {
    const net = new FakeNet();
    const socket = new UdpSocket(net, 4, false);
    const done: unknown[] = [];
    socket.bind(LOCAL, (e) => done.push(e));
    net.datagrams[0]?.events.error({ code: 'EADDRINUSE' });
    expect(done).toEqual([{ kind: 'native', code: 'EADDRINUSE' }]);
    expect(socket.unbound).toBe(true);
    expect(net.datagrams[0]?.log).toEqual(['bind 4000', 'close']);
  });
});

describe('KernelNetwork', () => {
  function setup(lookup: DnsPort['lookup'], authorize?: () => { kind: 'permission-denied' }) {
    const net = new FakeNet();
    const kernel = new AsyncKernel({
      stdio: memoryStdio(),
      scheduler: new FakeScheduler(),
      stdioKind: () => ok('pipe'),
      files: nodeFiles(),
      net,
      dns: { lookup },
      ...(authorize === undefined ? {} : { authorizeNetwork: authorize }),
    });
    return { kernel, net };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('runs a getaddrinfo Job and links the result in moonrun handle order', async () => {
    const ips: ResolvedIp[] = [{ family: 4, ip: Uint8Array.of(127, 0, 0, 1), scopeId: 0 }];
    const { kernel } = setup(() => Promise.resolve(ok(ips)));
    const job = kernel.network.makeGetaddrinfoJob('localhost');
    expect(kernel.pool.runJob(job).ok).toBe(true);
    await settle();
    const found = kernel.pool.job(job);
    expect(found.ok && found.value.ret).toBe(0);
    const head = kernel.network.getaddrinfoResult(job);
    expect(head.ok).toBe(true);
    if (!head.ok) {
      return;
    }
    const chain: Handle[] = [];
    for (let h = head.value; h !== NULL_HANDLE; ) {
      chain.push(h);
      const next = kernel.network.addrinfoNext(h);
      h = next.ok ? next.value : NULL_HANDLE;
    }
    expect(chain.length).toBe(3);
    // Inserted from the tail: the head is the last issued handle.
    expect(chain[0] !== undefined && chain[2] !== undefined && chain[0] > chain[2]).toBe(true);
    expect(kernel.network.addrinfoAddr(head.value)).toEqual({
      ok: true,
      value: initIpv4(0x7f000001, 0),
    });
    expect(kernel.leakSummary()).toContain('addr_infos=3');
    expect(kernel.network.addrinfoFree(head.value).ok).toBe(true);
    expect(kernel.network.addrInfoCount).toBe(0);
  });

  it('reports EAI failures in ret with an empty result', async () => {
    const { kernel } = setup(() =>
      Promise.resolve({ ok: false, error: { kind: 'eai', code: 'EAI_NONAME' } } as const),
    );
    const job = kernel.network.makeGetaddrinfoJob('does.not.exist');
    kernel.pool.runJob(job);
    await settle();
    const found = kernel.pool.job(job);
    expect(found.ok && [found.value.ret, found.value.err]).toEqual([-2, undefined]);
    expect(kernel.network.getaddrinfoResult(job)).toEqual({ ok: true, value: NULL_HANDLE });
  });

  it('turns a denied lookup or bind into a failed Job', async () => {
    const { kernel } = setup(
      () => Promise.resolve(ok([])),
      () => ({ kind: 'permission-denied' }),
    );
    const job = kernel.network.makeGetaddrinfoJob('example.com');
    kernel.pool.runJob(job);
    const found = kernel.pool.job(job);
    expect(found.ok && found.value.err).toEqual({ kind: 'permission-denied' });
    const fd = kernel.network.makeTcpSocket(4);
    expect(fd.ok).toBe(true);
    if (fd.ok) {
      const bind = kernel.network.makeBindJob(fd.value, () => initIpv4(0x7f000001, 80));
      expect(bind.ok).toBe(true);
      expect(kernel.network.listen(fd.value)).toEqual({
        ok: false,
        error: { kind: 'permission-denied' },
      });
    }
  });

  it('runs a bind Job through the socket and keeps the socket open while it runs', async () => {
    const { kernel, net } = setup(() => Promise.resolve(ok([])));
    const fd = kernel.network.makeTcpSocket(4);
    if (!fd.ok) {
      throw new Error('socket');
    }
    const job = kernel.network.makeBindJob(fd.value, () => initIpv4(0x7f000001, 0));
    if (!job.ok) {
      throw new Error('job');
    }
    kernel.pool.runJob(job.value);
    kernel.closeFd(fd.value);
    expect(net.servers[0]?.closed).toBe(false);
    net.servers[0]?.events.listening();
    const found = kernel.pool.job(job.value);
    expect(found.ok && [found.value.ret, found.value.err]).toEqual([0, undefined]);
    expect(net.servers[0]?.closed).toBe(true);
  });

  it('checks socket classes and interface names', () => {
    const { kernel } = setup(() => Promise.resolve(ok([])));
    const udp = kernel.network.makeUdpSocket(4, false);
    expect(kernel.network.makeTcpSocket(5)).toEqual(inval);
    if (udp.ok) {
      expect(kernel.network.tcp(udp.value)).toEqual(inval);
      expect(kernel.network.listen(udp.value)).toEqual(inval);
      expect(kernel.kindOfFd(udp.value)).toEqual({ ok: true, value: 'socket' });
    }
    expect(kernel.network.ifNameToIndex('eth0')).toEqual({ ok: true, value: 2 });
    expect(kernel.network.ifNameToIndex('nope')).toEqual(errno('ENODEV'));
    expect(kernel.network.ifIndexToName(0)).toEqual(errno('ENXIO'));
    expect(kernel.network.ifIndexToName(9)).toEqual(errno('ENXIO'));
    expect(kernel.network.ipv6TestInterface()).toBe(2);
  });
});
