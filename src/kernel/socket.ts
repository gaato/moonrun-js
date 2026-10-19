import type {
  ByteStream,
  DatagramOption,
  DatagramSocket,
  IpFamily,
  NetPort,
  SocketAddress,
  StreamEvents,
  StreamServer,
} from '../ports/net.ts';
import { err, type HostErrorCode, ok, type Result } from '../ports/result.ts';
import { type AsyncError, BADF, INVAL, native } from './errors.ts';
import { wildcard } from './net-codec.ts';
import {
  EPOLLERR,
  EPOLLHUP,
  EPOLLIN,
  EPOLLOUT,
  EPOLLRDHUP,
  type Pollable,
  type ReadinessListener,
  WaitQueue,
} from './readiness.ts';

/** Bytes buffered from a stream before reading from the host pauses (the receive buffer). */
export const STREAM_RECEIVE_BUFFER = 128 * 1024;
/** Linux `net.core.rmem_default`: datagrams arriving beyond it are dropped. */
export const DATAGRAM_RECEIVE_BUFFER = 212_992;
/** The largest UDP payload over IPv4 / IPv6 (`EMSGSIZE` above). */
const MAX_DATAGRAM: Readonly<Record<IpFamily, number>> = { 4: 65_507, 6: 65_527 };

/** Completion of an asynchronous socket operation (bind, implicit bind, connect). */
export type SocketDone = (error: AsyncError | undefined) => void;

/** A result now, or once the host has finished (the import then suspends the guest). */
export type Eventually<T> = Result<T, AsyncError> | Promise<Result<T, AsyncError>>;

const EAGAIN = native('EAGAIN');

/** An address of the wrong family for the socket, as Linux `bind`/`connect` reject it. */
function familyMismatch(socket: IpFamily, address: SocketAddress): AsyncError | undefined {
  if (address.family === socket) {
    return undefined;
  }
  // An AF_INET6 socket sees a 16-byte sockaddr_in as too short; AF_INET checks sin_family.
  return socket === 6 ? INVAL : native('EAFNOSUPPORT');
}

function eventually<T>(start: (done: (result: Result<T, AsyncError>) => void) => void) {
  return new Promise<Result<T, AsyncError>>((resolve) => start(resolve));
}

/** Common to both socket types: the wait queue and the open-file-description reference count. */
abstract class SocketBase implements Pollable {
  readonly family: IpFamily;
  protected readonly net: NetPort;
  readonly #waiters = new WaitQueue();
  #holders = 1;

  constructor(net: NetPort, family: IpFamily) {
    this.net = net;
    this.family = family;
  }

  abstract poll(): number;

  watch(listener: ReadinessListener): () => void {
    return this.#waiters.watch(listener);
  }

  protected wake(mask: number): void {
    this.#waiters.wake(mask);
  }

  /** Another holder (an in-flight Job) of the open socket. */
  retain(): void {
    this.#holders++;
  }

  /** Ends one hold; the last one closes the socket (`close(2)`). */
  release(): void {
    if (this.#holders === 0) {
      return;
    }
    this.#holders--;
    if (this.#holders === 0) {
      this.closeHost();
      this.wake(0);
    }
  }

  get open(): boolean {
    return this.#holders > 0;
  }

  protected abstract closeHost(): void;
}

type ConnectionPhase = 'connecting' | 'open' | 'reset';

/**
 * One TCP connection's kernel buffers: received bytes, end of stream, send-side
 * backpressure and the pending socket error (`SO_ERROR`).
 */
export class Connection {
  stream: ByteStream | undefined;
  phase: ConnectionPhase;
  /** Peer FIN received. */
  eof = false;
  /** The host refused more data until `drain`. */
  needDrain = false;
  /** `sk_err`: reported once by read, write or `getsockerr`. */
  error: HostErrorCode | undefined;
  local: SocketAddress | undefined;
  peer: SocketAddress | undefined;
  /** Where readiness changes go (the owning socket's wait queue). */
  notify: (mask: number) => void = () => {};
  readonly events: StreamEvents;
  readonly #chunks: Uint8Array[] = [];
  #offset = 0;
  #buffered = 0;
  #paused: boolean;
  #closed = false;

  constructor(phase: ConnectionPhase, paused: boolean) {
    this.phase = phase;
    this.#paused = paused;
    this.events = {
      connected: () => {
        if (this.#closed || this.phase !== 'connecting') {
          return;
        }
        this.phase = 'open';
        this.local = this.stream?.localAddress();
        this.peer = this.stream?.remoteAddress();
        this.notify(EPOLLOUT);
      },
      data: (chunk) => {
        if (this.#closed || chunk.length === 0) {
          return;
        }
        this.#chunks.push(chunk);
        this.#buffered += chunk.length;
        if (this.#buffered >= STREAM_RECEIVE_BUFFER && !this.#paused) {
          this.#paused = true;
          this.stream?.pause();
        }
        this.notify(EPOLLIN);
      },
      end: () => {
        if (this.#closed) {
          return;
        }
        this.eof = true;
        this.notify(EPOLLIN | EPOLLRDHUP);
      },
      drain: () => {
        if (this.#closed || !this.needDrain) {
          return;
        }
        this.needDrain = false;
        this.notify(EPOLLOUT);
      },
      error: (error) => {
        if (this.#closed || this.phase === 'reset') {
          return;
        }
        this.phase = 'reset';
        this.error = error.code;
        this.notify(EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP);
      },
    };
  }

  get buffered(): number {
    return this.#buffered;
  }

  /** Lets an accepted connection's data flow (it was delivered paused). */
  start(): void {
    if (this.#paused && this.#buffered < STREAM_RECEIVE_BUFFER && !this.#closed) {
      this.#paused = false;
      this.stream?.resume();
    }
  }

  poll(): number {
    switch (this.phase) {
      case 'connecting':
        return 0;
      case 'open':
        return (
          (this.#buffered > 0 || this.eof ? EPOLLIN : 0) |
          (this.eof ? EPOLLRDHUP : 0) |
          (this.needDrain ? 0 : EPOLLOUT)
        );
      case 'reset':
        // `tcp_done` shuts both directions: readable (EOF), hung up, no longer writable.
        return EPOLLIN | EPOLLRDHUP | EPOLLHUP | (this.error === undefined ? 0 : EPOLLERR);
    }
  }

  read(dst: Uint8Array): Result<number, AsyncError> {
    if (this.phase === 'connecting') {
      return err(EAGAIN);
    }
    if (dst.length === 0) {
      return ok(0);
    }
    if (this.#buffered > 0) {
      let n = 0;
      while (n < dst.length && this.#chunks.length > 0) {
        const chunk = this.#chunks[0] as Uint8Array;
        const take = Math.min(dst.length - n, chunk.length - this.#offset);
        dst.set(chunk.subarray(this.#offset, this.#offset + take), n);
        n += take;
        this.#offset += take;
        if (this.#offset === chunk.length) {
          this.#chunks.shift();
          this.#offset = 0;
        }
      }
      this.#buffered -= n;
      if (this.#paused && this.#buffered < STREAM_RECEIVE_BUFFER / 2) {
        this.start();
      }
      return ok(n);
    }
    if (this.phase === 'reset') {
      const error = this.takeError();
      return error === undefined ? ok(0) : err(native(error));
    }
    return this.eof ? ok(0) : err(EAGAIN);
  }

  write(src: Uint8Array): Result<number, AsyncError> {
    switch (this.phase) {
      case 'connecting':
        return err(EAGAIN);
      case 'reset': {
        const error = this.takeError();
        return err(native(error ?? 'EPIPE'));
      }
      case 'open':
        if (this.needDrain) {
          return err(EAGAIN);
        }
        if (src.length === 0) {
          return ok(0);
        }
        if (this.stream !== undefined && !this.stream.write(src.slice())) {
          this.needDrain = true;
        }
        return ok(src.length);
    }
  }

  takeError(): HostErrorCode | undefined {
    const error = this.error;
    this.error = undefined;
    return error;
  }

  localAddress(): SocketAddress | undefined {
    if (this.local === undefined && this.phase !== 'reset') {
      this.local = this.stream?.localAddress();
    }
    return this.local;
  }

  /** `close(2)`: unread data makes Linux send RST instead of FIN. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const mode = this.phase === 'open' && this.#buffered === 0 ? 'graceful' : 'reset';
    this.stream?.close(mode);
  }
}

interface ServerState {
  readonly kind: 'server';
  server: StreamServer | undefined;
  /** `binding`: the host has not listened yet; `bound`: listening on the host, not yet for the guest. */
  phase: 'binding' | 'bound' | 'listening';
  readonly backlog: Connection[];
  readonly waiters: SocketDone[];
}

type TcpState =
  | { readonly kind: 'fresh' }
  | ServerState
  | { readonly kind: 'stream'; readonly conn: Connection }
  | { readonly kind: 'closed' };

/**
 * A TCP socket. Hosts without a separate `bind` (Node) listen at bind time, so a
 * bound socket already accepts connections and queues them until the guest
 * listens (D20).
 */
export class TcpSocket extends SocketBase {
  readonly type = 'tcp' as const;
  #state: TcpState;
  #noDelay = false;
  #keepAliveSeconds: number | undefined;
  #reusePort = false;
  #ipv6Only = false;

  constructor(net: NetPort, family: IpFamily, conn?: Connection) {
    super(net, family);
    if (conn === undefined) {
      this.#state = { kind: 'fresh' };
    } else {
      this.#state = { kind: 'stream', conn };
      conn.notify = (mask) => this.wake(mask);
    }
  }

  get unbound(): boolean {
    return this.#state.kind === 'fresh';
  }

  poll(): number {
    const state = this.#state;
    switch (state.kind) {
      case 'fresh':
        // An unconnected socket (`TCP_CLOSE`) is writable and hung up.
        return EPOLLOUT | EPOLLHUP;
      case 'server':
        if (state.phase !== 'listening') {
          return EPOLLOUT | EPOLLHUP;
        }
        return state.backlog.length > 0 ? EPOLLIN : 0;
      case 'stream':
        return state.conn.poll();
      case 'closed':
        return 0;
    }
  }

  /** Starts binding (the host listens); `done` reports the outcome. */
  bind(local: SocketAddress, done: SocketDone): Result<void, AsyncError> {
    if (this.#state.kind !== 'fresh') {
      return err(INVAL);
    }
    const mismatch = familyMismatch(this.family, local);
    if (mismatch !== undefined) {
      return err(mismatch);
    }
    const state: ServerState = {
      kind: 'server',
      server: undefined,
      phase: 'binding',
      backlog: [],
      waiters: [done],
    };
    this.#state = state;
    const settle = (error: AsyncError | undefined): void => {
      const waiters = state.waiters.splice(0);
      for (const waiter of waiters) {
        waiter(error);
      }
    };
    state.server = this.net.listen(
      { local, ipv6Only: this.#ipv6Only, reusePort: this.#reusePort },
      {
        listening: () => {
          if (this.#state === state && state.phase === 'binding') {
            state.phase = 'bound';
            settle(undefined);
          }
        },
        error: (error) => {
          if (this.#state === state && state.phase === 'binding') {
            this.#state = { kind: 'fresh' };
            state.server?.close();
            settle(native(error.code));
          }
        },
        connection: (stream) => {
          const conn = new Connection('open', true);
          conn.stream = stream;
          conn.local = stream.localAddress();
          conn.peer = stream.remoteAddress();
          if (this.#state !== state || !this.open) {
            conn.close();
            return conn.events;
          }
          state.backlog.push(conn);
          if (state.phase === 'listening') {
            this.wake(EPOLLIN);
          }
          return conn.events;
        },
      },
    );
    return ok(undefined);
  }

  /** `listen(2)`; an unbound socket first binds the family's wildcard address. */
  listen(): Eventually<void> {
    const state = this.#state;
    switch (state.kind) {
      case 'fresh':
        return eventually((resolve) => {
          const started = this.bind(wildcard(this.family), (error) => {
            resolve(error === undefined ? this.#markListening() : err(error));
          });
          if (!started.ok) {
            resolve(started);
          }
        });
      case 'server':
        if (state.phase === 'binding') {
          return eventually((resolve) => {
            state.waiters.push((error) => {
              resolve(error === undefined ? this.#markListening() : err(error));
            });
          });
        }
        return this.#markListening();
      case 'stream':
        return err(INVAL);
      case 'closed':
        return err(BADF);
    }
  }

  #markListening(): Result<void, AsyncError> {
    const state = this.#state;
    if (state.kind !== 'server') {
      return err(INVAL);
    }
    if (state.phase !== 'listening') {
      state.phase = 'listening';
      if (state.backlog.length > 0) {
        this.wake(EPOLLIN);
      }
    }
    return ok(undefined);
  }

  /** Nonblocking `connect(2)`: `EINPROGRESS` once the attempt started. */
  connect(remote: SocketAddress): Result<void, AsyncError> {
    const state = this.#state;
    switch (state.kind) {
      case 'stream':
        if (state.conn.phase === 'connecting') {
          return err(native('EALREADY'));
        }
        if (state.conn.phase === 'open') {
          return err(native('EISCONN'));
        }
        break;
      case 'server':
        // The host listens at bind time, so a bound socket cannot connect any more (D20).
        return err(native('EISCONN'));
      case 'closed':
        return err(BADF);
      case 'fresh':
        break;
    }
    const mismatch = familyMismatch(this.family, remote);
    if (mismatch !== undefined) {
      return err(mismatch);
    }
    const conn = new Connection('connecting', false);
    conn.notify = (mask) => this.wake(mask);
    this.#state = { kind: 'stream', conn };
    conn.stream = this.net.connect(
      { remote, noDelay: this.#noDelay, keepAliveSeconds: this.#keepAliveSeconds },
      conn.events,
    );
    return err(native('EINPROGRESS'));
  }

  /** `accept(2)`: the next queued connection as a new socket, and its peer. */
  accept(): Result<{ socket: TcpSocket; peer: SocketAddress | undefined }, AsyncError> {
    const state = this.#state;
    if (state.kind !== 'server' || state.phase !== 'listening') {
      return err(INVAL);
    }
    const conn = state.backlog.shift();
    if (conn === undefined) {
      return err(EAGAIN);
    }
    const socket = new TcpSocket(this.net, this.family, conn);
    conn.start();
    return ok({ socket, peer: conn.peer });
  }

  getsockname(): SocketAddress {
    const state = this.#state;
    switch (state.kind) {
      case 'server':
        return state.server?.localAddress() ?? wildcard(this.family);
      case 'stream':
        return state.conn.localAddress() ?? wildcard(this.family);
      case 'fresh':
      case 'closed':
        return wildcard(this.family);
    }
  }

  /** `SO_ERROR`: the pending error, cleared by reading it. */
  takeError(): HostErrorCode | undefined {
    return this.#state.kind === 'stream' ? this.#state.conn.takeError() : undefined;
  }

  read(dst: Uint8Array): Result<number, AsyncError> {
    return this.#state.kind === 'stream' ? this.#state.conn.read(dst) : err(native('ENOTCONN'));
  }

  write(src: Uint8Array): Result<number, AsyncError> {
    return this.#state.kind === 'stream' ? this.#state.conn.write(src) : err(native('EPIPE'));
  }

  setNoDelay(): Result<void, AsyncError> {
    this.#noDelay = true;
    if (this.#state.kind === 'stream') {
      this.#state.conn.stream?.setNoDelay(true);
    }
    return ok(undefined);
  }

  /** `SO_KEEPALIVE` plus the Linux `TCP_KEEP*` values that are positive. */
  enableKeepAlive(idle: number, count: number, interval: number): Result<void, AsyncError> {
    // Linux bounds: TCP_KEEPCNT ≤ 127, TCP_KEEPIDLE and TCP_KEEPINTVL ≤ 32767 seconds.
    if (count > 127 || idle > 32_767 || interval > 32_767) {
      return err(INVAL);
    }
    this.#keepAliveSeconds = idle > 0 ? idle : (this.#keepAliveSeconds ?? 0);
    if (this.#state.kind === 'stream') {
      this.#state.conn.stream?.setKeepAlive(true, this.#keepAliveSeconds);
    }
    return ok(undefined);
  }

  /** `SO_REUSEADDR`: the host always reuses addresses of TCP listeners (D20). */
  allowReuseAddr(): Result<void, AsyncError> {
    return ok(undefined);
  }

  allowReusePort(): Result<void, AsyncError> {
    this.#reusePort = true;
    return ok(undefined);
  }

  setIpv6Only(enabled: boolean): Result<void, AsyncError> {
    if (this.family !== 6) {
      return err(native('ENOPROTOOPT'));
    }
    if (this.#state.kind !== 'fresh') {
      return err(INVAL);
    }
    this.#ipv6Only = enabled;
    return ok(undefined);
  }

  protected closeHost(): void {
    const state = this.#state;
    this.#state = { kind: 'closed' };
    switch (state.kind) {
      case 'server':
        state.server?.close();
        for (const conn of state.backlog.splice(0)) {
          conn.phase = 'reset';
          conn.close();
        }
        for (const waiter of state.waiters.splice(0)) {
          waiter(BADF);
        }
        return;
      case 'stream':
        state.conn.close();
        return;
      case 'fresh':
      case 'closed':
        return;
    }
  }
}

interface Datagram {
  readonly data: Uint8Array;
  readonly from: SocketAddress;
}

/**
 * A UDP socket. The host socket is created at the first bind, connect or send
 * (when the Linux socket would be bound); options set before are replayed then.
 */
export class UdpSocket extends SocketBase {
  readonly type = 'udp' as const;
  #socket: DatagramSocket | undefined;
  /** Waiting for the host bind (explicit or implied) to finish. */
  #binding: SocketDone[] | undefined;
  #connecting: SocketDone[] | undefined;
  #pendingRemote: SocketAddress | undefined;
  #connected: SocketAddress | undefined;
  readonly #options: DatagramOption[] = [];
  #reuseAddr: boolean;
  #reusePort = false;
  #ipv6Only = false;
  readonly #queue: Datagram[] = [];
  #queued = 0;
  #error: HostErrorCode | undefined;
  #closed = false;

  constructor(net: NetPort, family: IpFamily, reuseAddr: boolean) {
    super(net, family);
    this.#reuseAddr = reuseAddr;
  }

  get unbound(): boolean {
    return this.#socket === undefined;
  }

  poll(): number {
    if (this.#closed) {
      return 0;
    }
    return (
      (this.#queue.length > 0 || this.#error !== undefined ? EPOLLIN : 0) |
      EPOLLOUT |
      (this.#error === undefined ? 0 : EPOLLERR)
    );
  }

  bind(local: SocketAddress, done: SocketDone): Result<void, AsyncError> {
    if (this.#socket !== undefined) {
      return err(INVAL);
    }
    const mismatch = familyMismatch(this.family, local);
    if (mismatch !== undefined) {
      return err(mismatch);
    }
    this.#binding = [done];
    this.#create().bind(local);
    return ok(undefined);
  }

  /** `connect(2)` on UDP: implies a bind; finishes once the host has connected. */
  connect(remote: SocketAddress): Eventually<void> {
    if (this.#closed) {
      return err(BADF);
    }
    const mismatch = familyMismatch(this.family, remote);
    if (mismatch !== undefined) {
      return err(mismatch);
    }
    return eventually((resolve) => {
      const start = (): void => {
        const socket = this.#socket;
        if (socket === undefined || this.#closed) {
          resolve(err(BADF));
          return;
        }
        if (this.#connected !== undefined) {
          socket.disconnect();
          this.#connected = undefined;
        }
        this.#pendingRemote = remote;
        this.#connecting = [(error) => resolve(error === undefined ? ok(undefined) : err(error))];
        socket.connect(remote);
      };
      if (this.#socket === undefined) {
        // The host binds implicitly; `listening` then `connected` follow.
        this.#binding = [];
        this.#pendingRemote = remote;
        this.#connecting = [(error) => resolve(error === undefined ? ok(undefined) : err(error))];
        this.#create().connect(remote);
      } else if (this.#binding !== undefined) {
        this.#binding.push((error) => (error === undefined ? start() : resolve(err(error))));
      } else {
        start();
      }
    });
  }

  /** `sendto(2)`; an unbound socket binds the wildcard address first. */
  sendTo(data: Uint8Array, to: SocketAddress): Eventually<number> {
    if (this.#closed) {
      return err(BADF);
    }
    const mismatch = familyMismatch(this.family, to);
    if (mismatch !== undefined) {
      return err(mismatch);
    }
    if (data.length > MAX_DATAGRAM[this.family]) {
      return err(native('EMSGSIZE'));
    }
    const copy = data.slice();
    const send = (): Result<number, AsyncError> => {
      const socket = this.#socket;
      if (socket === undefined || this.#closed) {
        return err(BADF);
      }
      // A host socket bound to one peer cannot address another (Linux UDP could).
      if (this.#connected !== undefined) {
        return err(native('EISCONN'));
      }
      socket.send(copy, to);
      return ok(copy.length);
    };
    if (this.#socket !== undefined && this.#binding === undefined) {
      return send();
    }
    return eventually((resolve) => {
      const after: SocketDone = (error) => resolve(error === undefined ? send() : err(error));
      if (this.#socket === undefined) {
        this.#binding = [after];
        this.#create().bind(wildcard(this.family));
      } else {
        this.#binding?.push(after);
      }
    });
  }

  /** `write(2)`: the connected peer only. */
  write(src: Uint8Array): Result<number, AsyncError> {
    const socket = this.#socket;
    if (this.#connected === undefined || socket === undefined) {
      return err(native('EDESTADDRREQ'));
    }
    if (src.length > MAX_DATAGRAM[this.family]) {
      return err(native('EMSGSIZE'));
    }
    socket.send(src.slice(), undefined);
    return ok(src.length);
  }

  /** `recvfrom(2)`: one datagram, truncated to `dst`. */
  recvFrom(dst: Uint8Array): Result<{ n: number; from: SocketAddress }, AsyncError> {
    const datagram = this.#queue.shift();
    if (datagram === undefined) {
      const error = this.takeError();
      return err(error === undefined ? EAGAIN : native(error));
    }
    this.#queued -= datagram.data.length;
    const n = Math.min(dst.length, datagram.data.length);
    dst.set(datagram.data.subarray(0, n));
    return ok({ n, from: datagram.from });
  }

  read(dst: Uint8Array): Result<number, AsyncError> {
    const r = this.recvFrom(dst);
    return r.ok ? ok(r.value.n) : r;
  }

  getsockname(): SocketAddress {
    return (
      (this.#binding === undefined ? this.#socket?.localAddress() : undefined) ??
      wildcard(this.family)
    );
  }

  takeError(): HostErrorCode | undefined {
    const error = this.#error;
    this.#error = undefined;
    return error;
  }

  /** A multicast or interface option: applied now when bound, otherwise when the host binds. */
  setOption(option: DatagramOption): Result<void, AsyncError> {
    if (this.#socket === undefined || this.#binding !== undefined) {
      this.#options.push(option);
      return ok(undefined);
    }
    const r = this.#socket.setOption(option);
    return r.ok ? ok(undefined) : err(native(r.error.code));
  }

  allowReuseAddr(): Result<void, AsyncError> {
    this.#reuseAddr = true;
    return ok(undefined);
  }

  allowReusePort(): Result<void, AsyncError> {
    this.#reusePort = true;
    return ok(undefined);
  }

  setIpv6Only(enabled: boolean): Result<void, AsyncError> {
    if (this.family !== 6) {
      return err(native('ENOPROTOOPT'));
    }
    if (this.#socket !== undefined) {
      return err(INVAL);
    }
    this.#ipv6Only = enabled;
    return ok(undefined);
  }

  #create(): DatagramSocket {
    const socket = this.net.datagram(
      this.family,
      { reuseAddr: this.#reuseAddr, reusePort: this.#reusePort, ipv6Only: this.#ipv6Only },
      {
        listening: () => {
          if (this.#socket !== socket || this.#binding === undefined) {
            return;
          }
          const waiters = this.#binding;
          this.#binding = undefined;
          // Options the guest set before the bind, in order; their errors were already reported as success.
          for (const option of this.#options.splice(0)) {
            socket.setOption(option);
          }
          for (const waiter of waiters) {
            waiter(undefined);
          }
        },
        connected: () => {
          if (this.#socket !== socket || this.#connecting === undefined) {
            return;
          }
          const waiters = this.#connecting;
          this.#connecting = undefined;
          this.#connected = this.#pendingRemote;
          for (const waiter of waiters) {
            waiter(undefined);
          }
        },
        message: (data, from) => {
          if (this.#socket !== socket || this.#closed) {
            return;
          }
          if (this.#queued + data.length > DATAGRAM_RECEIVE_BUFFER) {
            return;
          }
          this.#queue.push({ data, from });
          this.#queued += data.length;
          this.wake(EPOLLIN);
        },
        error: (error) => {
          if (this.#socket !== socket || this.#closed) {
            return;
          }
          const failure = native(error.code);
          if (this.#binding !== undefined) {
            // The bind failed: the socket is unbound again.
            const waiters = this.#binding;
            const connecting = this.#connecting ?? [];
            this.#binding = undefined;
            this.#connecting = undefined;
            this.#socket = undefined;
            socket.close();
            for (const waiter of [...waiters, ...connecting]) {
              waiter(failure);
            }
            return;
          }
          if (this.#connecting !== undefined) {
            const waiters = this.#connecting;
            this.#connecting = undefined;
            for (const waiter of waiters) {
              waiter(failure);
            }
            return;
          }
          this.#error = error.code;
          this.wake(EPOLLIN | EPOLLERR);
        },
      },
    );
    this.#socket = socket;
    return socket;
  }

  protected closeHost(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    for (const waiter of [...(this.#binding ?? []), ...(this.#connecting ?? [])]) {
      waiter(BADF);
    }
    this.#binding = undefined;
    this.#connecting = undefined;
  }
}

export type Socket = TcpSocket | UdpSocket;
