import dgram from 'node:dgram';
import dns from 'node:dns';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
// Deno drops dgram's nextTick callbacks until node:process is bootstrapped.
import 'node:process';
import { formatIp, parseIp } from '../../domains/policy/ip.ts';
import type {
  ByteStream,
  DatagramEvents,
  DatagramOption,
  DatagramSocket,
  DnsPort,
  EaiCode,
  IpFamily,
  LookupError,
  NetInterface,
  NetPort,
  ResolvedIp,
  SocketAddress,
  StreamEvents,
} from '../../ports/net.ts';
import { err, type HostError, type HostErrorCode, ok, type Result } from '../../ports/result.ts';

/** A Node error's `code` as a host error (unknown codes surface as `EIO` in the ABI). */
function hostErrorOf(e: unknown): HostError {
  const code =
    typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
      ? e.code
      : 'EIO';
  return { code: code as HostErrorCode };
}

// ----- interfaces -----

const IFF_UP = 0x1;
const IFF_LOOPBACK = 0x8;
const IFF_MULTICAST = 0x1000;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readInt(path: string): number | undefined {
  const text = readText(path);
  const n =
    text === undefined ? Number.NaN : Number.parseInt(text, path.endsWith('flags') ? 16 : 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Interfaces with Linux indices and flags from `/sys/class/net` (what `if_nametoindex`
 * and `getifaddrs` read), addresses from `os.networkInterfaces()`. Elsewhere the
 * index comes from link-local scope ids and every listed interface counts as up.
 */
function listInterfaces(): NetInterface[] {
  const addresses = networkInterfaces();
  const byName = new Map<string, NetInterface>();
  let names: string[] = [];
  try {
    names = readdirSync('/sys/class/net');
  } catch {
    names = [];
  }
  for (const name of names) {
    const index = readInt(`/sys/class/net/${name}/ifindex`);
    const flags = readInt(`/sys/class/net/${name}/flags`) ?? 0;
    if (index === undefined) {
      continue;
    }
    // `flags` is `dev->flags`; getifaddrs adds IFF_RUNNING from the operational state.
    const operstate = readText(`/sys/class/net/${name}/operstate`);
    const running = (flags & IFF_UP) !== 0 && (operstate === 'up' || operstate === 'unknown');
    byName.set(name, {
      name,
      index,
      up: (flags & IFF_UP) !== 0,
      running,
      loopback: (flags & IFF_LOOPBACK) !== 0,
      multicast: (flags & IFF_MULTICAST) !== 0,
      addresses: [],
    });
  }
  for (const [name, infos] of Object.entries(addresses)) {
    const parsed = (infos ?? []).flatMap((info) => {
      const a = parseAddress(info.address, 0);
      return a === undefined ? [] : [{ ...a, scopeId: info.scopeid ?? 0 }];
    });
    const known = byName.get(name);
    if (known !== undefined) {
      byName.set(name, { ...known, addresses: parsed });
      continue;
    }
    const index = (infos ?? []).find((i) => (i.scopeid ?? 0) > 0)?.scopeid;
    if (index === undefined) {
      continue;
    }
    const internal = (infos ?? []).some((i) => i.internal);
    byName.set(name, {
      name,
      index,
      up: true,
      running: true,
      loopback: internal,
      multicast: !internal,
      addresses: parsed,
    });
  }
  return [...byName.values()].sort((a, b) => a.index - b.index);
}

// ----- addresses -----

/** A textual IP (optionally with a `%scope` suffix) as a socket address. */
function parseAddress(
  text: string,
  port: number,
  interfaces?: () => NetInterface[],
): SocketAddress | undefined {
  const percent = text.indexOf('%');
  const ipText = percent < 0 ? text : text.slice(0, percent);
  const ip = parseIp(ipText);
  if (ip === undefined) {
    return undefined;
  }
  let scopeId = 0;
  if (percent >= 0 && ip.v === 6) {
    const scope = text.slice(percent + 1);
    scopeId = /^[0-9]+$/.test(scope)
      ? Number(scope)
      : ((interfaces?.() ?? listInterfaces()).find((i) => i.name === scope)?.index ?? 0);
  }
  return { family: ip.v, ip: ip.bytes, port, flowInfo: 0, scopeId };
}

/** An address as Node expects it: IPv6 scopes are interface names (libuv `uv_ip6_addr`). */
function addressText(address: SocketAddress): string {
  const text = formatIp({ v: address.family, bytes: address.ip });
  if (address.family !== 6 || address.scopeId === 0) {
    return text;
  }
  const name = listInterfaces().find((i) => i.index === address.scopeId)?.name;
  return `${text}%${name ?? address.scopeId}`;
}

function bytesOf(chunk: Buffer): Uint8Array {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

// ----- TCP -----

function wireStream(socket: net.Socket, events: StreamEvents): void {
  socket.on('connect', () => events.connected());
  socket.on('data', (chunk: Buffer) => events.data(bytesOf(chunk)));
  socket.on('end', () => events.end());
  socket.on('drain', () => events.drain());
  socket.on('error', (e) => events.error(hostErrorOf(e)));
}

function byteStream(socket: net.Socket): ByteStream {
  // Node reports IPv4-mapped peers of dual-stack sockets as IPv6 text, as Linux does.
  const local = (): SocketAddress | undefined =>
    socket.localAddress === undefined
      ? undefined
      : parseAddress(socket.localAddress, socket.localPort ?? 0);
  const remote = (): SocketAddress | undefined =>
    socket.remoteAddress === undefined
      ? undefined
      : parseAddress(socket.remoteAddress, socket.remotePort ?? 0);
  return {
    write: (data) => socket.write(data),
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    close: (mode) => {
      if (socket.destroyed) {
        return;
      }
      if (mode === 'reset' || socket.connecting) {
        if (typeof socket.resetAndDestroy === 'function' && !socket.connecting) {
          socket.resetAndDestroy();
        } else {
          socket.destroy();
        }
        return;
      }
      // close(2): the kernel flushes queued data, sends FIN and forgets the descriptor.
      socket.end(() => socket.destroy());
    },
    localAddress: local,
    remoteAddress: remote,
    setNoDelay: (enabled) => {
      socket.setNoDelay(enabled);
    },
    setKeepAlive: (enabled, idleSeconds) => {
      socket.setKeepAlive(enabled, idleSeconds * 1000);
    },
  };
}

// ----- UDP -----

type LookupCallback = (error: Error | null, address: string, family: number) => void;

/**
 * Addresses are always literals. dgram resolves even those on a later tick, which
 * would let a later `setsockopt` overtake a send; sends therefore resolve at once,
 * while bind and connect stay asynchronous (events never fire re-entrantly).
 */
function literalLookup(immediate: () => boolean) {
  return (address: string, f: number | object, callback: LookupCallback): void => {
    const family = typeof f === 'number' ? f : address.includes(':') ? 6 : 4;
    if (immediate()) {
      callback(null, address, family);
    } else {
      queueMicrotask(() => callback(null, address, family));
    }
  };
}

function datagramSocket(
  f: IpFamily,
  options: { reuseAddr: boolean; reusePort: boolean; ipv6Only: boolean },
  events: DatagramEvents,
): DatagramSocket {
  let sending = false;
  const socket = dgram.createSocket({
    type: f === 4 ? 'udp4' : 'udp6',
    reuseAddr: options.reuseAddr,
    ...(options.reusePort ? { reusePort: true } : {}),
    ipv6Only: options.ipv6Only,
    lookup: literalLookup(() => sending) as never,
  });
  let closed = false;
  let pendingSends = 0;
  const close = (): void => {
    try {
      socket.close();
    } catch {
      // A socket which has never bound has no host handle.
    }
  };
  socket.on('listening', () => events.listening());
  socket.on('connect', () => events.connected());
  socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const from = parseAddress(rinfo.address, rinfo.port);
    if (from !== undefined) {
      events.message(bytesOf(msg), from);
    }
  });
  socket.on('error', (e) => {
    if (!closed) {
      events.error(hostErrorOf(e));
    }
  });
  const sent = (error: Error | null): void => {
    pendingSends--;
    if (error !== null && !closed) {
      events.error(hostErrorOf(error));
    }
    if (closed && pendingSends === 0) close();
  };
  const attempt = (f: () => void): Result<void, HostError> => {
    try {
      f();
      return ok(undefined);
    } catch (e) {
      return err(hostErrorOf(e));
    }
  };
  const interfaceText = (address: SocketAddress): string | undefined => {
    if (address.family === 4) {
      return formatIp({ v: 4, bytes: address.ip });
    }
    if (address.scopeId === 0) {
      return undefined;
    }
    const name = listInterfaces().find((i) => i.index === address.scopeId)?.name;
    return name === undefined ? undefined : `::%${name}`;
  };
  const setOption = (option: DatagramOption): Result<void, HostError> => {
    switch (option.kind) {
      case 'multicast-ttl':
        return attempt(() => socket.setMulticastTTL(option.ttl));
      case 'multicast-loopback':
        return attempt(() => socket.setMulticastLoopback(option.enabled));
      case 'multicast-interface': {
        const text = interfaceText(option.address) ?? '::';
        if (option.address.family === 6 && option.address.scopeId !== 0 && text === '::') {
          return err({ code: 'ENODEV' });
        }
        return attempt(() => socket.setMulticastInterface(text));
      }
      case 'add-membership': {
        const group = formatIp({ v: option.group.family, bytes: option.group.ip });
        const local = interfaceText(option.local);
        if (option.local.family === 6 && option.local.scopeId !== 0 && local === undefined) {
          return err({ code: 'ENODEV' });
        }
        return attempt(() =>
          local === undefined ? socket.addMembership(group) : socket.addMembership(group, local),
        );
      }
    }
  };
  return {
    bind: (local) => {
      socket.bind({ address: addressText(local), port: local.port, exclusive: true });
    },
    connect: (remote) => {
      socket.connect(remote.port, addressText(remote));
    },
    disconnect: () => {
      try {
        socket.disconnect();
      } catch {
        // Not connected.
      }
    },
    send: (data, to) => {
      pendingSends++;
      sending = true;
      try {
        if (to === undefined) {
          socket.send(data, sent);
        } else {
          socket.send(data, to.port, addressText(to), sent);
        }
      } catch (e) {
        const error = e as Error;
        queueMicrotask(() => sent(error));
      } finally {
        sending = false;
      }
    },
    setOption,
    localAddress: () => {
      try {
        const a = socket.address();
        return parseAddress(a.address, a.port);
      } catch {
        return undefined;
      }
    },
    close: () => {
      if (!closed) {
        closed = true;
        // close(2) preserves accepted datagrams; Deno otherwise drops queued sends.
        if (pendingSends === 0) close();
      }
    },
  };
}

// ----- the ports -----

/** `NetPort` over `node:net` and `node:dgram` (also used on Deno and Bun). */
export function nodeNet(): NetPort {
  return {
    connect: (options, events) => {
      const socket = new net.Socket({ allowHalfOpen: true });
      wireStream(socket, events);
      // Both are applied by Node once the handle exists.
      socket.setNoDelay(options.noDelay);
      if (options.keepAliveSeconds !== undefined) {
        socket.setKeepAlive(true, options.keepAliveSeconds * 1000);
      }
      socket.connect({
        host: addressText(options.remote),
        port: options.remote.port,
        family: options.remote.family,
      });
      return byteStream(socket);
    },
    listen: (options, events) => {
      const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
      server.on('listening', () => events.listening());
      server.on('error', (e) => events.error(hostErrorOf(e)));
      server.on('connection', (socket: net.Socket) => {
        const sink = events.connection(byteStream(socket));
        wireStream(socket, sink);
      });
      server.listen({
        host: addressText(options.local),
        port: options.local.port,
        ipv6Only: options.ipv6Only,
        ...(options.reusePort ? { reusePort: true } : {}),
        exclusive: true,
        backlog: 4096,
      });
      return {
        localAddress: () => {
          const a = server.address();
          return a === null || typeof a === 'string' ? undefined : parseAddress(a.address, a.port);
        },
        close: () => {
          server.close();
        },
      };
    },
    datagram: datagramSocket,
    interfaces: listInterfaces,
  };
}

/** libuv's `UV_EAI_*` numbers, as Node reports them in `errno`. */
const UV_EAI: ReadonlyMap<number, EaiCode> = new Map([
  [-3000, 'EAI_ADDRFAMILY'],
  [-3001, 'EAI_AGAIN'],
  [-3002, 'EAI_BADFLAGS'],
  [-3004, 'EAI_FAIL'],
  [-3005, 'EAI_FAMILY'],
  [-3006, 'EAI_MEMORY'],
  [-3007, 'EAI_NODATA'],
  [-3008, 'EAI_NONAME'],
  [-3009, 'EAI_OVERFLOW'],
  [-3010, 'EAI_SERVICE'],
  [-3011, 'EAI_SOCKTYPE'],
]);

/** Error codes as Node names them (`ENOTFOUND` covers both NONAME and NODATA). */
const EAI_BY_CODE: ReadonlyMap<string, EaiCode> = new Map([
  ['ENOTFOUND', 'EAI_NONAME'],
  ['ENODATA', 'EAI_NODATA'],
  ['EAI_AGAIN', 'EAI_AGAIN'],
  ['EAI_FAIL', 'EAI_FAIL'],
  ['EAI_NODATA', 'EAI_NODATA'],
  ['EAI_NONAME', 'EAI_NONAME'],
  ['EAI_FAMILY', 'EAI_FAMILY'],
  ['EAI_BADFLAGS', 'EAI_BADFLAGS'],
  ['EAI_SERVICE', 'EAI_SERVICE'],
  ['EAI_SOCKTYPE', 'EAI_SOCKTYPE'],
  ['EAI_ADDRFAMILY', 'EAI_ADDRFAMILY'],
  ['EAI_MEMORY', 'EAI_MEMORY'],
  ['EAI_OVERFLOW', 'EAI_OVERFLOW'],
]);

function lookupError(e: unknown): LookupError {
  const errno = typeof e === 'object' && e !== null && 'errno' in e ? e.errno : undefined;
  const fromErrno = typeof errno === 'number' ? UV_EAI.get(errno) : undefined;
  if (fromErrno !== undefined) {
    return { kind: 'eai', code: fromErrno };
  }
  const error = hostErrorOf(e);
  const fromCode = EAI_BY_CODE.get(error.code);
  return fromCode === undefined ? { kind: 'system', error } : { kind: 'eai', code: fromCode };
}

/** `DnsPort` over `dns.lookup` (the system resolver, i.e. `getaddrinfo`). */
export function nodeDns(): DnsPort {
  return {
    lookup: (host) =>
      new Promise<Result<readonly ResolvedIp[], LookupError>>((resolve) => {
        dns.lookup(
          host,
          { all: true, order: 'verbatim', hints: dns.ADDRCONFIG, family: 0 },
          (e, addresses) => {
            if (e !== null) {
              resolve(err(lookupError(e)));
              return;
            }
            const ips = addresses.flatMap((a) => {
              const parsed = parseAddress(a.address, 0);
              return parsed === undefined
                ? []
                : [{ family: parsed.family, ip: parsed.ip, scopeId: parsed.scopeId }];
            });
            resolve(ok(ips));
          },
        );
      }),
  };
}
