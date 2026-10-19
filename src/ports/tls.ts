import type { HostError, Result } from './result.ts';

/** Root certificates for TLS trust mode 1 (`TrustSystemRoot`). */
export interface TrustStorePort {
  /**
   * DER certificates the host's OpenSSL default lookup would trust. Called at
   * most once per TLS domain (per Run); the result is reused.
   */
  systemRoots(): Result<readonly Uint8Array[], HostError>;
}

/** A trust store that has no system roots (hosts without one, tests). */
export const emptyTrustStore: TrustStorePort = {
  systemRoots: () => ({ ok: true, value: [] }),
};
