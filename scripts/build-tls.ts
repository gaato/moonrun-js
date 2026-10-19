// Builds crates/tls-engine into src/domains/tls/tls-engine.wasm.
//
//   node scripts/build-tls.ts           build and write the wasm
//   node scripts/build-tls.ts --check   build into .cache and compare with the committed wasm
//
// Needs cargo + rustc with the wasm32-unknown-unknown target, clang and llvm-ar
// (ring compiles C), `patch`, and wasm-opt (binaryen, pinned in mise.toml).
// The committed wasm is what ships; TypeScript contributors never need Rust.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const crateDir = path.join(repoRoot, 'crates/tls-engine');
const cacheDir = path.join(repoRoot, '.cache/tls-engine');
const output = path.join(repoRoot, 'src/domains/tls/tls-engine.wasm');
const check = process.argv.includes('--check');

// ring 0.17.14 from crates.io, patched so SystemRandom uses getrandom's custom
// backend on wasm32-unknown-unknown (crates/tls-engine/patches/README.md).
const RING = {
  name: 'ring-0.17.14',
  url: 'https://static.crates.io/crates/ring/ring-0.17.14.crate',
  sha256: 'a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7',
  patch: path.join(crateDir, 'patches/ring-0.17.14-wasm32-custom-getrandom.patch'),
};

// Features rustc enables for wasm32-unknown-unknown. `--all-features` would let
// wasm-opt emit encodings Node cannot load (docs/spikes.md S7), so list them.
const WASM_OPT_FEATURES = [
  '--enable-bulk-memory',
  '--enable-sign-ext',
  '--enable-nontrapping-float-to-int',
  '--enable-mutable-globals',
  '--enable-multivalue',
  '--enable-reference-types',
];

const EXPECTED_IMPORTS = ['env.now_unix_ms', 'env.random_fill'];

function run(cmd: string, args: string[], cwd = repoRoot): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ringTarball(): Promise<Uint8Array> {
  const cargoHome = process.env['CARGO_HOME'] ?? path.join(process.env['HOME'] ?? '', '.cargo');
  const registryCache = path.join(cargoHome, 'registry/cache');
  if (existsSync(registryCache)) {
    for (const index of readdirSync(registryCache)) {
      const file = path.join(registryCache, index, `${RING.name}.crate`);
      if (existsSync(file)) {
        return readFileSync(file);
      }
    }
  }
  const response = await fetch(RING.url);
  if (!response.ok) {
    throw new Error(`downloading ${RING.url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Extracts the pinned ring and applies the patch; reuses the result while both are unchanged. */
async function preparePatchedRing(): Promise<void> {
  const target = path.join(cacheDir, RING.name);
  const patch = readFileSync(RING.patch);
  const stamp = `${RING.sha256} ${sha256(patch)}\n`;
  const stampFile = path.join(cacheDir, `${RING.name}.stamp`);
  if (existsSync(target) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
    return;
  }
  const tarball = await ringTarball();
  if (sha256(tarball) !== RING.sha256) {
    throw new Error(`${RING.name}.crate checksum mismatch (expected ${RING.sha256})`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const tarFile = path.join(cacheDir, `${RING.name}.crate`);
  writeFileSync(tarFile, tarball);
  run('tar', ['xzf', tarFile, '-C', cacheDir]);
  rmSync(tarFile);
  // --forward + exit status: fails loudly when the pre-image does not match.
  run('patch', ['-p1', '--forward', '--batch', '-d', target, '-i', RING.patch]);
  writeFileSync(stampFile, stamp);
}

function importsOf(bytes: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(bytes))
    .map((i) => `${i.module}.${i.name}`)
    .sort();
}

function exportsOf(bytes: Uint8Array): string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(bytes))
    .map((e) => `${e.name}:${e.kind}`)
    .sort();
}

await preparePatchedRing();
run('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], crateDir);
const raw = path.join(crateDir, 'target/wasm32-unknown-unknown/release/tls_engine.wasm');
const optimized = check ? path.join(cacheDir, 'tls-engine.check.wasm') : output;
mkdirSync(path.dirname(optimized), { recursive: true });
run('wasm-opt', [
  '-Oz',
  ...WASM_OPT_FEATURES,
  '--strip-debug',
  '--strip-producers',
  raw,
  '-o',
  optimized,
]);

const bytes = readFileSync(optimized);
const imports = importsOf(bytes);
if (imports.join() !== EXPECTED_IMPORTS.join()) {
  throw new Error(
    `tls-engine.wasm imports ${imports.join(', ')}; expected only ${EXPECTED_IMPORTS.join(', ')}`,
  );
}
const kib = (n: number): string => `${(n / 1024).toFixed(1)} KiB`;
console.log(
  `tls-engine.wasm: ${kib(readFileSync(raw).length)} raw, ${kib(bytes.length)} after wasm-opt, ${kib(gzipSync(bytes).length)} gzip`,
);
if (check) {
  const committed = readFileSync(output);
  const same = sha256(committed) === sha256(bytes);
  const surface =
    importsOf(committed).join() === imports.join() &&
    exportsOf(committed).join() === exportsOf(bytes).join();
  console.log(
    same
      ? 'committed wasm is byte-identical'
      : `committed wasm differs in bytes (${kib(committed.length)}); import/export surface ${surface ? 'matches' : 'DIFFERS'}`,
  );
  if (!surface) {
    process.exit(1);
  }
}
