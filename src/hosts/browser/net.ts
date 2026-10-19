import { formatIp, parseIp } from '../../domains/policy/ip.ts';
import type {
  ByteStream,
  ConnectOptions,
  DnsPort,
  NetPort,
  ResolvedIp,
  SocketAddress,
  StreamEvents,
} from '../../ports/net.ts';
import { err, type HostErrorCode, ok } from '../../ports/result.ts';

/** Stable, per-run fake IPv4 addresses; literals bypass the mapping. */
export class BrowserDns implements DnsPort {
  readonly #hosts = new Map<string, Uint8Array>();
  readonly #names = new Map<string, string>();
  async lookup(host: string): ReturnType<DnsPort['lookup']> {
    const literal = parseIp(host);
    if (literal !== undefined) return ok([{ family: literal.v, ip: literal.bytes, scopeId: 0 }]);
    const name = host.toLowerCase().replace(/\.$/, '');
    if (
      name.length > 253 ||
      !name.split('.').every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))
    ) {
      return err({ kind: 'eai', code: 'EAI_NONAME' });
    }
    let ip = this.#hosts.get(name);
    if (ip === undefined) {
      const n = this.#hosts.size + 1;
      if (n >= 0x20000) return err({ kind: 'eai', code: 'EAI_MEMORY' });
      ip = new Uint8Array([198, 18 + (n >> 16), (n >> 8) & 255, n & 255]);
      this.#hosts.set(name, ip);
      this.#names.set(ip.join('.'), name);
    }
    const address: ResolvedIp = { family: 4, ip: ip.slice(), scopeId: 0 };
    return ok([address]);
  }
  hostname(address: SocketAddress): string {
    return (
      (address.family === 4 ? this.#names.get(address.ip.join('.')) : undefined) ??
      formatIp({ v: address.family, bytes: address.ip })
    );
  }
}

const HIGH_WATER = 64 * 1024;
/** One WebSocket per TCP connection. TLS records are opaque binary messages. */
function connect(
  relay: string | undefined,
  hostname: string,
  options: ConnectOptions,
  events: StreamEvents,
): ByteStream {
  const remote = options.remote;
  let noDelay = options.noDelay;
  let keepAlive = options.keepAliveSeconds;
  let ws: WebSocket | undefined;
  let connected = false;
  let closed = false;
  let ended = false;
  let peerEnded = false;
  let paused = false;
  let outstanding = 0;
  let needDrain = false;
  let credit = 0;
  const pending: Uint8Array[] = [];
  const send = (message: object): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const error = (code: HostErrorCode): void => {
    if (closed) return;
    closed = true;
    events.error({ code });
    ws?.close();
  };
  const flush = (): void => {
    while (!paused && pending.length > 0) {
      const chunk = pending.shift() as Uint8Array;
      credit += chunk.length;
      events.data(chunk);
    }
    if (!paused && credit > 0) {
      send({ type: 'credit', bytes: credit });
      credit = 0;
    }
    if (!paused && pending.length === 0 && ended) {
      ended = false;
      events.end();
    }
  };
  try {
    if (relay === undefined) queueMicrotask(() => error('ENOSYS'));
    else {
      ws = new WebSocket(relay, 'moonrun-tcp-v1');
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () =>
        send({ type: 'connect', host: hostname, port: remote.port, credit: 128 * 1024 }),
      );
      ws.addEventListener('message', (event) => {
        if (closed) return;
        if (event.data instanceof ArrayBuffer) {
          pending.push(new Uint8Array(event.data));
          flush();
          return;
        }
        try {
          if (typeof event.data !== 'string') throw new Error('invalid relay message');
          const msg: unknown = JSON.parse(event.data);
          if (typeof msg !== 'object' || msg === null || !('type' in msg))
            throw new Error('invalid relay control');
          switch (msg.type) {
            case 'connected':
              connected = true;
              send({ type: 'no-delay', enabled: noDelay });
              if (keepAlive !== undefined)
                send({ type: 'keep-alive', enabled: true, idleSeconds: keepAlive });
              events.connected();
              break;
            case 'ack':
              if (
                !('bytes' in msg) ||
                typeof msg.bytes !== 'number' ||
                !Number.isSafeInteger(msg.bytes) ||
                msg.bytes < 0 ||
                msg.bytes > outstanding
              )
                throw new Error('invalid ack');
              outstanding -= msg.bytes;
              if (needDrain && outstanding < HIGH_WATER) {
                needDrain = false;
                events.drain();
              }
              break;
            case 'end':
              peerEnded = true;
              ended = true;
              flush();
              break;
            case 'error': {
              const code = 'code' in msg ? msg.code : undefined;
              const known: Readonly<Record<string, HostErrorCode>> = {
                EACCES: 'EACCES',
                ECONNREFUSED: 'ECONNREFUSED',
                ECONNRESET: 'ECONNRESET',
                EHOSTUNREACH: 'EHOSTUNREACH',
                ETIMEDOUT: 'ETIMEDOUT',
                ENETUNREACH: 'ENETUNREACH',
                ENOBUFS: 'ENOBUFS',
                EINVAL: 'EINVAL',
                EPIPE: 'EPIPE',
              };
              error(typeof code === 'string' ? (known[code] ?? 'EIO') : 'EIO');
              break;
            }
            default:
              throw new Error('unknown relay control');
          }
        } catch {
          error('EIO');
        }
      });
      ws.addEventListener('error', () => error('ECONNREFUSED'));
      ws.addEventListener('close', () => {
        if (!closed && !peerEnded) error('ECONNRESET');
      });
    }
  } catch {
    queueMicrotask(() => error('EIO'));
  }
  return {
    write: (bytes) => {
      if (closed || ws?.readyState !== WebSocket.OPEN) {
        queueMicrotask(() => error('ECONNRESET'));
        return false;
      }
      outstanding += bytes.length;
      for (let offset = 0; offset < bytes.length; offset += HIGH_WATER)
        ws.send(bytes.slice(offset, offset + HIGH_WATER));
      needDrain = outstanding >= HIGH_WATER;
      return !needDrain;
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      flush();
    },
    close: (mode) => {
      if (closed) return;
      closed = true;
      if (ws?.readyState === WebSocket.OPEN) {
        send({ type: mode === 'graceful' ? 'end' : 'reset' });
      }
      // WebSocket.close flushes previously queued messages, including the FIN command.
      ws?.close();
    },
    localAddress: () =>
      connected
        ? { family: 4, ip: new Uint8Array([127, 0, 0, 1]), port: 0, flowInfo: 0, scopeId: 0 }
        : undefined,
    remoteAddress: () => (connected ? remote : undefined),
    setNoDelay: (enabled) => {
      noDelay = enabled;
      send({ type: 'no-delay', enabled });
    },
    setKeepAlive: (enabled, idleSeconds) => {
      keepAlive = enabled ? idleSeconds : undefined;
      send({ type: 'keep-alive', enabled, idleSeconds });
    },
  };
}

export function browserNet(dns: BrowserDns, relay?: string): NetPort {
  return {
    connect: (options, events) => connect(relay, dns.hostname(options.remote), options, events),
    listen: (_options, events) => {
      queueMicrotask(() => events.error({ code: 'ENOSYS' }));
      return { localAddress: () => undefined, close: () => {} };
    },
    datagram: (_family, _options, events) => {
      const unsupported = (): void => {
        queueMicrotask(() => events.error({ code: 'ENOSYS' }));
      };
      return {
        bind: unsupported,
        connect: unsupported,
        disconnect: unsupported,
        send: unsupported,
        setOption: () => err({ code: 'ENOSYS' }),
        localAddress: () => undefined,
        close: () => {},
      };
    },
    interfaces: () => [],
  };
}
