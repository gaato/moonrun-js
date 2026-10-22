// Builds crates/sqlite-engine into src/domains/sqlite/sqlite-engine.wasm.
//
//   node scripts/build-sqlite.ts           build and write the wasm
//   node scripts/build-sqlite.ts --check   build into .cache and compare with the committed wasm
//
// SQLite is the amalgamation moonrun links: libsqlite3-sys 0.38.2's bundled SQLite 3.53.2
// (the version in moon's Cargo.lock), taken from the crates.io tarball whose SHA-256 is
// the checksum recorded there. It is compiled with libsqlite3-sys's flags for a Linux
// build (build.rs `build_bundled`), except where the wasm target needs otherwise (below).
//
// Needs clang and wasm-ld with the wasm32 target, the wasi-sysroot libc headers and
// libc.a (only pure functions are linked: the allow-list below admits no WASI import),
// and wasm-opt (binaryen, pinned in mise.toml). The committed wasm is what ships;
// TypeScript contributors never need a C toolchain.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const crateDir = path.join(repoRoot, 'crates/sqlite-engine');
const cacheDir = path.join(repoRoot, '.cache/sqlite-engine');
const output = path.join(repoRoot, 'src/domains/sqlite/sqlite-engine.wasm');
const check = process.argv.includes('--check');
const sysroot = process.env['WASI_SYSROOT'] ?? '/usr/share/wasi-sysroot';

// moon 1af328f Cargo.lock: libsqlite3-sys 0.38.2, checksum = SHA-256 of the .crate.
const CRATE = {
  name: 'libsqlite3-sys-0.38.2',
  url: 'https://static.crates.io/crates/libsqlite3-sys/libsqlite3-sys-0.38.2.crate',
  sha256: 'f1d20bef17f513b9b3004532233187769cd072d790971f4e4da0e346eb6401e8',
  sqliteVersion: '3.53.2',
};

// libsqlite3-sys 0.38.2 build.rs (`bundled`, Linux, no optional features).
const LIBSQLITE3_SYS_FLAGS = [
  '-DSQLITE_CORE',
  '-DSQLITE_DEFAULT_FOREIGN_KEYS=1',
  '-DSQLITE_ENABLE_API_ARMOR',
  '-DSQLITE_ENABLE_COLUMN_METADATA',
  '-DSQLITE_ENABLE_DBSTAT_VTAB',
  '-DSQLITE_ENABLE_FTS3',
  '-DSQLITE_ENABLE_FTS3_PARENTHESIS',
  '-DSQLITE_ENABLE_FTS5',
  '-DSQLITE_ENABLE_JSON1',
  '-DSQLITE_ENABLE_LOAD_EXTENSION=1',
  '-DSQLITE_ENABLE_MEMORY_MANAGEMENT',
  '-DSQLITE_ENABLE_RTREE',
  '-DSQLITE_ENABLE_STAT4',
  '-DSQLITE_SOUNDEX',
  '-DSQLITE_THREADSAFE=1',
  '-DSQLITE_USE_URI',
  '-DHAVE_USLEEP=1',
  '-DHAVE_ISNAN',
  '-D_POSIX_THREAD_SAFE_FUNCTIONS',
  '-DHAVE_LOCALTIME_R',
];

// The wasm build: the OS layer and mutexes come from engine.c (os_unix.c and pthreads
// need a POSIX kernel), and `long double` is `double` as in libsqlite3-sys's own
// wasm32-wasi configuration (wasm32's 128-bit long double needs compiler-rt).
const WASM_FLAGS = ['-DSQLITE_OS_OTHER=1', '-DSQLITE_MUTEX_APPDEF=1', '-DLONGDOUBLE_TYPE=double'];

const CFLAGS = [
  '--target=wasm32-wasip1',
  `--sysroot=${sysroot}`,
  '-Oz',
  '-DNDEBUG',
  '-ffunction-sections',
  '-fdata-sections',
  '-fno-ident',
];

const ENGINE_EXPORTS = [
  'sqlite3_open_v2',
  'sqlite3_close',
  'sqlite3_errmsg16',
  'sqlite3_errcode',
  'sqlite3_extended_errcode',
  'sqlite3_changes64',
  'sqlite3_total_changes64',
  'sqlite3_db_mutex',
  'sqlite3_mutex_enter',
  'sqlite3_mutex_leave',
  'sqlite3_prepare16_v2',
  'sqlite3_bind_null',
  'sqlite3_bind_int64',
  'sqlite3_bind_double',
  'sqlite3_step',
  'sqlite3_reset',
  'sqlite3_clear_bindings',
  'sqlite3_stmt_busy',
  'sqlite3_stmt_readonly',
  'sqlite3_finalize',
  'sqlite3_column_count',
  'sqlite3_data_count',
  'sqlite3_column_name16',
  'sqlite3_column_type',
  'sqlite3_column_int64',
  'sqlite3_column_double',
  'sqlite3_column_text16',
  'sqlite3_column_bytes16',
  'sqlite3_column_blob',
  'sqlite3_column_bytes',
  'sqlite3_libversion',
  'sqlite3_sourceid',
];

const EXPECTED_IMPORTS = [
  'access',
  'authorize',
  'check_reserved',
  'close',
  'file_mode',
  'fsize',
  'fsync',
  'ftruncate',
  'getcwd',
  'getenv',
  'lock',
  'lstat_is_link',
  'now_ms',
  'open',
  'pread',
  'progress',
  'pwrite',
  'random',
  'readlink',
  'sleep_us',
  'stat',
  'unlink',
  'unlock',
  'utc_offset',
].map((name) => `host.${name}`);

// Features clang enables for wasm32. `--all-features` would let wasm-opt emit
// encodings Node cannot load (docs/spikes.md S7), so list them.
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

async function crateTarball(): Promise<Uint8Array> {
  const cargoHome = process.env['CARGO_HOME'] ?? path.join(process.env['HOME'] ?? '', '.cargo');
  const registryCache = path.join(cargoHome, 'registry/cache');
  if (existsSync(registryCache)) {
    for (const index of readdirSync(registryCache)) {
      const file = path.join(registryCache, index, `${CRATE.name}.crate`);
      if (existsSync(file)) {
        return readFileSync(file);
      }
    }
  }
  const response = await fetch(CRATE.url);
  if (!response.ok) {
    throw new Error(`downloading ${CRATE.url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Extracts sqlite3.c / sqlite3.h of the pinned crate; reuses them while the pin is unchanged. */
async function prepareAmalgamation(): Promise<string> {
  const target = path.join(cacheDir, CRATE.name);
  const stampFile = path.join(cacheDir, `${CRATE.name}.stamp`);
  const stamp = `${CRATE.sha256}\n`;
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
    return target;
  }
  const tarball = await crateTarball();
  if (sha256(tarball) !== CRATE.sha256) {
    throw new Error(`${CRATE.name}.crate checksum mismatch (expected ${CRATE.sha256})`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const tarFile = path.join(cacheDir, `${CRATE.name}.crate`);
  writeFileSync(tarFile, tarball);
  run('tar', [
    'xzf',
    tarFile,
    '-C',
    cacheDir,
    `${CRATE.name}/sqlite3/sqlite3.c`,
    `${CRATE.name}/sqlite3/sqlite3.h`,
  ]);
  rmSync(tarFile);
  const header = readFileSync(path.join(target, 'sqlite3/sqlite3.h'), 'utf8');
  if (!header.includes(`#define SQLITE_VERSION        "${CRATE.sqliteVersion}"`)) {
    throw new Error(`${CRATE.name} does not bundle SQLite ${CRATE.sqliteVersion}`);
  }
  writeFileSync(stampFile, stamp);
  return target;
}

/** Compiles `source` unless an object for the same source and flags exists. */
function compile(source: string, flags: readonly string[], name: string): string {
  const key = sha256(
    new TextEncoder().encode(
      `${sha256(readFileSync(source))}\n${flags.join(' ')}\n${execFileSync('clang', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })}`,
    ),
  ).slice(0, 16);
  const object = path.join(cacheDir, `${name}-${key}.o`);
  if (!existsSync(object)) {
    run('clang', [...flags, '-c', source, '-o', `${object}.tmp`]);
    run('mv', [`${object}.tmp`, object]);
  }
  return object;
}

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

const amalgamation = path.join(await prepareAmalgamation(), 'sqlite3');
const sqliteObject = compile(
  path.join(amalgamation, 'sqlite3.c'),
  [...CFLAGS, ...LIBSQLITE3_SYS_FLAGS, ...WASM_FLAGS],
  'sqlite3',
);
const engineObject = compile(
  path.join(crateDir, 'engine.c'),
  [...CFLAGS, ...LIBSQLITE3_SYS_FLAGS, ...WASM_FLAGS, `-I${amalgamation}`],
  'engine',
);
const libdir = path.join(sysroot, 'lib/wasm32-wasip1');
const raw = path.join(cacheDir, 'sqlite-engine.raw.wasm');
run('wasm-ld', [
  '--no-entry',
  '--gc-sections',
  '--export-memory',
  '--strip-all',
  ...ENGINE_EXPORTS.map((e) => `--export=${e}`),
  '-o',
  raw,
  sqliteObject,
  engineObject,
  path.join(libdir, 'libc.a'),
]);
const optimized = check ? path.join(cacheDir, 'sqlite-engine.check.wasm') : output;
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
if (imports.join() !== [...EXPECTED_IMPORTS].sort().join()) {
  throw new Error(
    `sqlite-engine.wasm imports ${imports.join(', ')}; expected exactly ${EXPECTED_IMPORTS.join(', ')}`,
  );
}
console.log(
  `sqlite-engine.wasm: ${kib(readFileSync(raw).length)} raw, ${kib(bytes.length)} after wasm-opt, ${kib(gzipSync(bytes).length)} gzip`,
);
if (check) {
  const committed = readFileSync(output);
  const same = sha256(committed) === sha256(bytes);
  const before = surface(committed);
  const sameSurface =
    before.imports.join() === imports.join() && before.exports.join() === exports.join();
  console.log(
    same
      ? 'committed wasm is byte-identical'
      : `committed wasm differs in bytes (${kib(committed.length)}); import/export surface ${sameSurface ? 'matches' : 'DIFFERS'}`,
  );
  if (!same || !sameSurface) {
    process.exit(1);
  }
}
