import { defineConfig } from 'tsdown';

// Unbundled ESM keeps src/'s module layout in dist/, so `new URL('./<name>.wasm',
// import.meta.url)` next to each component's module keeps pointing at the copied wasm.
export default defineConfig({
  entry: ['src/index.ts', 'src/hosts/node/index.ts', 'src/hosts/node/cli.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  unbundle: true,
  dts: true,
  // node: modules stay imports; only src/hosts uses them.
  deps: { neverBundle: [/^node:/] },
  // The prebuilt wasm components, next to the modules that name them by URL.
  copy: [
    { from: 'src/domains/tls/tls-engine.wasm', to: 'dist/domains/tls' },
    { from: 'src/domains/policy/moonrun-policy.wasm', to: 'dist/domains/policy' },
    { from: 'src/diagnostics/moonrun-diag.wasm', to: 'dist/diagnostics' },
    { from: 'src/hosts/node/moonrun-cli.wasm', to: 'dist/hosts/node' },
  ],
});
