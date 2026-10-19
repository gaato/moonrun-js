import type { IpFamily, NetPort, SocketAddress } from '../ports/net.ts';
import { err, type HostErrorCode, ok, type Result } from '../ports/result.ts';
import type { CBuffers } from './c-buffers.ts';
import { type AsyncError, BADF, INVAL, native } from './errors.ts';
import { type Handle, Handles, type HostKeys, NULL_HANDLE } from './handles.ts';
import { decodeSockaddr, encodeSockaddr, sockaddrLength, wildcard } from './net-codec.ts';
import { acquire, type Resource, type ResourceTable, relinquish } from './resource.ts';
import { type Eventually, type Socket, TcpSocket, UdpSocket } from './socket.ts';
import type { ThreadPool } from './thread-pool.ts';

/** A network effect the sandbox policy may deny (moonrun `NetOperation` + DNS). */
export type NetworkRequest =
  | { readonly kind: 'dns'; readonly host: string }
  | { readonly kind: 'connect'; readonly address: SocketAddress }
  | { readonly kind: 'bind'; readonly address: SocketAddress };

export interface NetworkOptions {
  readonly net: NetPort;
  /**
   * The `--policy` seam (moonrun `HostNetwork::check_*`): an error denies the
   * operation. Allows everything when absent.
   */
  readonly authorize?: (request: NetworkRequest) => AsyncError | undefined;
  /** Resolved addresses the guest fetched (moonrun `resolved_connect_rules`). */
  readonly recordResolved?: (host: string, addresses: readonly Uint8Array[]) => void;
}

/** One `getaddrinfo` result entry; the list is linked like `struct addrinfo`. */
interface AddrInfo {
  readonly addr: Uint8Array;
  readonly next: Handle | undefined;
}

type SocketType = 'tcp' | 'udp';

/** Truncates an encoded address to a guest buffer, as the kernel copies `min(len, actual)` bytes. */
function fitted(address: SocketAddress, len: number): Uint8Array {
  const bytes = encodeSockaddr(address);
  return bytes.length > len ? bytes.subarray(0, len) : bytes;
}

/**
 * The network part of the Async Host (moonrun `HostNetwork` plus the socket
 * methods of `AsyncHost`). Byte buffers are guest views or copies the ABI owns.
 */
export class KernelNetwork {
  readonly #resources: ResourceTable;
  readonly #pool: ThreadPool;
  readonly #cBuffers: CBuffers;
  readonly #addrInfos: Handles<AddrInfo>;
  readonly #options: NetworkOptions;

  constructor(
    keys: HostKeys,
    resources: ResourceTable,
    pool: ThreadPool,
    cBuffers: CBuffers,
    options: NetworkOptions,
  ) {
    this.#resources = resources;
    this.#pool = pool;
    this.#cBuffers = cBuffers;
    this.#addrInfos = new Handles(keys, 'addr-info');
    this.#options = options;
  }

  // ----- sockets -----

  makeTcpSocket(family: number): Result<Handle, AsyncError> {
    const f = ipFamily(family);
    if (f === undefined) {
      return err(INVAL);
    }
    return ok(this.#insert(new TcpSocket(this.#options.net, f)));
  }

  makeUdpSocket(family: number, multicast: boolean): Result<Handle, AsyncError> {
    const f = ipFamily(family);
    if (f === undefined) {
      return err(INVAL);
    }
    // Linux sets SO_REUSEADDR on multicast sockets so several receivers share a port.
    return ok(this.#insert(new UdpSocket(this.#options.net, f, multicast)));
  }

  /** `with_raw_socket`: any socket (`Inval` for other resources). */
  socket(fd: Handle): Result<Socket, AsyncError> {
    const resource = this.#resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    return resource.value.kind === 'socket' ? ok(resource.value.socket) : err(INVAL);
  }

  tcp(fd: Handle): Result<TcpSocket, AsyncError> {
    return this.#ofType(fd, 'tcp') as Result<TcpSocket, AsyncError>;
  }

  udp(fd: Handle): Result<UdpSocket, AsyncError> {
    return this.#ofType(fd, 'udp') as Result<UdpSocket, AsyncError>;
  }

  /** The synchronous `socket/bind` import; the host binds asynchronously, so it may suspend. */
  bind(fd: Handle, addr: Uint8Array): Eventually<void> {
    const resource = this.#resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const denied = this.#check('bind', addr);
    if (denied !== undefined) {
      return err(denied);
    }
    if (resource.value.kind !== 'socket') {
      return err(INVAL);
    }
    const socket = resource.value.socket;
    const address = decodeSockaddr(addr);
    if (!address.ok) {
      return address;
    }
    return new Promise((resolve) => {
      const started = socket.bind(address.value, (error) =>
        resolve(error === undefined ? ok(undefined) : err(error)),
      );
      if (!started.ok) {
        resolve(started);
      }
    });
  }

  /** `listen(2)`; an unbound socket's implicit bind is authorized first (moonrun `listen`). */
  listen(fd: Handle): Eventually<void> {
    const socket = this.tcp(fd);
    if (!socket.ok) {
      return socket;
    }
    if (socket.value.unbound) {
      const denied = this.#authorize({ kind: 'bind', address: wildcard(socket.value.family) });
      if (denied !== undefined) {
        return err(denied);
      }
    }
    return socket.value.listen();
  }

  connectTcp(fd: Handle, addr: Uint8Array): Result<void, AsyncError> {
    const resource = this.#resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const denied = this.#check('connect', addr);
    if (denied !== undefined) {
      return err(denied);
    }
    const socket = this.#classOf(resource.value, 'tcp');
    if (!socket.ok) {
      return socket;
    }
    const address = decodeSockaddr(addr);
    return address.ok ? (socket.value as TcpSocket).connect(address.value) : address;
  }

  connectUdp(fd: Handle, addr: Uint8Array): Eventually<void> {
    const resource = this.#resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const denied = this.#check('connect', addr);
    if (denied !== undefined) {
      return err(denied);
    }
    const socket = this.#classOf(resource.value, 'udp');
    if (!socket.ok) {
      return socket;
    }
    const address = decodeSockaddr(addr);
    return address.ok ? (socket.value as UdpSocket).connect(address.value) : address;
  }

  sendTo(fd: Handle, data: Uint8Array, addr: Uint8Array): Eventually<number> {
    const resource = this.#resources.get(fd);
    if (!resource.ok) {
      return resource;
    }
    const denied = this.#check('connect', addr);
    if (denied !== undefined) {
      return err(denied);
    }
    const socket = this.#classOf(resource.value, 'udp');
    if (!socket.ok) {
      return socket;
    }
    const address = decodeSockaddr(addr);
    return address.ok ? (socket.value as UdpSocket).sendTo(data, address.value) : address;
  }

  /** `recvfrom(2)` into `dst`; the source address replaces the start of `addr`. */
  recvFrom(fd: Handle, dst: Uint8Array, addr: Uint8Array): Result<number, AsyncError> {
    const socket = this.udp(fd);
    if (!socket.ok) {
      return socket;
    }
    const len = sockaddrLength(addr);
    if (!len.ok) {
      return len;
    }
    const r = socket.value.recvFrom(dst);
    if (!r.ok) {
      return r;
    }
    addr.set(fitted(r.value.from, len.value));
    return ok(r.value.n);
  }

  /** `accept(2)`: the new socket's handle; the peer address replaces the start of `addr`. */
  accept(fd: Handle, addr: Uint8Array): Result<Handle, AsyncError> {
    const socket = this.tcp(fd);
    if (!socket.ok) {
      return socket;
    }
    const len = sockaddrLength(addr);
    if (!len.ok) {
      return len;
    }
    const accepted = socket.value.accept();
    if (!accepted.ok) {
      return accepted;
    }
    const peer = accepted.value.peer ?? wildcard(socket.value.family);
    addr.set(fitted(peer, len.value));
    return ok(this.#insert(accepted.value.socket));
  }

  /** `getsockname(2)` into a guest buffer of `addr.length` bytes. */
  getsockname(fd: Handle, addr: Uint8Array): Result<void, AsyncError> {
    const socket = this.socket(fd);
    if (!socket.ok) {
      return socket;
    }
    addr.set(fitted(socket.value.getsockname(), addr.length));
    return ok(undefined);
  }

  /** `SO_ERROR`. */
  takeSocketError(fd: Handle): Result<HostErrorCode | undefined, AsyncError> {
    const socket = this.socket(fd);
    return socket.ok ? ok(socket.value.takeError()) : socket;
  }

  // ----- jobs -----

  /** `make_bind_job`: a denied address yields a failed Job, not an import error. */
  makeBindJob(fd: Handle, addr: () => Uint8Array): Result<Handle, AsyncError> {
    const found = this.#resources.get(fd);
    if (!found.ok) {
      return found;
    }
    if (found.value.kind !== 'socket') {
      return err(INVAL);
    }
    // `acquire_socket_resource`: the Job holds the socket open until it has run.
    const resource = acquire(found.value);
    let address: Uint8Array;
    try {
      address = addr();
    } catch (e) {
      relinquish(resource);
      throw e;
    }
    const denied = this.#check('bind', address);
    if (denied !== undefined) {
      relinquish(resource);
      return ok(this.#pool.insertJob({ kind: 'failed', error: denied }));
    }
    return ok(this.#pool.insertJob({ kind: 'bind', resource, address }));
  }

  makeGetaddrinfoJob(host: string): Handle {
    const denied = this.#authorize({ kind: 'dns', host });
    if (denied !== undefined) {
      return this.#pool.insertJob({ kind: 'failed', error: denied });
    }
    return this.#pool.insertJob({ kind: 'getaddrinfo', host, result: undefined });
  }

  /** `get_getaddrinfo_result`: the head of a fresh addrinfo list (null when empty). */
  getaddrinfoResult(job: Handle): Result<Handle, AsyncError> {
    const found = this.#pool.job(job);
    if (!found.ok) {
      return found;
    }
    const payload = found.value.payload;
    if (payload.kind !== 'getaddrinfo') {
      return err(BADF);
    }
    if (payload.result === undefined) {
      return err(INVAL);
    }
    this.#options.recordResolved?.(payload.host, payload.result);
    let next: Handle | undefined;
    // moonrun links the list from the tail, so handles are issued in reverse.
    for (const addr of [...payload.result].reverse()) {
      next = this.#addrInfos.insert({ addr: addr.slice(), next });
    }
    return ok(next ?? NULL_HANDLE);
  }

  addrinfoNext(handle: Handle): Result<Handle, AsyncError> {
    if (handle === NULL_HANDLE) {
      return ok(NULL_HANDLE);
    }
    const info = this.#addrInfos.get(handle);
    return info === undefined ? err(BADF) : ok(info.next ?? NULL_HANDLE);
  }

  addrinfoAddr(handle: Handle): Result<Uint8Array, AsyncError> {
    const info = this.#addrInfos.get(handle);
    return info === undefined ? err(BADF) : ok(info.addr);
  }

  /** Frees a whole list from `handle` on; a missing entry stops with `Badf`. */
  addrinfoFree(handle: Handle): Result<void, AsyncError> {
    let current: Handle | undefined = handle === NULL_HANDLE ? undefined : handle;
    while (current !== undefined) {
      const info = this.#addrInfos.remove(current);
      if (info === undefined) {
        return err(BADF);
      }
      current = info.next;
    }
    return ok(undefined);
  }

  get addrInfoCount(): number {
    return this.#addrInfos.size;
  }

  // ----- interfaces -----

  /** `if_nametoindex`: `ENODEV` for an unknown name. */
  ifNameToIndex(name: string): Result<number, AsyncError> {
    if (name.includes('\0')) {
      return err(INVAL);
    }
    const found = this.#options.net.interfaces().find((i) => i.name === name);
    return found === undefined ? err(native('ENODEV')) : ok(found.index);
  }

  /** `if_indextoname`: the NUL-terminated name, `ENXIO` for an unknown index. */
  ifIndexToName(index: number): Result<Handle, AsyncError> {
    const found = this.#options.net.interfaces().find((i) => i.index === index);
    if (found === undefined) {
      return err(native('ENXIO'));
    }
    const bytes = new TextEncoder().encode(found.name);
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes);
    return ok(this.#cBuffers.insert(out));
  }

  /**
   * moonrun's test-interface probe: the first up, running, multicast-capable,
   * non-loopback interface with an IPv6 link-local address; 0 when none.
   */
  ipv6TestInterface(): number {
    for (const i of this.#options.net.interfaces()) {
      if (i.loopback || !i.up || !i.running || !i.multicast) {
        continue;
      }
      const linkLocal = i.addresses.some(
        (a) => a.family === 6 && a.ip[0] === 0xfe && ((a.ip[1] ?? 0) & 0xc0) === 0x80,
      );
      if (linkLocal) {
        return i.index;
      }
    }
    return 0;
  }

  #insert(socket: Socket): Handle {
    return this.#resources.insert({ kind: 'socket', socket });
  }

  #ofType(fd: Handle, type: SocketType): Result<Socket, AsyncError> {
    const resource = this.#resources.get(fd);
    return resource.ok ? this.#classOf(resource.value, type) : resource;
  }

  /** `resource_of_class`: `Inval` unless the resource is a socket of `type`. */
  #classOf(resource: Resource, type: SocketType): Result<Socket, AsyncError> {
    return resource.kind === 'socket' && resource.socket.type === type
      ? ok(resource.socket)
      : err(INVAL);
  }

  /** A policy check of a guest address; only with a policy is the address decoded here. */
  #check(kind: 'bind' | 'connect', addr: Uint8Array): AsyncError | undefined {
    if (this.#options.authorize === undefined) {
      return undefined;
    }
    const address = decodeSockaddr(addr);
    return address.ok ? this.#authorize({ kind, address: address.value }) : address.error;
  }

  #authorize(request: NetworkRequest): AsyncError | undefined {
    return this.#options.authorize?.(request);
  }
}

function ipFamily(family: number): IpFamily | undefined {
  return family === 4 ? 4 : family === 6 ? 6 : undefined;
}
