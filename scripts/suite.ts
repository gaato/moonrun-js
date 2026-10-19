// Conformance suite: runs `moon test` of an upstream project twice, once with the
// real moonrun and once with moonrun-js, recording every runner invocation through
// scripts/record-shim, then compares invocations byte for byte.
//
//   node scripts/suite.ts <async|core|x|path> [--target wasm|wasm-gc] [-p <pkg>]... [--refresh-ref] [--unordered] [--runtime node|deno|bun]
//
// Optional: --expected-differences <json> overrides test/conformance/expected-differences.json.
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
import {
  type ExpectedDifference,
  type ExpectedDifferences,
  jscStderr,
  matchExpectedDifferences,
  unorderedResults,
  validateExpectedDifferences,
} from './comparison.ts';
import { checkoutUpstream } from './upstream.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cache = path.join(repoRoot, '.cache');
const home = process.env['HOME'] ?? '';
const reference =
  process.env['MOONRUN_REFERENCE'] ?? path.join(home, '.moonup/toolchains/latest/bin/moonrun');

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

const expectations = JSON.parse(
  readFileSync(
    path.resolve(
      repoRoot,
      option('--expected-differences') ?? 'test/conformance/expected-differences.json',
    ),
    'utf8',
  ),
) as ExpectedDifferences;
validateExpectedDifferences(
  expectations,
  readFileSync(path.join(repoRoot, 'docs/divergences.md'), 'utf8'),
);
const expected = (expectations[runtime] ?? []).filter(
  (entry) =>
    entry.suite === suite &&
    entry.fingerprints[target] !== undefined &&
    (packages.length === 0 ||
      packages.includes(
        suite === 'core'
          ? `moonbitlang/core/${path.posix.dirname(entry.invocation)}`
          : path.posix.dirname(entry.invocation),
      )),
);

function checkout(): string {
  const dir = path.join(cache, 'upstream', suite ?? '');
  if (suite === 'async') {
    return checkoutUpstream('async', dir);
  }
  if (suite === 'x') {
    // x is not pinned: the local clone's current state.
    const source = path.join(home, 'ghq/github.com/moonbitlang', suite);
    if (!existsSync(dir)) {
      execFileSync('git', ['clone', '--quiet', source, dir]);
    }
    return dir;
  }
  if (suite === 'core') {
    // The core bundled with the toolchain matches the installed moonc.
    if (!existsSync(dir)) {
      cpSync(path.resolve(path.dirname(reference), '../lib/core'), dir, {
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
  const result = spawnSync(moon, args, {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: {
      ...process.env,
      PATH: `${nestedBin}:${process.env['PATH'] ?? ''}`,
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
    const record = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record;
    // Also accept older reference directories which captured nested children.
    if (record.argv.some((arg) => arg.startsWith('<build>/'))) {
      map.set(JSON.stringify(record.argv), record);
    }
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

const project = checkout();
const moon = execFileSync('which', ['moon'], { encoding: 'utf8' }).trim();
const nestedBin = path.join(cache, 'suite-bin');
mkdirSync(nestedBin, { recursive: true });
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
// Capture each nested moon's complete writes. Its parser emits a warning through
// multiple writes; four parallel helper builds otherwise interleave mid-line.
writeFileSync(
  path.join(nestedBin, 'moon'),
  `#!/bin/sh\nexec node ${quote(path.join(repoRoot, 'scripts/record-shim.ts'))} --nested-moon ${quote(moon)} "$@"\n`,
  { mode: 0o755 },
);
if (suite === 'async') {
  const programs = path.join(project, 'test_programs');
  for (const entry of readdirSync(programs, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(path.join(programs, entry.name, 'moon.pkg'))) {
      execFileSync(
        moon,
        ['build', `test_programs/${entry.name}`, '--debug', '--target-dir', '_build/test_programs'],
        { cwd: project, stdio: 'pipe' },
      );
    }
  }
}
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
  record(project, reference, refDir, path.join(cache, 'build', key, 'ref'));
}
// A separate target dir keeps moon from reusing cached test results of the other runner.
record(project, jsRunner, jsDir, path.join(cache, 'build', key, runtime));

const ref = load(refDir);
const js = load(jsDir);
const mismatches: Array<{ argv: string[]; field: string; detail: string }> = [];
const unexpected: typeof mismatches = [];
const matched = new Set<ExpectedDifference>();
for (const [k, r] of ref) {
  const j = js.get(k);
  if (j === undefined) {
    const missing = { argv: r.argv, field: 'missing', detail: 'moonrun-js was not invoked' };
    mismatches.push(missing);
    unexpected.push(missing);
    continue;
  }
  const invocation = r.argv
    .find((arg) => arg.startsWith(`<build>/${target}/debug/test/`))
    ?.slice(`<build>/${target}/debug/test/`.length);
  const accepted = matchExpectedDifferences(
    r.stdout,
    j.stdout,
    expected.filter((entry) => entry.invocation === invocation),
    target,
  );
  for (const entry of accepted.matched) matched.add(entry);
  const sameText = (a: string, b: string): boolean =>
    unordered ? unorderedResults(a) === unorderedResults(b) : a === b;
  for (const field of ['exit', 'signal', 'stdout', 'stderr'] as const) {
    const same =
      field === 'stdout' && unordered
        ? unorderedResults(r.stdout) === unorderedResults(j.stdout)
        : field === 'stderr' && runtime === 'bun'
          ? jscStderr(r.stderr) === jscStderr(j.stderr)
          : r[field] === j[field];
    if (!same) {
      const detail =
        field === 'exit' || field === 'signal'
          ? `${r[field]} != ${j[field]}`
          : firstDifference(String(r[field]), String(j[field]));
      const difference = { argv: r.argv, field, detail };
      mismatches.push(difference);
      if (field !== 'stdout' || !sameText(r.stdout, accepted.stdout)) unexpected.push(difference);
    }
  }
}
for (const [k, j] of js) {
  if (!ref.has(k)) {
    const extra = { argv: j.argv, field: 'extra', detail: 'only moonrun-js was invoked' };
    mismatches.push(extra);
    unexpected.push(extra);
  }
}
const missingExpected = expected.filter((entry) => !entry.flaky && !matched.has(entry));
mkdirSync(path.join(cache, 'reports'), { recursive: true });
const reportPath = path.join(
  cache,
  'reports',
  `${key}${runtime === 'node' ? '' : `.${runtime}`}.json`,
);
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      invocations: ref.size,
      normalizations: [...(unordered ? ['D12'] : []), ...(runtime === 'bun' ? ['D3'] : [])],
      mismatches,
      expected: [...matched],
      unexpected,
      missingExpected,
    },
    null,
    2,
  ),
);
const bad = new Set(mismatches.map((m) => JSON.stringify(m.argv))).size;
console.log(
  `${key}: ${ref.size - bad}/${ref.size} invocations identical; report ${path.relative(repoRoot, reportPath)}`,
);
console.log(
  `Expected differences matched: ${[...new Set([...matched].map((entry) => entry.divergence))].sort().join(', ') || 'none'} (${matched.size} entries); unexpected: ${unexpected.length}; missing expected: ${missingExpected.length}`,
);
for (const m of unexpected.slice(0, 10)) {
  console.log(`- [${m.field}] ${m.argv.at(-2) ?? ''}\n  ${m.detail.replaceAll('\n', '\n  ')}`);
}
for (const entry of missingExpected)
  console.log(
    `- missing expected ${entry.divergence}: ${entry.invocation} ${JSON.stringify(entry.tests)}`,
  );
process.exitCode = unexpected.length === 0 && missingExpected.length === 0 ? 0 : 1;
