import type { HostError, Result } from './result.ts';

/**
 * Sockets and name resolution as the async kernel needs them.
 *
 * The shapes are those of a byte duplex (TCP), a datagram endpoint (UDP) and a
 * resolver, not of `node:net`: a browser or workerd adapter can implement them
 * over a relay. Every operation that a host can only do asynchronously reports
 * through an events object; nothing here blocks.
 */

export type IpFamily = 4 | 6;

/** An IP endpoint. `ip` is 4 or 16 network-order bytes. */
export interface SocketAddress {
  readonly family: IpFamily;
  readonly ip: Uint8Array;
  readonly port: number;
  /** IPv6 flow information (network order as a number); 0 for IPv4. */
  readonly flowInfo: number;
  /** IPv6 scope (interface index); 0 for IPv4. */
  readonly scopeId: number;
}

/** Events of one byte stream. Each callback runs on the host event loop, never re-entrantly. */
export interface StreamEvents {
  /** The connection attempt succeeded (connect streams only). */
  connected(): void;
  data(chunk: Uint8Array): void;
  /** The peer shut down its sending side (FIN); the stream stays writable. */
  end(): void;
  /** Buffered writes went below the high-water mark again. */
  drain(): void;
  error(error: HostError): void;
}

/** A connected (or connecting) TCP stream. */
export interface ByteStream {
  /**
   * Queues `data` (owned by the stream from now on). False when the host buffer is
   * above its high-water mark: wait for `drain` before writing more.
   */
  write(data: Uint8Array): boolean;
  /** Stops delivering `data` events (receive-side backpressure). */
  pause(): void;
  resume(): void;
  /** `graceful` flushes queued writes then sends FIN; `reset` discards them and sends RST. */
  close(mode: 'graceful' | 'reset'): void;
  localAddress(): SocketAddress | undefined;
  remoteAddress(): SocketAddress | undefined;
  setNoDelay(enabled: boolean): void;
  /** `idleSeconds` 0 keeps the host default. */
  setKeepAlive(enabled: boolean, idleSeconds: number): void;
}

export interface ConnectOptions {
  readonly remote: SocketAddress;
  readonly noDelay: boolean;
  /** Keepalive idle time in seconds, 0 for the host default; undefined disables keepalive. */
  readonly keepAliveSeconds: number | undefined;
}

export interface ListenOptions {
  readonly local: SocketAddress;
  /** `IPV6_V6ONLY` for an IPv6 wildcard address. */
  readonly ipv6Only: boolean;
  /** `SO_REUSEPORT` (load-balancing listeners on one address). */
  readonly reusePort: boolean;
}

export interface ServerEvents {
  listening(): void;
  error(error: HostError): void;
  /**
   * An accepted connection, delivered paused. The returned sink receives its
   * events; the kernel resumes it when the guest accepts it.
   */
  connection(stream: ByteStream): StreamEvents;
}

/** A listening TCP endpoint. */
export interface StreamServer {
  localAddress(): SocketAddress | undefined;
  close(): void;
}

export interface DatagramOptions {
  /** `SO_REUSEADDR`. */
  readonly reuseAddr: boolean;
  /** `SO_REUSEPORT`. */
  readonly reusePort: boolean;
  /** `IPV6_V6ONLY` (IPv6 sockets). */
  readonly ipv6Only: boolean;
}

export interface DatagramEvents {
  /** `bind` (explicit or implied by `connect`) finished. */
  listening(): void;
  connected(): void;
  message(data: Uint8Array, from: SocketAddress): void;
  /** A bind, connect or asynchronous send/receive failure. */
  error(error: HostError): void;
}

/** A per-socket option of a bound datagram socket (the Linux `setsockopt`s used by the guest). */
export type DatagramOption =
  | { readonly kind: 'multicast-ttl'; readonly ttl: number }
  | { readonly kind: 'multicast-loopback'; readonly enabled: boolean }
  /** IPv4: the interface address; IPv6: `interfaceIndex` (0 = default). */
  | { readonly kind: 'multicast-interface'; readonly address: SocketAddress }
  | {
      readonly kind: 'add-membership';
      readonly group: SocketAddress;
      /** IPv4: the local interface address (0.0.0.0 = any); IPv6: `scopeId` is the interface index. */
      readonly local: SocketAddress;
    };

/** A UDP endpoint. Created unbound; `bind` or `connect` must finish before `send`. */
export interface DatagramSocket {
  bind(local: SocketAddress): void;
  connect(remote: SocketAddress): void;
  disconnect(): void;
  /** Sends one datagram now (to the connected peer when `to` is undefined); failures arrive as `error`. */
  send(data: Uint8Array, to: SocketAddress | undefined): void;
  setOption(option: DatagramOption): Result<void, HostError>;
  localAddress(): SocketAddress | undefined;
  close(): void;
}

/** A network interface as `getifaddrs` sees it. */
export interface NetInterface {
  readonly name: string;
  readonly index: number;
  readonly up: boolean;
  readonly running: boolean;
  readonly loopback: boolean;
  readonly multicast: boolean;
  readonly addresses: readonly SocketAddress[];
}

export interface NetPort {
  connect(options: ConnectOptions, events: StreamEvents): ByteStream;
  listen(options: ListenOptions, events: ServerEvents): StreamServer;
  datagram(family: IpFamily, options: DatagramOptions, events: DatagramEvents): DatagramSocket;
  interfaces(): readonly NetInterface[];
}

/** `getaddrinfo` failure codes (glibc names; the kernel encodes the numbers). */
export type EaiCode =
  | 'EAI_BADFLAGS'
  | 'EAI_NONAME'
  | 'EAI_AGAIN'
  | 'EAI_FAIL'
  | 'EAI_NODATA'
  | 'EAI_FAMILY'
  | 'EAI_SOCKTYPE'
  | 'EAI_SERVICE'
  | 'EAI_ADDRFAMILY'
  | 'EAI_MEMORY'
  | 'EAI_OVERFLOW';

export type LookupError =
  | { readonly kind: 'eai'; readonly code: EaiCode }
  /** `EAI_SYSTEM`: the OS error behind it. */
  | { readonly kind: 'system'; readonly error: HostError };

/** One resolved address (no port). */
export interface ResolvedIp {
  readonly family: IpFamily;
  readonly ip: Uint8Array;
  readonly scopeId: number;
}

export interface DnsPort {
  /**
   * `getaddrinfo(host, NULL, {AI_ADDRCONFIG, AF_UNSPEC})` addresses in resolver
   * order, one entry per address (no per-socket-type duplicates).
   */
  lookup(host: string): Promise<Result<readonly ResolvedIp[], LookupError>>;
}
