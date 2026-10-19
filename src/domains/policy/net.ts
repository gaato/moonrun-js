import { err, ok, type Result } from '../../ports/result.ts';
import { type PolicyDenied, sandboxDenied } from './denial.ts';
import { formatSocketAddr, type IpAddr, ipEquals, parseIp, type SocketAddr } from './ip.ts';
import { asciiLower, parseU16, rustDebugStr, rustTrim } from './rust-fmt.ts';

export type DnsPattern =
  | { readonly kind: 'any' }
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'subdomain'; readonly suffix: string };

export type SocketHostRule =
  | { readonly kind: 'any' }
  | { readonly kind: 'ip'; readonly ip: IpAddr }
  | { readonly kind: 'name'; readonly pattern: DnsPattern };

export interface SocketRule {
  readonly host: SocketHostRule;
  /** `undefined` is `*`. */
  readonly port: number | undefined;
}

export interface NetPolicy {
  readonly dns: readonly DnsPattern[];
  readonly connect: readonly SocketRule[];
  readonly bind: readonly SocketRule[];
}

export interface NetConfig {
  readonly dns: readonly string[];
  readonly connect: readonly string[];
  readonly bind: readonly string[];
}

/** Rust `normalize_dns_name`: trim, drop all trailing dots, ASCII-lowercase. */
export function normalizeDnsName(name: string): string {
  return asciiLower(rustTrim(name).replace(/\.+$/, ''));
}

/** A setup failure whose text is moonrun's `anyhow` message chain (outermost first). */
export type NetConfigError = readonly string[];

function parseDnsPattern(raw: string): Result<DnsPattern, NetConfigError> {
  const pattern = normalizeDnsName(raw);
  if (pattern === '') {
    return err(['empty DNS policy pattern']);
  }
  if (pattern === '*') {
    return ok({ kind: 'any' });
  }
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return suffix === '' ? err(['empty DNS wildcard suffix']) : ok({ kind: 'subdomain', suffix });
  }
  return ok({ kind: 'exact', name: pattern });
}

function splitHostPort(value: string): Result<[string, string], NetConfigError> {
  const v6Syntax = 'IPv6 socket policy rules must use [addr]:port syntax';
  if (value.startsWith('[')) {
    const rest = value.slice(1);
    const at = rest.indexOf(']:');
    if (at < 0) {
      return err([v6Syntax]);
    }
    const host = rest.slice(0, at);
    if (host === '') {
      return err(['empty socket policy address']);
    }
    return ok([host, rest.slice(at + 2)]);
  }
  const colon = value.lastIndexOf(':');
  if (colon < 0) {
    return err(['socket policy rules must include a port']);
  }
  const host = value.slice(0, colon);
  if (host === '' || host.includes(':')) {
    return err([v6Syntax]);
  }
  return ok([host, value.slice(colon + 1)]);
}

export function parseSocketRule(rule: string): Result<SocketRule, NetConfigError> {
  const split = splitHostPort(rule);
  if (!split.ok) {
    return split;
  }
  const [hostText, portText] = split.value;
  let host: SocketHostRule;
  const ip = hostText === '*' ? undefined : parseIp(hostText);
  if (hostText === '*') {
    host = { kind: 'any' };
  } else if (ip !== undefined) {
    host = { kind: 'ip', ip };
  } else {
    const pattern = parseDnsPattern(hostText);
    if (!pattern.ok) {
      return pattern;
    }
    host = { kind: 'name', pattern: pattern.value };
  }
  let port: number | undefined;
  if (portText !== '*') {
    const parsed = parseU16(portText);
    if (!parsed.ok) {
      return err([`invalid socket policy port ${rustDebugStr(portText)}`, parsed.error]);
    }
    port = parsed.value;
  }
  return ok({ host, port });
}

/** `NetPolicy::from_config`: dns, connect, bind are parsed in that order, then bind is checked. */
export function buildNetPolicy(config: NetConfig): Result<NetPolicy, NetConfigError> {
  const dns: DnsPattern[] = [];
  for (const p of config.dns) {
    const r = parseDnsPattern(p);
    if (!r.ok) {
      return r;
    }
    dns.push(r.value);
  }
  const connect: SocketRule[] = [];
  for (const rule of config.connect) {
    const r = parseSocketRule(rule);
    if (!r.ok) {
      return r;
    }
    connect.push(r.value);
  }
  const bind: SocketRule[] = [];
  for (const rule of config.bind) {
    const r = parseSocketRule(rule);
    if (!r.ok) {
      return r;
    }
    bind.push(r.value);
  }
  if (bind.some((r) => r.host.kind === 'name')) {
    return err(['bind policy rules must use an IP address or *']);
  }
  return ok({ dns, connect, bind });
}

export function dnsMatches(pattern: DnsPattern, host: string): boolean {
  switch (pattern.kind) {
    case 'any':
      return true;
    case 'exact':
      return host === pattern.name;
    case 'subdomain':
      return (
        host.length > pattern.suffix.length &&
        host.endsWith(pattern.suffix) &&
        host[host.length - pattern.suffix.length - 1] === '.'
      );
  }
}

function allowsLookup(rule: SocketRule, host: string): boolean {
  switch (rule.host.kind) {
    case 'any':
      return true;
    case 'ip': {
      const ip = parseIp(host);
      return ip !== undefined && ipEquals(ip, rule.host.ip);
    }
    case 'name':
      return dnsMatches(rule.host.pattern, host);
  }
}

function ruleMatches(rule: SocketRule, addr: SocketAddr): boolean {
  const hostOk =
    rule.host.kind === 'any' || (rule.host.kind === 'ip' && ipEquals(rule.host.ip, addr.ip));
  return hostOk && (rule.port === undefined || rule.port === addr.port);
}

/**
 * Network decisions for one run. The list of connect rules learned from DNS answers lives here
 * (moonrun keeps it in `HostNetwork`): a hostname connect rule authorizes the addresses that the
 * guest actually resolved for that hostname, for the rest of the run.
 */
export class NetAuthority {
  readonly #resolved: SocketRule[] = [];

  private readonly policy: NetPolicy | undefined;
  constructor(policy: NetPolicy | undefined) {
    this.policy = policy;
  }

  /** `check_dns`: a dns pattern, or any connect rule naming the host, allows the lookup. */
  authorizeDns(host: string): Result<void, PolicyDenied> {
    const { policy } = this;
    if (policy === undefined) {
      return ok(undefined);
    }
    const name = normalizeDnsName(host);
    if (
      policy.dns.some((p) => dnsMatches(p, name)) ||
      policy.connect.some((r) => allowsLookup(r, name))
    ) {
      return ok(undefined);
    }
    return sandboxDenied('DNS lookup', rustDebugStr(host));
  }

  /**
   * `resolved_connect_rules`, called when the guest fetches a `getaddrinfo` result. Only
   * hostname rules are extended; a rule keeps its port and gains each resolved address.
   */
  recordResolved(host: string, addresses: readonly IpAddr[]): void {
    const { policy } = this;
    if (policy === undefined) {
      return;
    }
    const name = normalizeDnsName(host);
    const rules = policy.connect.filter(
      (r) => r.host.kind === 'name' && dnsMatches(r.host.pattern, name),
    );
    for (const ip of addresses) {
      for (const rule of rules) {
        this.#resolved.push({ host: { kind: 'ip', ip }, port: rule.port });
      }
    }
  }

  /** TCP connect, UDP connect and UDP send_to. */
  authorizeConnect(addr: SocketAddr): Result<void, PolicyDenied> {
    const { policy } = this;
    if (policy === undefined) {
      return ok(undefined);
    }
    if (
      policy.connect.some((r) => ruleMatches(r, addr)) ||
      this.#resolved.some((r) => ruleMatches(r, addr))
    ) {
      return ok(undefined);
    }
    return sandboxDenied('network connect', rustDebugStr(formatSocketAddr(addr)));
  }

  /** bind, and the implicit bind of `listen` on a socket whose port is still 0. */
  authorizeBind(addr: SocketAddr): Result<void, PolicyDenied> {
    const { policy } = this;
    if (policy === undefined) {
      return ok(undefined);
    }
    if (policy.bind.some((r) => ruleMatches(r, addr))) {
      return ok(undefined);
    }
    return sandboxDenied('network bind', rustDebugStr(formatSocketAddr(addr)));
  }
}
