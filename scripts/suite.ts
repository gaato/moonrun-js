// Conformance suite: runs `moon test` of an upstream project twice, once with the
// real moonrun and once with moonrun-js, recording every runner invocation through
// scripts/record-shim, then compares invocations byte for byte.
//
//   node scripts/suite.ts <async|core|x|path> [--target wasm|wasm-gc] [-p <pkg>]... [--refresh-ref] [--unordered] [--runtime node|deno|bun]
//
// Reports go to .cache/reports/<suite>-<target>.json.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cache = path.join(repoRoot, '.cache');
const lock = JSON.parse(readFileSync(path.join(repoRoot, 'upstream.lock.json'), 'utf8')) as {
  async: { commit: string };
};
const home = process.env['HOME'] ?? '';

const argv = process.argv.slice(2);
const suite = argv[0];
if (suite === undefined) {
  console.error(
    'usage: node scripts/suite.ts <async|core|x|path> [--target t] [-p pkg]... [--refresh-ref]',
  );
  process.exit(2);
}
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = option('--target') ?? 'wasm';
const packages = argv.flatMap((a, i) => (a === '-p' ? [argv[i + 1] ?? ''] : []));
const refreshRef = argv.includes('--refresh-ref');
// D12: concurrent async tests finish in timing order, even under the real moonrun.
const unordered = argv.includes('--unordered');
const runtime = option('--runtime') ?? 'node';
const jsRunner = path.join(
  repoRoot,
  runtime === 'node' ? 'bin/moonrun-js' : `bin/moonrun-js-${runtime}`,
);

function checkout(): string {
  const dir = path.join(cache, 'upstream', suite ?? '');
  if (suite === 'async' || suite === 'x') {
    const source = path.join(home, 'ghq/github.com/moonbitlang', suite);
    if (!existsSync(dir)) {
      execFileSync('git', ['clone', '--quiet', source, dir]);
    }
    if (suite === 'async') {
      execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', lock.async.commit]);
    }
    return dir;
  }
  if (suite === 'core') {
    // The core bundled with the toolchain matches the installed moonc.
    if (!existsSync(dir)) {
      cpSync(path.join(home, '.moonup/toolchains/latest/lib/core'), dir, {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}_build`),
      });
    }
    return dir;
  }
  return path.resolve(suite ?? '.');
}

interface Record {
  readonly argv: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number | null;
  readonly signal: string | null;
}

function record(project: string, runner: string, out: string, build: string): void {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const args = [
    'test',
    '--target',
    target,
    '--target-dir',
    build,
    ...packages.flatMap((p) => ['-p', p]),
  ];
  const started = Date.now();
  const result = spawnSync('moon', args, {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: {
      ...process.env,
      MOONRUN_OVERRIDE: path.join(repoRoot, 'scripts/record-shim'),
      MOONRUN_JS_RECORD_RUNNER: runner,
      MOONRUN_JS_RECORD_DIR: out,
      MOONRUN_JS_RECORD_ROOT: project,
      MOONRUN_JS_RECORD_BUILD: build,
    },
  });
  const tail = result.stdout.trim().split('\n').slice(-1)[0] ?? '';
  console.log(`${path.basename(runner)}: ${tail} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

function load(dir: string): Map<string, Record> {
  const map = new Map<string, Record>();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    map.set(f, JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record);
  }
  return map;
}

function firstDifference(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `line ${i + 1}:\n  moonrun:    ${JSON.stringify(al[i])}\n  moonrun-js: ${JSON.stringify(bl[i])}`;
    }
  }
  return '';
}

/** Test-protocol blocks sorted, other output kept in order (for `--unordered`, D12). */
function sortedResultBlocks(stdout: string): string {
  const blocks: string[] = [];
  const rest = stdout.replace(
    /----- BEGIN MOON TEST RESULT -----\n[\s\S]*?\n----- END MOON TEST RESULT -----\n/g,
    (block) => {
      blocks.push(block);
      return '';
    },
  );
  return `${rest}\0${blocks.sort().join('')}`;
}

const project = checkout();
const packageKey = packages.join('+').replaceAll('/', '_');
// Long package lists would exceed the file-name limit; hash them.
const packagePart =
  packageKey.length === 0
    ? ''
    : packageKey.length <= 80
      ? `-${packageKey}`
      : `-${createHash('sha256').update(packageKey).digest('hex').slice(0, 16)}`;
const key = `${path.basename(project)}-${target}${packagePart}`;
const refDir = path.join(cache, 'records', `${key}.ref`);
const jsDir = path.join(cache, 'records', `${key}.${runtime}`);
if (refreshRef || !existsSync(refDir)) {
  // The toolchain binary, not ~/.moon/bin/moonrun: the moonup shim adds variables to the child env.
  const reference =
    process.env['MOONRUN_REFERENCE'] ?? path.join(home, '.moonup/toolchains/latest/bin/moonrun');
  record(project, reference, refDir, path.join(cache, 'build', key, 'ref'));
}
// A separate target dir keeps moon from reusing cached test results of the other runner.
record(project, jsRunner, jsDir, path.join(cache, 'build', key, runtime));

const ref = load(refDir);
const js = load(jsDir);
const mismatches: Array<{ argv: string[]; field: string; detail: string }> = [];
for (const [k, r] of ref) {
  const j = js.get(k);
  if (j === undefined) {
    mismatches.push({ argv: r.argv, field: 'missing', detail: 'moonrun-js was not invoked' });
    continue;
  }
  for (const field of ['exit', 'stdout', 'stderr'] as const) {
    const same =
      field === 'stdout' && unordered
        ? sortedResultBlocks(r.stdout) === sortedResultBlocks(j.stdout)
        : r[field] === j[field];
    if (!same) {
      const detail =
        field === 'exit'
          ? `${r.exit} != ${j.exit}`
          : firstDifference(String(r[field]), String(j[field]));
      mismatches.push({ argv: r.argv, field, detail });
    }
  }
}
for (const [k, j] of js) {
  if (!ref.has(k)) {
    mismatches.push({ argv: j.argv, field: 'extra', detail: 'only moonrun-js was invoked' });
  }
}
mkdirSync(path.join(cache, 'reports'), { recursive: true });
const reportPath = path.join(
  cache,
  'reports',
  `${key}${runtime === 'node' ? '' : `.${runtime}`}.json`,
);
writeFileSync(reportPath, JSON.stringify({ invocations: ref.size, mismatches }, null, 2));
const bad = new Set(mismatches.map((m) => JSON.stringify(m.argv))).size;
console.log(
  `${key}: ${ref.size - bad}/${ref.size} invocations identical; report ${path.relative(repoRoot, reportPath)}`,
);
for (const m of mismatches.slice(0, 10)) {
  console.log(`- [${m.field}] ${m.argv.at(-2) ?? ''}\n  ${m.detail.replaceAll('\n', '\n  ')}`);
}
process.exitCode = mismatches.length === 0 ? 0 : 1;
