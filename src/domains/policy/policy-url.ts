/**
 * Location of the prebuilt policy component next to this module (built by
 * scripts/build-wasm.ts from crates/moonrun-policy, committed, shipped in the package).
 * Hosts read it; this module only names it, so the core needs no `node:*` import.
 */
export const POLICY_URL: URL = new URL('./moonrun-policy.wasm', import.meta.url);
