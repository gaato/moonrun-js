import type { ClockPort } from './clock.ts';
import type { ComponentsPort } from './components.ts';
import type { EnvPort } from './env.ts';
import type { FilePort } from './files.ts';
import type { FsPort } from './fs.ts';
import type { DnsPort, NetPort } from './net.ts';
import type { ProcessPort, SignalPort } from './process.ts';
import type { RandomPort } from './random.ts';
import type { StdioPort } from './stdio.ts';
import type { TrustStorePort } from './tls.ts';

/** Everything a run may touch on the host. Missing capabilities use `unsupported` implementations, never `undefined`. */
export interface Host {
  readonly stdio: StdioPort;
  readonly env: EnvPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly fs: FsPort;
  readonly files: FilePort;
  readonly net: NetPort;
  readonly dns: DnsPort;
  readonly components: ComponentsPort;
  /** Child processes (`thread_pool/spawn_job/*`). */
  readonly process: ProcessPort;
  /** OS signals, captured while the guest selected cancellation signals. */
  readonly signals: SignalPort;
  /** System root certificates for TLS trust mode 1. */
  readonly trustStore: TrustStorePort;
  readonly platform: HostPlatform;
}

export interface HostPlatform {
  /** Absolute path of the running wasm file, when it came from a file. */
  /** Raw path bytes: on Unix a path need not be UTF-8. */
  readonly currentExe: Uint8Array | undefined;
  /** Process id shown where moonrun prints OS thread or process ids. */
  readonly pid: number;
}
