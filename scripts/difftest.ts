// Differential test: runs a case with the real moonrun and with bin/moonrun-js, each in a
// freshly created working directory, and compares stdout, stderr, exit status and the
// resulting directory tree.
//
//   node scripts/difftest.ts <cases.json | '{"wasm":{...}}'> [--filter text] [--list]
//                            [--allow-pending] [--pending a,b] [-v] [--json out.json]
//
// A case file is `[case...]` or `{ "wasms": { name: spec }, "seeds": { name: [{from,to}] },
// "cases": [case...] }`.
//
//   case = { id, area?, source?, note?, divergences?: ["D4"],
//            wasm: <name in "wasms"> | spec,
//            argv?: ["<wasm>"],        // everything after the runner, default just the module
//            stdin?, env?, unsetEnv?,
//            dirs?: [path], files?: { path: text }, seed?: [{ from, to }],
//            signal?: { onStdout: text, signal: "SIGINT" }, timeoutMs? }
//   spec = { wat, vars? } | { text } | { path }
//        | { moon: { project, target?, command?, env?, artifact } }
//
// Strings in argv/env/files may use <cwd>, <wasm> and <moonrun> (the reference binary). `\xNN` in argv, env values and
// seed targets is a raw byte (non-UTF-8 names). `seed.from` is relative to the repo root.
//
// Only differences listed in docs/divergences.md are normalized (D1: wasm://wasm/<hash>),
// plus the run's own pid and the temp working directory path.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
// The toolchain binary, not ~/.moon/bin/moonrun: the moonup shim adds variables to the child env.
const reference =
  process.env['MOONRUN_REFERENCE'] ?? path.join(homedir(), '.moonup/toolchains/latest/bin/moonrun');
const cache = path.join(repoRoot, '.cache', 'conformance');

/** Areas of moonrun that moonrun-js has not implemented yet; mismatches there are "pending". */
const DEFAULT_PENDING = [
  'async-kernel',
  'sockets',
  'tls',
  'process',
  'signals',
  'sqlite',
  'policy',
  'stack-size',
];

interface MoonSpec {
  readonly project: string;
  readonly target?: string;
  readonly command?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly artifact: string;
}
type WasmSpec =
  | { readonly wat: string; readonly vars?: Readonly<Record<string, string>> }
  | { readonly text: string }
  | { readonly path: string }
  | { readonly moon: MoonSpec };

export interface Case {
  readonly id: string;
  readonly area?: string;
  readonly source?: string;
  readonly note?: string;
  readonly divergences?: readonly string[];
  readonly wasm: string | WasmSpec;
  readonly argv?: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
  readonly dirs?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly seed?: string | readonly SeedEntry[];
  readonly signal?: { readonly onStdout: string; readonly signal: NodeJS.Signals };
  readonly timeoutMs?: number;
}
interface SeedEntry {
  readonly from: string;
  readonly to: string;
}
interface CaseFile {
  readonly wasms?: Readonly<Record<string, WasmSpec>>;
  readonly seeds?: Readonly<Record<string, readonly SeedEntry[]>>;
  readonly cases: readonly Case[];
}

// ---------------------------------------------------------------- building wasm

const built = new Map<string, string>();

function sh(cmd: string, args: readonly string[], cwd: string, env?: Record<string, string>) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${r.stdout}${r.stderr}`);
  }
}

function asyncCheckout(): string {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'upstream.lock.json'), 'utf8')) as {
    async: { commit: string };
  };
  const dir = path.join(repoRoot, '.cache', 'upstream', 'async');
  if (!existsSync(dir)) {
    const source = path.join(homedir(), 'ghq/github.com/moonbitlang/async');
    execFileSync('git', ['clone', '--quiet', source, dir]);
  }
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', lock.async.commit]);
  return dir;
}

function buildMoon(spec: MoonSpec): string {
  const tag = spec.env === undefined ? '' : `-${hash(JSON.stringify(spec.env))}`;
  const root = path.join(cache, 'mbt', spec.project.replaceAll('/', '_') + tag);
  const source = path.resolve(repoRoot, 'test/conformance/mbt', spec.project);
  mkdirSync(root, { recursive: true });
  cpSync(source, root, { recursive: true, force: true });
  if (readFileSync(path.join(root, 'moon.mod'), 'utf8').includes('moonbitlang/async')) {
    // Upstream projects point their workspace at a vendored copy; use the pinned checkout.
    writeFileSync(
      path.join(root, 'moon.work'),
      `members = [".", ${JSON.stringify(asyncCheckout())}]\n`,
    );
  }
  const command = spec.command ?? ['build', '--target', spec.target ?? 'wasm'];
  sh('moon', command, root, spec.env as Record<string, string> | undefined);
  return path.join(root, spec.artifact);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function buildWasm(spec: WasmSpec): string {
  const key = JSON.stringify(spec);
  const hit = built.get(key);
  if (hit !== undefined) {
    return hit;
  }
  let out: string;
  if ('path' in spec) {
    out = path.resolve(repoRoot, spec.path);
  } else if ('moon' in spec) {
    out = buildMoon(spec.moon);
  } else if ('text' in spec) {
    out = path.join(cache, 'wasm', `text-${hash(spec.text)}.wasm`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, spec.text);
  } else {
    let wat = readFileSync(path.resolve(repoRoot, spec.wat), 'utf8');
    for (const [k, v] of Object.entries(spec.vars ?? {})) {
      wat = wat.replaceAll(`{{${k}}}`, v);
    }
    const stem = path.basename(spec.wat, '.wat');
    const watFile = path.join(cache, 'wasm', `${stem}-${hash(wat)}.wat`);
    out = watFile.replace(/\.wat$/, '.wasm');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(watFile, wat);
    sh('wasm-tools', ['parse', watFile, '-o', out], repoRoot);
  }
  built.set(key, out);
  return out;
}

// ---------------------------------------------------------------- running

/** Text with `\xNN` escapes to bytes. */
function bytesOf(text: string): Buffer {
  const parts: Buffer[] = [];
  let last = 0;
  for (const m of text.matchAll(/\\x([0-9a-fA-F]{2})/g)) {
    parts.push(
      Buffer.from(text.slice(last, m.index)),
      Buffer.from([Number.parseInt(m[1] ?? '', 16)]),
    );
    last = m.index + m[0].length;
  }
  parts.push(Buffer.from(text.slice(last)));
  return Buffer.concat(parts);
}

/** bash `$'...'` quoting of arbitrary bytes. */
function quote(bytes: Buffer): string {
  let out = "$'";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9_./=:,+@%-]/.test(c) ? c : `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return `${out}'`;
}

interface Vars {
  readonly cwd: string;
  readonly wasm: string;
  readonly moonrun: string;
}
const subst = (s: string, v: Vars): string =>
  s.replaceAll('<cwd>', v.cwd).replaceAll('<wasm>', v.wasm).replaceAll('<moonrun>', v.moonrun);

function prepare(dir: string, c: Case, v: Vars): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const at = (rel: string): Buffer => Buffer.concat([Buffer.from(`${dir}/`), bytesOf(rel)]);
  for (const d of c.dirs ?? []) {
    mkdirSync(at(d), { recursive: true });
  }
  for (const [name, text] of Object.entries(c.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(at(name), subst(text, v));
  }
  for (const s of typeof c.seed === 'string' ? [] : (c.seed ?? [])) {
    const to = at(s.to);
    mkdirSync(to.subarray(0, to.lastIndexOf('/')), { recursive: true });
    const from = path.resolve(repoRoot, subst(s.from, v));
    if (lstatSync(from).isDirectory()) {
      cpSync(from, to.toString(), { recursive: true });
    } else {
      copyFileSync(from, to);
    }
  }
}

interface Outcome {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: string;
  readonly tree: string;
  readonly pid: number;
  readonly elapsedMs: number;
}

function tree(dir: Buffer, prefix = ''): string[] {
  return readdirSync(dir, { encoding: 'buffer' })
    .sort(Buffer.compare)
    .flatMap((name) => {
      const full = Buffer.concat([dir, Buffer.from('/'), name]);
      const rel = prefix + name.toString('latin1');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        return [`${rel} -> ${readlinkSync(full)}`];
      }
      if (st.isDirectory()) {
        return [`${rel}/`, ...tree(full, `${rel}/`)];
      }
      return [`${rel} = ${hash(readFileSync(full).toString('latin1'))} (${st.size} bytes)`];
    });
}

function execute(runner: string, c: Case, wasm: string, dir: string): Promise<Outcome> {
  const v: Vars = { cwd: dir, wasm, moonrun: reference };
  prepare(dir, c, v);
  const envArgs = [
    ...(c.unsetEnv ?? []).flatMap((k) => ['-u', k]),
    'RUST_BACKTRACE=0',
    ...Object.entries(c.env ?? {}).map(([k, val]) => `${k}=${val}`),
  ];
  const argv = (c.argv ?? ['<wasm>']).map((a) => bytesOf(subst(a, v)));
  const cmd = [
    'exec',
    'env',
    ...envArgs.map((a) => quote(bytesOf(subst(a, v)))),
    quote(Buffer.from(runner)),
    ...argv.map(quote),
  ].join(' ');
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { cwd: dir, detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let seen = '';
    let signalled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // already gone
      }
    }, c.timeoutMs ?? 30_000);
    child.stdout.on('data', (b: Buffer) => {
      out.push(b);
      seen += b.toString('latin1');
      if (c.signal !== undefined && !signalled && seen.includes(c.signal.onStdout)) {
        signalled = true;
        child.kill(c.signal.signal);
      }
    });
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.stdin.on('error', () => undefined);
    child.stdin.end(c.stdin ?? '');
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        status: timedOut ? 'timeout' : signal !== null ? `signal ${signal}` : `exit ${code}`,
        tree: tree(Buffer.from(dir)).join('\n'),
        pid: child.pid ?? 0,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

// ---------------------------------------------------------------- comparing

/** Normalizes docs/divergences.md D1 plus this run's pid and temp directory. */
function normalize(o: Outcome, dir: string, b: Buffer): string {
  return b
    .toString('latin1')
    .replaceAll(dir, '<cwd>')
    .replace(/wasm:\/\/wasm\/[0-9a-f]+/g, 'wasm://wasm/<D1>')
    .replace(new RegExp(`(?<![0-9])${o.pid}(?![0-9])`, 'g'), '<pid>');
}

function firstDifference(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      const show = (s: string | undefined): string =>
        s === undefined ? '<end>' : JSON.stringify(Buffer.from(s, 'latin1').toString('utf8'));
      return `line ${i + 1}: moonrun ${show(al[i])}\n        moonrun-js ${show(bl[i])}`;
    }
  }
  return '';
}

interface Verdict {
  readonly id: string;
  readonly cls: 'identical' | 'known' | 'pending' | 'mismatch';
  readonly fields: string[];
  readonly details: string[];
}

function compare(c: Case, dir: string, ref: Outcome, js: Outcome, pending: Set<string>): Verdict {
  const fields: string[] = [];
  const details: string[] = [];
  // D5: the program names itself moonrun-js in usage and version texts.
  const programName = (s: string): string =>
    (c.divergences ?? []).includes('D5') ? s.replaceAll('Usage: moonrun-js ', 'Usage: moonrun ') : s;
  const text = (name: 'stdout' | 'stderr'): void => {
    const a = normalize(ref, dir, ref[name]);
    const b = programName(normalize(js, dir, js[name]));
    if (a !== b) {
      fields.push(name);
      details.push(`${name}: ${firstDifference(a, b)}`);
    }
  };
  text('stdout');
  text('stderr');
  if (ref.status !== js.status) {
    fields.push('status');
    details.push(`status: moonrun ${ref.status}, moonrun-js ${js.status}`);
  }
  if (ref.tree !== js.tree) {
    fields.push('tree');
    details.push(`tree: ${firstDifference(ref.tree, js.tree)}`);
  }
  let cls: Verdict['cls'] = 'identical';
  if (fields.length > 0) {
    if ((c.divergences ?? []).some((d) => d !== 'D5')) {
      cls = 'known';
    } else if (c.divergences?.includes('D5') === true && c.area === 'cli-identity') {
      cls = 'known';
    } else if (c.area !== undefined && pending.has(c.area)) {
      cls = 'pending';
    } else {
      cls = 'mismatch';
    }
  }
  return { id: c.id, cls, fields, details };
}

// ---------------------------------------------------------------- main

function loadCases(arg: string): Case[] {
  const raw =
    arg.trimStart().startsWith('{') || arg.trimStart().startsWith('[')
      ? arg
      : readFileSync(path.resolve(arg), 'utf8');
  const parsed = JSON.parse(raw) as CaseFile | Case[] | Case;
  const file: CaseFile = Array.isArray(parsed)
    ? { cases: parsed }
    : 'cases' in parsed
      ? parsed
      : { cases: [parsed] };
  const wasms = file.wasms ?? {};
  return file.cases
    .map((c) => {
      if (typeof c.wasm !== 'string') {
        return c;
      }
      const spec = wasms[c.wasm];
      if (spec === undefined) {
        throw new Error(`${c.id}: unknown wasm "${c.wasm}"`);
      }
      return { ...c, wasm: spec };
    })
    .map((c) => {
      if (typeof c.seed !== 'string') {
        return c;
      }
      const seed = file.seeds?.[c.seed];
      if (seed === undefined) {
        throw new Error(`${c.id}: unknown seed set "${c.seed}"`);
      }
      return { ...c, seed };
    });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const input = argv.find((a) => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '--filter');
  const option = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (input === undefined || argv.includes('--help')) {
    console.error(
      "usage: node scripts/difftest.ts <cases.json|'{json}'> [--filter text] [--list] [--allow-pending] [--pending a,b] [-v] [--json out]",
    );
    return 2;
  }
  const filter = option('--filter');
  const pending = new Set((option('--pending') ?? DEFAULT_PENDING.join(',')).split(','));
  const verbose = argv.includes('-v');
  const cases = loadCases(input).filter((c) => filter === undefined || c.id.includes(filter));
  if (argv.includes('--list')) {
    for (const c of cases) {
      console.log(`${c.id}\t${c.area ?? ''}\t${c.source ?? ''}`);
    }
    return 0;
  }
  const candidate = path.join(repoRoot, 'bin/moonrun-js');
  // One scratch directory per case; both runners get it freshly recreated.
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'moonrun-difftest-')));
  const verdicts: Verdict[] = [];
  for (const c of cases) {
    let verdict: Verdict;
    try {
      const wasm = buildWasm(c.wasm as WasmSpec);
      const dir = path.join(scratch, c.id.replace(/[^A-Za-z0-9_.-]/g, '_'));
      const ref = await execute(reference, c, wasm, dir);
      const js = await execute(candidate, c, wasm, dir);
      verdict = compare(c, dir, ref, js, pending);
      if (verbose && verdict.cls === 'identical') {
        verdict.details.push(
          `${ref.status}, stdout ${ref.stdout.length}B, stderr ${ref.stderr.length}B; ${ref.elapsedMs}ms / ${js.elapsedMs}ms`,
        );
      }
    } catch (error) {
      verdict = { id: c.id, cls: 'mismatch', fields: ['setup'], details: [String(error)] };
    }
    const label = { identical: 'ok  ', known: 'KNOWN', pending: 'PEND', mismatch: 'FAIL' }[
      verdict.cls
    ];
    const tag = c.area === undefined ? '' : ` [${c.area}]`;
    const fields = verdict.fields.length > 0 ? ` (${verdict.fields.join(', ')})` : '';
    console.log(`${label} ${c.id}${tag}${fields}`);
    if (verdict.cls !== 'identical' || verbose) {
      for (const d of verdict.details) {
        console.log(`       ${d.replaceAll('\n', '\n       ')}`);
      }
    }
    verdicts.push(verdict);
  }
  rmSync(scratch, { recursive: true, force: true });
  const count = (k: Verdict['cls']): number => verdicts.filter((x) => x.cls === k).length;
  console.log(
    `\n${verdicts.length} cases: ${count('identical')} identical, ${count('known')} known divergence, ${count('pending')} pending, ${count('mismatch')} mismatch`,
  );
  const out = option('--json');
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(verdicts, null, 2));
  }
  const failing = count('mismatch') + (argv.includes('--allow-pending') ? 0 : count('pending'));
  return failing === 0 ? 0 : 1;
}

process.exitCode = await main();
