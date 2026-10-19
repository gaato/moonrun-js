// Builds the wasm components made from moonrun's own Rust source (crates/, docs/reuse.md).
//
//   node scripts/build-wasm.ts           build and write the committed .wasm files
//   node scripts/build-wasm.ts --check   build into .cache and compare with the committed files
//
// Needs cargo + rustc with the wasm32-unknown-unknown target and wasm-opt (binaryen,
// pinned in mise.toml). The committed wasm is what ships; TypeScript contributors never
// need Rust. Each component's imports must stay within its allow-list: an unexpected
// import means upstream code reaches the OS through a path the `os` crate does not cover.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cratesDir = path.join(repoRoot, 'crates');
const cacheDir = path.join(repoRoot, '.cache/wasm');
const check = process.argv.includes('--check');

interface Component {
  readonly crate: string;
  /** Committed output, relative to the repo root. */
  readonly output: string;
  readonly imports: readonly string[];
}

const OS_IMPORTS = [
  'host.environ',
  'host.getcwd',
  'host.getenv',
  'host.mkdir',
  'host.read_dir',
  'host.read_file',
  'host.realpath',
  'host.remove_dir_all',
  'host.remove_file',
  'host.stat',
  'host.strerror',
  'host.write_file',
  'host.write_stderr',
  // `Env`'s ambient backing writes through to the process environment.
  'libc.setenv',
  'libc.unsetenv',
];

const COMPONENTS: readonly Component[] = [
  {
    crate: 'moonrun-policy',
    output: 'src/domains/policy/moonrun-policy.wasm',
    imports: OS_IMPORTS,
  },
  {
    crate: 'moonrun-diag',
    output: 'src/diagnostics/moonrun-diag.wasm',
    imports: ['host.read_file', 'host.strerror'],
  },
  { crate: 'moonrun-cli', output: 'src/hosts/node/moonrun-cli.wasm', imports: [] },
  // Test-only (test/unit/stat-layout.test.ts); not shipped.
  { crate: 'stat-layout', output: 'test/fixtures/wasm/stat-layout.wasm', imports: [] },
];

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

function run(cmd: string, args: string[], cwd = repoRoot): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const kib = (n: number): string => `${(n / 1024).toFixed(1)} KiB`;

function surface(bytes: Uint8Array): { imports: string[]; exports: string[] } {
  const module = new WebAssembly.Module(bytes);
  return {
    imports: WebAssembly.Module.imports(module)
      .map((i) => `${i.module}.${i.name}`)
      .sort(),
    exports: WebAssembly.Module.exports(module)
      .map((e) => `${e.name}:${e.kind}`)
      .sort(),
  };
}

run('cargo', ['build', '--release', '--locked', '--workspace'], cratesDir);

let failed = false;
for (const component of COMPONENTS) {
  const name = component.crate.replaceAll('-', '_');
  const raw = path.join(cratesDir, 'target/wasm32-unknown-unknown/release', `${name}.wasm`);
  const committed = path.join(repoRoot, component.output);
  const optimized = check ? path.join(cacheDir, path.basename(component.output)) : committed;
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
  const { imports, exports } = surface(bytes);
  const unexpected = imports.filter((i) => !component.imports.includes(i));
  if (unexpected.length > 0) {
    console.error(`${component.crate}: unexpected imports ${unexpected.join(', ')}`);
    failed = true;
  }
  console.log(
    `${path.basename(component.output)}: ${kib(readFileSync(raw).length)} raw, ${kib(bytes.length)} after wasm-opt, ${kib(gzipSync(bytes).length)} gzip`,
  );
  if (check) {
    const old = readFileSync(committed);
    const same = sha256(old) === sha256(bytes);
    const before = surface(old);
    const sameSurface =
      before.imports.join() === imports.join() && before.exports.join() === exports.join();
    console.log(
      same
        ? '  committed wasm is byte-identical'
        : `  committed wasm differs in bytes (${kib(old.length)}); import/export surface ${sameSurface ? 'matches' : 'DIFFERS'}`,
    );
    if (!sameSurface) {
      failed = true;
    }
  }
}
if (failed) {
  process.exit(1);
}
