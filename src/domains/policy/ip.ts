/** IP addresses as Rust's `std::net::IpAddr` parses, compares and prints them. */

export type IpAddr =
  | { readonly v: 4; readonly bytes: Uint8Array }
  | { readonly v: 6; readonly bytes: Uint8Array };

export function ipEquals(a: IpAddr, b: IpAddr): boolean {
  return a.v === b.v && a.bytes.every((byte, i) => byte === b.bytes[i]);
}

function parseV4(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  const out = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    // Rust rejects empty parts, non-digits, leading zeros ("01") and values above 255.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return undefined;
    }
    const n = Number(part);
    if (n > 255) {
      return undefined;
    }
    out[i] = n;
  }
  return out;
}

function parseV6(text: string): Uint8Array | undefined {
  if (!text.includes(':')) {
    return undefined;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parseGroups = (s: string, allowV4Tail: boolean): number[] | undefined => {
    if (s === '') {
      return [];
    }
    const groups: number[] = [];
    const parts = s.split(':');
    for (const [i, part] of parts.entries()) {
      if (allowV4Tail && i === parts.length - 1 && part.includes('.')) {
        const v4 = parseV4(part);
        if (v4 === undefined) {
          return undefined;
        }
        groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else if (/^[0-9a-fA-F]{1,4}$/.test(part)) {
        groups.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return groups;
  };
  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0] ?? '', false);
    const tail = parseGroups(halves[1] ?? '', true);
    if (head === undefined || tail === undefined || head.length + tail.length > 7) {
      return undefined;
    }
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    const all = parseGroups(text, true);
    if (all === undefined || all.length !== 8) {
      return undefined;
    }
    groups = all;
  }
  const out = new Uint8Array(16);
  for (const [i, g] of groups.entries()) {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  }
  return out;
}

/** `str::parse::<IpAddr>()`; `undefined` when Rust would reject it. */
export function parseIp(text: string): IpAddr | undefined {
  const v4 = parseV4(text);
  if (v4 !== undefined) {
    return { v: 4, bytes: v4 };
  }
  const v6 = parseV6(text);
  return v6 === undefined ? undefined : { v: 6, bytes: v6 };
}

function formatV4(bytes: Uint8Array): string {
  return Array.from(bytes).join('.');
}

/** Rust `Display` for `IpAddr` (RFC 5952 compression, `::ffff:a.b.c.d` for mapped IPv4). */
export function formatIp(ip: IpAddr): string {
  if (ip.v === 4) {
    return formatV4(ip.bytes);
  }
  const g: number[] = [];
  for (let i = 0; i < 8; i++) {
    g.push(((ip.bytes[i * 2] ?? 0) << 8) | (ip.bytes[i * 2 + 1] ?? 0));
  }
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `::ffff:${formatV4(ip.bytes.subarray(12))}`;
  }
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) {
      j++;
    }
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (x: number): string => x.toString(16);
  if (bestLen < 2) {
    return g.map(hex).join(':');
  }
  const head = g.slice(0, bestStart).map(hex).join(':');
  const tail = g
    .slice(bestStart + bestLen)
    .map(hex)
    .join(':');
  return `${head}::${tail}`;
}

export interface SocketAddr {
  readonly ip: IpAddr;
  readonly port: number;
}

/** Rust `SocketAddr` shape used in denial messages: `1.2.3.4:80` or `[::1]:80`. */
export function formatSocketAddr(addr: SocketAddr): string {
  return addr.ip.v === 4
    ? `${formatIp(addr.ip)}:${addr.port}`
    : `[${formatIp(addr.ip)}]:${addr.port}`;
}
