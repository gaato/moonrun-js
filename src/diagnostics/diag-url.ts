/**
 * Location of the prebuilt diagnostics component next to this module (built by
 * scripts/build-wasm.ts from crates/moonrun-diag, committed, shipped in the package).
 * Hosts read it; this module only names it, so the core needs no `node:*` import.
 */
export const DIAGNOSTICS_URL: URL = new URL('./moonrun-diag.wasm', import.meta.url);
