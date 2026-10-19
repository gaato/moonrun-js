/**
 * Guest-visible network encodings: Linux `sockaddr_in`/`sockaddr_in6` layouts,
 * the `getaddrinfo` result list and glibc's `gai_strerror` texts.
 *
 * Pure functions over bytes with a narrow interface, kept apart from the code
 * doing network I/O so that a reused implementation can replace them.
 */
import type { EaiCode, IpFamily, ResolvedIp, SocketAddress } from '../ports/net.ts';
import { err, ok, type Result } from '../ports/result.ts';
import { type AsyncError, FAULT, INVAL } from './errors.ts';

export const AF_INET = 2;
export const AF_INET6 = 10;
/** `sizeof(struct sockaddr)`: the minimum to read `sa_family`. */
export const SOCKADDR_SIZE = 16;
export const SOCKADDR_IN_SIZE = 16;
export const SOCKADDR_IN6_SIZE = 28;
/** `offsetof(struct sockaddr_in6, sin6_addr)`. */
export const SIN6_ADDR_OFFSET = 8;

/** `sa_family` of a guest address buffer (moonrun `sockaddr_family`). */
export function sockaddrFamily(bytes: Uint8Array): Result<number, AsyncError> {
  if (bytes.length < SOCKADDR_SIZE) {
    return err(FAULT);
  }
  return ok(view(bytes).getUint16(0, true));
}

/** The address length the family implies (moonrun `sockaddr_len`). */
export function sockaddrLength(bytes: Uint8Array): Result<number, AsyncError> {
  const family = sockaddrFamily(bytes);
  if (!family.ok) {
    return family;
  }
  const len =
    family.value === AF_INET
      ? SOCKADDR_IN_SIZE
      : family.value === AF_INET6
        ? SOCKADDR_IN6_SIZE
        : undefined;
  if (len === undefined) {
    return err(INVAL);
  }
  return bytes.length < len ? err(FAULT) : ok(len);
}

/** Decodes an AF_INET/AF_INET6 address, with `sockaddr_len`'s errors. */
export function decodeSockaddr(bytes: Uint8Array): Result<SocketAddress, AsyncError> {
  const len = sockaddrLength(bytes);
  if (!len.ok) {
    return len;
  }
  return ok(len.value === SOCKADDR_IN_SIZE ? decodeIn(bytes) : decodeIn6(bytes));
}

/** The full `sockaddr_in`/`sockaddr_in6` of an address. */
export function encodeSockaddr(address: SocketAddress): Uint8Array {
  if (address.family === 4) {
    const out = new Uint8Array(SOCKADDR_IN_SIZE);
    const v = view(out);
    v.setUint16(0, AF_INET, true);
    v.setUint16(2, address.port & 0xffff, false);
    out.set(address.ip.subarray(0, 4), 4);
    return out;
  }
  const out = new Uint8Array(SOCKADDR_IN6_SIZE);
  const v = view(out);
  v.setUint16(0, AF_INET6, true);
  v.setUint16(2, address.port & 0xffff, false);
  v.setUint32(4, address.flowInfo >>> 0, false);
  out.set(address.ip.subarray(0, 16), SIN6_ADDR_OFFSET);
  v.setUint32(24, address.scopeId >>> 0, true);
  return out;
}

/** `init_ip_addr`: `ip` is the host-order IPv4 address. */
export function initIpv4(ip: number, port: number): Uint8Array {
  const bytes = new Uint8Array(4);
  view(bytes).setUint32(0, ip >>> 0, false);
  return encodeSockaddr({ family: 4, ip: bytes, port, flowInfo: 0, scopeId: 0 });
}

/** `init_ipv6_addr`. */
export function initIpv6(ip: Uint8Array, port: number, scopeId: number): Uint8Array {
  return encodeSockaddr({ family: 6, ip, port, flowInfo: 0, scopeId });
}

/** `read_sockaddr_in`: the address as an IPv4 one regardless of its family. */
export function readIn(bytes: Uint8Array): Result<SocketAddress, AsyncError> {
  return bytes.length < SOCKADDR_IN_SIZE ? err(FAULT) : ok(decodeIn(bytes));
}

/** `read_sockaddr_in6`. */
export function readIn6(bytes: Uint8Array): Result<SocketAddress, AsyncError> {
  return bytes.length < SOCKADDR_IN6_SIZE ? err(FAULT) : ok(decodeIn6(bytes));
}

/** `ip_addr_get_ip`: host-order IPv4 address. */
export function ipv4Ip(bytes: Uint8Array): Result<number, AsyncError> {
  const a = readIn(bytes);
  return a.ok ? ok(view(a.value.ip).getUint32(0, false)) : a;
}

/** `ip_addr_get_port`. */
export function ipv4Port(bytes: Uint8Array): Result<number, AsyncError> {
  const a = readIn(bytes);
  return a.ok ? ok(a.value.port) : a;
}

export function isIpv6(bytes: Uint8Array): Result<boolean, AsyncError> {
  const family = sockaddrFamily(bytes);
  return family.ok ? ok(family.value === AF_INET6) : family;
}

/** `addr_is_multicast`: 224.0.0.0/4 or ff00::/8; other families are not multicast. */
export function isMulticast(bytes: Uint8Array): Result<boolean, AsyncError> {
  const family = sockaddrFamily(bytes);
  if (!family.ok) {
    return family;
  }
  if (family.value === AF_INET) {
    const a = readIn(bytes);
    return a.ok ? ok((a.value.ip[0] ?? 0) >> 4 === 0xe) : a;
  }
  if (family.value === AF_INET6) {
    const a = readIn6(bytes);
    return a.ok ? ok(a.value.ip[0] === 0xff) : a;
  }
  return ok(false);
}

export function ipv6ScopeId(bytes: Uint8Array): Result<number, AsyncError> {
  const a = readIn6(bytes);
  return a.ok ? ok(a.value.scopeId) : a;
}

export function isIpv6Wildcard(bytes: Uint8Array): Result<boolean, AsyncError> {
  const a = readIn6(bytes);
  return a.ok ? ok(a.value.ip.every((b) => b === 0)) : a;
}

/** `addrinfo_fill_addr`: the stored address with `port`, as the struct of its family. */
export function withPort(bytes: Uint8Array, port: number): Result<Uint8Array, AsyncError> {
  const family = sockaddrFamily(bytes);
  if (!family.ok) {
    return family;
  }
  const decoded =
    family.value === AF_INET
      ? readIn(bytes)
      : family.value === AF_INET6
        ? readIn6(bytes)
        : err(INVAL);
  return decoded.ok ? ok(encodeSockaddr({ ...decoded.value, port })) : decoded;
}

/** The family's wildcard address with port 0 (what an unbound socket's `getsockname` reports). */
export function wildcard(family: IpFamily): SocketAddress {
  return { family, ip: new Uint8Array(family === 4 ? 4 : 16), port: 0, flowInfo: 0, scopeId: 0 };
}

/** glibc `<netdb.h>` numbers. */
export const EAI_NUMBERS: Readonly<Record<EaiCode, number>> = {
  EAI_BADFLAGS: -1,
  EAI_NONAME: -2,
  EAI_AGAIN: -3,
  EAI_FAIL: -4,
  EAI_NODATA: -5,
  EAI_FAMILY: -6,
  EAI_SOCKTYPE: -7,
  EAI_SERVICE: -8,
  EAI_ADDRFAMILY: -9,
  EAI_MEMORY: -10,
  EAI_OVERFLOW: -12,
};

/** glibc 2.44 `gai_strerror`. */
const GAI_STRERROR: ReadonlyMap<number, string> = new Map([
  [0, 'Success'],
  [-1, 'Bad value for ai_flags'],
  [-2, 'Name or service not known'],
  [-3, 'Temporary failure in name resolution'],
  [-4, 'Non-recoverable failure in name resolution'],
  [-5, 'No address associated with hostname'],
  [-6, 'ai_family not supported'],
  [-7, 'ai_socktype not supported'],
  [-8, 'Servname not supported for ai_socktype'],
  [-9, 'Address family for hostname not supported'],
  [-10, 'Memory allocation failure'],
  [-11, 'System error'],
  [-12, 'Result too large for supplied buffer'],
  [-100, 'Processing request in progress'],
  [-101, 'Request canceled'],
  [-102, 'Request not canceled'],
  [-103, 'All requests done'],
  [-104, 'Interrupted by a signal'],
  [-105, 'Parameter string not correctly encoded'],
]);

/** `gai_strerror(code)` as a NUL-terminated C string. */
export function gaiStrerror(code: number): Uint8Array {
  const text = GAI_STRERROR.get(code) ?? 'Unknown error';
  const out = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

/**
 * The address list moonrun copies out of `getaddrinfo` (hints: AF_UNSPEC, no socket
 * type): glibc returns each address once per socket type (stream, datagram, raw),
 * consecutively, with port 0.
 */
export function addrinfoAddresses(ips: readonly ResolvedIp[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const ip of ips) {
    const bytes = encodeSockaddr({
      family: ip.family,
      ip: ip.ip,
      port: 0,
      flowInfo: 0,
      scopeId: ip.family === 6 ? ip.scopeId : 0,
    });
    out.push(bytes, bytes.slice(), bytes.slice());
  }
  return out;
}

/** The address an `AF_INET`/`AF_INET6` sockaddr holds, for policy and host calls. */
function decodeIn(bytes: Uint8Array): SocketAddress {
  const v = view(bytes);
  return {
    family: 4,
    ip: bytes.slice(4, 8),
    port: v.getUint16(2, false),
    flowInfo: 0,
    scopeId: 0,
  };
}

function decodeIn6(bytes: Uint8Array): SocketAddress {
  const v = view(bytes);
  return {
    family: 6,
    ip: bytes.slice(SIN6_ADDR_OFFSET, SIN6_ADDR_OFFSET + 16),
    port: v.getUint16(2, false),
    flowInfo: v.getUint32(4, false),
    scopeId: v.getUint32(24, true),
  };
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
