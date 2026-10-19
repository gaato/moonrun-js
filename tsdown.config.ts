import { defineConfig } from 'tsdown';

// Unbundled ESM keeps src/'s module layout in dist/, so `new URL('./tls-engine.wasm',
// import.meta.url)` in domains/tls/engine-url keeps pointing at the copied wasm.
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
  copy: [{ from: 'src/domains/tls/tls-engine.wasm', to: 'dist/domains/tls' }],
});
