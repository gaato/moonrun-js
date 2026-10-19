/**
 * Location of the prebuilt engine next to this module (built by
 * scripts/build-tls.ts, committed, shipped in the package). Hosts read it;
 * this module only names it, so the core needs no `node:*` import.
 */
export const TLS_ENGINE_URL: URL = new URL('./tls-engine.wasm', import.meta.url);
