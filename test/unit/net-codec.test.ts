import { describe, expect, it } from 'vitest';
import {
  AF_INET,
  AF_INET6,
  addrinfoAddresses,
  decodeSockaddr,
  EAI_NUMBERS,
  encodeSockaddr,
  gaiStrerror,
  initIpv4,
  initIpv6,
  ipv4Ip,
  ipv4Port,
  ipv6ScopeId,
  isIpv6,
  isIpv6Wildcard,
  isMulticast,
  SIN6_ADDR_OFFSET,
  sockaddrLength,
  withPort,
} from '../../src/kernel/net-codec.ts';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('sockaddr layouts', () => {
  it('encodes sockaddr_in as Linux does', () => {
    const addr = initIpv4(0x7f000001, 0x1234);
    expect([...addr]).toEqual([AF_INET, 0, 0x12, 0x34, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv4Ip(addr)).toEqual({ ok: true, value: 0x7f000001 });
    expect(ipv4Port(addr)).toEqual({ ok: true, value: 0x1234 });
    expect(isIpv6(addr)).toEqual({ ok: true, value: false });
  });

  it('truncates the port to 16 bits like `(port as u16).to_be()`', () => {
    expect(ipv4Port(initIpv4(0, 0x1_0050))).toEqual({ ok: true, value: 0x50 });
  });

  it('encodes sockaddr_in6 with the address at offset 8 and a host-order scope id', () => {
    const ip = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const addr = initIpv6(ip, 443, 7);
    expect(addr.length).toBe(28);
    expect([...addr.subarray(0, 8)]).toEqual([AF_INET6, 0, 1, 187, 0, 0, 0, 0]);
    expect([...addr.subarray(SIN6_ADDR_OFFSET, SIN6_ADDR_OFFSET + 16)]).toEqual([...ip]);
    expect([...addr.subarray(24)]).toEqual([7, 0, 0, 0]);
    expect(ipv6ScopeId(addr)).toEqual({ ok: true, value: 7 });
    expect(isIpv6Wildcard(addr)).toEqual({ ok: true, value: false });
    expect(isIpv6Wildcard(initIpv6(new Uint8Array(16), 0, 0))).toEqual({ ok: true, value: true });
  });

  it('round-trips decode and encode', () => {
    const v6 = initIpv6(Uint8Array.of(0xfe, 0x80, ...new Uint8Array(13), 1), 80, 2);
    const decoded = decodeSockaddr(v6);
    expect(decoded.ok && [...encodeSockaddr(decoded.value)]).toEqual([...v6]);
  });

  it('reports short buffers as Fault and unknown families as Inval (sockaddr_len)', () => {
    expect(sockaddrLength(new Uint8Array(15))).toEqual({ ok: false, error: { kind: 'fault' } });
    const unix = new Uint8Array(16);
    unix[0] = 1;
    expect(sockaddrLength(unix)).toEqual({ ok: false, error: { kind: 'inval' } });
    const short6 = initIpv6(new Uint8Array(16), 0, 0).subarray(0, 20);
    expect(decodeSockaddr(short6)).toEqual({ ok: false, error: { kind: 'fault' } });
    expect(ipv6ScopeId(initIpv4(0, 0))).toEqual({ ok: false, error: { kind: 'fault' } });
  });

  it('classifies multicast addresses of both families', () => {
    expect(isMulticast(initIpv4(0xef000001, 0))).toEqual({ ok: true, value: true });
    expect(isMulticast(initIpv4(0xf0000001, 0))).toEqual({ ok: true, value: false });
    expect(isMulticast(initIpv6(Uint8Array.of(0xff, 2, ...new Uint8Array(14)), 0, 0))).toEqual({
      ok: true,
      value: true,
    });
    const other = new Uint8Array(16);
    other[0] = 1;
    expect(isMulticast(other)).toEqual({ ok: true, value: false });
  });

  it('fills a stored address with a port (addrinfo_fill_addr)', () => {
    const filled = withPort(initIpv4(0x01020304, 0), 8080);
    expect(filled.ok && ipv4Port(filled.value)).toEqual({ ok: true, value: 8080 });
  });
});

describe('getaddrinfo results', () => {
  it('repeats every address once per socket type, with port 0', () => {
    const list = addrinfoAddresses([
      { family: 6, ip: Uint8Array.of(...new Uint8Array(15), 1), scopeId: 0 },
      { family: 4, ip: Uint8Array.of(127, 0, 0, 1), scopeId: 0 },
    ]);
    expect(list.map((a) => a.length)).toEqual([28, 28, 28, 16, 16, 16]);
    expect(list[3]).toEqual(initIpv4(0x7f000001, 0));
    expect(list[4]).not.toBe(list[3]);
  });

  it('uses glibc numbers and texts', () => {
    expect(EAI_NUMBERS.EAI_NONAME).toBe(-2);
    expect(EAI_NUMBERS.EAI_AGAIN).toBe(-3);
    expect(text(gaiStrerror(-2))).toBe('Name or service not known\0');
    expect(text(gaiStrerror(-5))).toBe('No address associated with hostname\0');
    expect(text(gaiStrerror(0))).toBe('Success\0');
    expect(text(gaiStrerror(-13))).toBe('Unknown error\0');
    expect(text(gaiStrerror(-101))).toBe('Request canceled\0');
  });
});
