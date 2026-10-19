import type { HostError, Result } from './result.ts';

/**
 * The wasm components built from moonrun's own Rust source (crates/, docs/reuse.md),
 * compiled by the host. The core only instantiates them. Hosts typically compile each
 * once per process and return the same `WebAssembly.Module`.
 */
export interface ComponentsPort {
  /** moonrun-policy.wasm: sandbox policy, run environment, Host Filesystem. */
  policy(): Result<WebAssembly.Module, HostError>;
  /** tls-engine.wasm (crates/tls-engine, rustls): compiled on the first TLS configuration of a run. */
  tlsEngine(): Result<WebAssembly.Module, HostError>;
}
