import { type AsyncError, FAULT } from '../../kernel/errors.ts';
import { NULL_HANDLE } from '../../kernel/handles.ts';
import {
  gaiStrerror,
  initIpv4,
  initIpv6,
  ipv4Ip,
  ipv4Port,
  ipv6ScopeId,
  isIpv6,
  isIpv6Wildcard,
  isMulticast,
  readIn,
  readIn6,
  SIN6_ADDR_OFFSET,
  SOCKADDR_IN_SIZE,
  SOCKADDR_IN6_SIZE,
  withPort,
} from '../../kernel/net-codec.ts';
import type { Eventually } from '../../kernel/socket.ts';
import { err, ok, type Result } from '../../ports/result.ts';
import { errnoOf } from '../errno.ts';
import { GuestFault } from '../memory.ts';
import {
  type AsyncEnv,
  AsyncFailure,
  bool,
  fail,
  handle,
  status,
  unwrap,
  zeroOrMinusOne,
} from './env.ts';
import { readGuestPath } from './fs.ts';
import { checkedAdd } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** An address family argument of the multicast option imports (4 or 6). */
function familyArg(family: number): Result<4 | 6, AsyncError> {
  return family === 4 || family === 6 ? ok(family) : err({ kind: 'inval' });
}

/**
 * `socket/*` and the network Jobs (moonrun `async_api::socket` and the network part
 * of `async_api::thread_pool`). Addresses are Linux `sockaddr_in`/`sockaddr_in6`
 * bytes in guest memory; the kernel decodes them with `net-codec`.
 */
export function sockets(env: AsyncEnv) {
  const { kernel, memory } = env;
  const net = kernel.network;
  /** `memory.read_exact(ptr, len).to_vec()`. */
  const bytes = (ptr: number, len: number): Uint8Array => memory.copyOut(ptr, len);
  /** The value a decoding helper returns; a failure is the import's host error. */
  const value = <T>(result: Result<T, AsyncError>): T => unwrap(result);
  /** `-1`/errno for an operation that may finish later (the import then suspends). */
  const eventually = (operation: () => Eventually<number>): number | Promise<number> => {
    let pending: Promise<Result<number, AsyncError>> | undefined;
    const now = status(env, () => {
      const r = operation();
      if (r instanceof Promise) {
        pending = r;
        return ok(0);
      }
      return r;
    });
    if (pending === undefined) {
      return now;
    }
    return pending.then((r) => (r.ok ? r.value : fail(env, r.error)));
  };
  /** moonrun `record_error` plus the import's sentinel (the invalid fd, the null handle). */
  const recorded = <T>(error: AsyncError, sentinel: T): T => {
    fail(env, error);
    return sentinel;
  };
  const zero = (r: Eventually<void>): Eventually<number> =>
    r instanceof Promise ? r.then((v) => (v.ok ? ok(0) : v)) : r.ok ? ok(0) : r;
  return {
    'socket/ipv4_addr_size': () => SOCKADDR_IN_SIZE,
    'socket/ipv6_addr_size': () => SOCKADDR_IN6_SIZE,
    'socket/init_ip_addr': (addr, ip, port) => {
      memory.view(addr, SOCKADDR_IN_SIZE);
      memory.write(addr, initIpv4(ip, port));
    },
    'socket/init_ipv6_addr': (addr, ip, port, scopeId) => {
      const raw = bytes(ip, 16);
      memory.view(addr, SOCKADDR_IN6_SIZE);
      memory.write(addr, initIpv6(raw, port, scopeId));
    },
    'socket/gai_strerror': (code) => kernel.cBuffers.insert(gaiStrerror(code)),
    'socket/ip_addr_get_ip': (addr, len) => value(ipv4Ip(memory.view(addr, len))),
    'socket/ip_addr_get_port': (addr, len) => value(ipv4Port(memory.view(addr, len))),
    'socket/addr_is_ipv6': (addr, len) => (value(isIpv6(memory.view(addr, len))) ? 1 : 0),
    'socket/addr_is_multicast': (addr, len) => (value(isMulticast(memory.view(addr, len))) ? 1 : 0),
    'socket/addr_get_ipv6_bytes_offset': () => SIN6_ADDR_OFFSET,
    'socket/addr_copy_ipv6_bytes': (addr, out, addrLen, len) => {
      const ip = memory.view(addr, addrLen).slice(SIN6_ADDR_OFFSET, SIN6_ADDR_OFFSET + 16);
      if (ip.length < 16 || len < 16) {
        throw new AsyncFailure(FAULT);
      }
      memory.view(out, len).set(ip);
    },
    'socket/addr_get_ipv6_scope_id': (addr, len) => value(ipv6ScopeId(memory.view(addr, len))),
    'socket/addr_is_ipv6_wildcard': (addr, len) =>
      value(isIpv6Wildcard(memory.view(addr, len))) ? 1 : 0,
    'socket/addrinfo_is_null': (ai) => (handle(ai) === NULL_HANDLE ? 1 : 0),
    'socket/addrinfo_get_next': (ai) => unwrap(net.addrinfoNext(handle(ai))),
    'socket/addrinfo_addr_size': (ai) =>
      handle(ai) === NULL_HANDLE ? 0 : unwrap(net.addrinfoAddr(handle(ai))).length,
    'socket/addrinfo_fill_addr': (ai, out, port, outLen) => {
      if (handle(ai) === NULL_HANDLE) {
        return;
      }
      const stored = unwrap(net.addrinfoAddr(handle(ai)));
      const target = memory.view(out, outLen);
      const filled = value(withPort(stored, port));
      if (filled.length > target.length) {
        throw new AsyncFailure(FAULT);
      }
      target.set(filled);
    },
    'socket/addrinfo_free': (ai) => unwrap(net.addrinfoFree(handle(ai))),
    'socket/make_tcp_socket': (family) => {
      const r = net.makeTcpSocket(family);
      return r.ok ? r.value : recorded(r.error, kernel.resources.invalidHandle);
    },
    'socket/make_udp_socket': (family, multicast) => {
      const r = net.makeUdpSocket(family, bool(multicast));
      return r.ok ? r.value : recorded(r.error, kernel.resources.invalidHandle);
    },
    'socket/join_multicast_group': (fd, multi, local, multiLen, localLen) =>
      zeroOrMinusOne(env, () => {
        const group = readIn(bytes(multi, multiLen));
        const iface = readIn(bytes(local, localLen));
        const socket = net.udp(handle(fd));
        if (!socket.ok) {
          return socket;
        }
        if (!group.ok) {
          return group;
        }
        if (!iface.ok) {
          return iface;
        }
        return socket.value.setOption({
          kind: 'add-membership',
          group: group.value,
          local: iface.value,
        });
      }),
    'socket/join_multicast_group_v6': (fd, multi, index, multiLen) =>
      zeroOrMinusOne(env, () => {
        const raw = bytes(multi, multiLen);
        const socket = net.udp(handle(fd));
        if (!socket.ok) {
          return socket;
        }
        const group = readIn6(raw);
        if (!group.ok) {
          return group;
        }
        const local = { ...group.value, ip: new Uint8Array(16), port: 0, scopeId: index };
        return socket.value.setOption({ kind: 'add-membership', group: group.value, local });
      }),
    'socket/set_multicast_interface': (fd, local, localLen) =>
      zeroOrMinusOne(env, () => {
        const raw = bytes(local, localLen);
        const socket = net.udp(handle(fd));
        if (!socket.ok) {
          return socket;
        }
        const address = readIn(raw);
        return address.ok
          ? socket.value.setOption({ kind: 'multicast-interface', address: address.value })
          : address;
      }),
    'socket/set_multicast_interface_v6': (fd, index) =>
      zeroOrMinusOne(env, () => {
        const socket = net.udp(handle(fd));
        if (!socket.ok) {
          return socket;
        }
        return socket.value.setOption({
          kind: 'multicast-interface',
          address: { family: 6, ip: new Uint8Array(16), port: 0, flowInfo: 0, scopeId: index },
        });
      }),
    'socket/set_multicast_ttl': (fd, ttl, family) =>
      zeroOrMinusOne(env, () => {
        const socket = net.udp(handle(fd));
        if (!socket.ok) {
          return socket;
        }
        const f = familyArg(family);
        if (!f.ok) {
          return f;
        }
        // Linux: -1 restores the default of 1; the range is 0..255.
        if (ttl < -1 || ttl > 255) {
          return err({ kind: 'inval' });
        }
        return socket.value.setOption({ kind: 'multicast-ttl', ttl: ttl === -1 ? 1 : ttl });
      }),
    'socket/set_multicast_loopback': (fd, enable, family) =>
      zeroOrMinusOne(env, () => {
        const socket = net.udp(handle(fd));
        if (!socket.ok) {
          return socket;
        }
        const f = familyArg(family);
        return f.ok
          ? socket.value.setOption({ kind: 'multicast-loopback', enabled: bool(enable) })
          : f;
      }),
    'socket/disable_nagle': (fd) =>
      zeroOrMinusOne(env, () => {
        const socket = net.tcp(handle(fd));
        return socket.ok ? socket.value.setNoDelay() : socket;
      }),
    'socket/allow_reuse_addr': (fd) =>
      zeroOrMinusOne(env, () => {
        const socket = net.socket(handle(fd));
        return socket.ok ? socket.value.allowReuseAddr() : socket;
      }),
    'socket/allow_reuse_port': (fd) =>
      zeroOrMinusOne(env, () => {
        const socket = net.socket(handle(fd));
        return socket.ok ? socket.value.allowReusePort() : socket;
      }),
    'socket/set_ipv6_only': (fd, ipv6Only) =>
      zeroOrMinusOne(env, () => {
        const socket = net.socket(handle(fd));
        return socket.ok ? socket.value.setIpv6Only(bool(ipv6Only)) : socket;
      }),
    'socket/listen': {
      suspends: true,
      impl: (fd) => eventually(() => zero(net.listen(handle(fd)))),
    },
    'socket/enable_keepalive': (fd, idle, count, interval) =>
      zeroOrMinusOne(env, () => {
        const socket = net.tcp(handle(fd));
        return socket.ok ? socket.value.enableKeepAlive(idle, count, interval) : socket;
      }),
    'socket/getsockname': (fd, addr, len) =>
      zeroOrMinusOne(env, () => net.getsockname(handle(fd), memory.view(addr, len))),
    'socket/if_nametoindex': (name, len) => {
      try {
        const r = net.ifNameToIndex(readGuestPath(memory, name, len));
        if (r.ok) {
          return r.value;
        }
        fail(env, r.error);
        return 0;
      } catch (e) {
        if (e instanceof AsyncFailure) {
          fail(env, e.error);
          return 0;
        }
        if (e instanceof GuestFault) {
          fail(env, FAULT);
          return 0;
        }
        throw e;
      }
    },
    'socket/if_indextoname': (index) => {
      const r = net.ifIndexToName(index);
      return r.ok ? r.value : recorded(r.error, NULL_HANDLE);
    },
    'socket/find_ipv6_test_interface': () => net.ipv6TestInterface(),
    'socket/udp_client_connect': {
      suspends: true,
      impl: (fd, addr, len) => eventually(() => zero(net.connectUdp(handle(fd), bytes(addr, len)))),
    },
    'socket/bind': {
      suspends: true,
      impl: (fd, addr, len) => eventually(() => zero(net.bind(handle(fd), bytes(addr, len)))),
    },
    'socket/recvfrom/unix': (fd, buf, offset, len, addr, addrLen) =>
      status(env, () => {
        const at = checkedAdd(buf, offset);
        memory.view(at, len);
        const data = new Uint8Array(len);
        const source = bytes(addr, addrLen);
        const n = net.recvFrom(handle(fd), data, source);
        if (!n.ok) {
          return n;
        }
        memory.write(at, data.subarray(0, n.value));
        memory.write(addr, source);
        return n;
      }),
    'socket/sendto/unix': {
      suspends: true,
      impl: (fd, buf, offset, len, addr, addrLen) =>
        eventually(() => {
          const data = bytes(checkedAdd(buf, offset), len);
          return net.sendTo(handle(fd), data, bytes(addr, addrLen));
        }),
    },
    'socket/connect/unix': (fd, addr, len) =>
      zeroOrMinusOne(env, () => net.connectTcp(handle(fd), bytes(addr, len))),
    'socket/getsockerr/unix': (fd) =>
      status(env, () => {
        const r = net.takeSocketError(handle(fd));
        return r.ok ? ok(r.value === undefined ? 0 : errnoOf(r.value)) : r;
      }),
    'socket/accept/unix': (fd, addr, len) => {
      const r = ((): Result<bigint, AsyncError> => {
        try {
          return net.accept(handle(fd), memory.view(addr, len));
        } catch (e) {
          if (e instanceof GuestFault) {
            return err(FAULT);
          }
          throw e;
        }
      })();
      return r.ok ? r.value : recorded(r.error, kernel.resources.invalidHandle);
    },
    'thread_pool/make_bind_job': (socket, addr, len) =>
      unwrap(net.makeBindJob(handle(socket), () => bytes(addr, len))),
    'thread_pool/make_getaddrinfo_job': (host, len) =>
      net.makeGetaddrinfoJob(readGuestPath(memory, host, len)),
    'thread_pool/get_getaddrinfo_result': (job) => unwrap(net.getaddrinfoResult(handle(job))),
  } satisfies HandlerGroup;
}
