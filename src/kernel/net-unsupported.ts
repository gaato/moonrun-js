import type { DnsPort, NetPort } from '../ports/net.ts';

const ENOSYS = { code: 'ENOSYS' } as const;

/**
 * A host without networking: every socket fails with `ENOSYS` once it would touch
 * the host, and every lookup fails with `EAI_SYSTEM`/`ENOSYS`.
 */
export const unsupportedNet: NetPort = {
  connect: (_options, events) => {
    queueMicrotask(() => events.error(ENOSYS));
    return {
      write: () => true,
      pause: () => {},
      resume: () => {},
      close: () => {},
      localAddress: () => undefined,
      remoteAddress: () => undefined,
      setNoDelay: () => {},
      setKeepAlive: () => {},
    };
  },
  listen: (_options, events) => {
    queueMicrotask(() => events.error(ENOSYS));
    return { localAddress: () => undefined, close: () => {} };
  },
  datagram: (_family, _options, events) => ({
    bind: () => queueMicrotask(() => events.error(ENOSYS)),
    connect: () => queueMicrotask(() => events.error(ENOSYS)),
    disconnect: () => {},
    send: () => queueMicrotask(() => events.error(ENOSYS)),
    setOption: () => ({ ok: false, error: ENOSYS }),
    localAddress: () => undefined,
    close: () => {},
  }),
  interfaces: () => [],
};

export const unsupportedDns: DnsPort = {
  lookup: () => Promise.resolve({ ok: false, error: { kind: 'system', error: ENOSYS } }),
};
