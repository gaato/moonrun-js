import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeHost } from '../../src/hosts/node/index.ts';
import { compileBytes, type RunOutcome, run } from '../../src/index.ts';
import type { EnvPort } from '../../src/ports/env.ts';
import type { StdioPort } from '../../src/ports/stdio.ts';

const repo = path.resolve(import.meta.dirname, '../..');
const watDir = path.join(repo, 'test/wat');
const cli = path.join(repo, 'bin/moonrun-js');

const hasWasmTools = spawnSync('wasm-tools', ['--version']).status === 0;

/** The real moonrun. `~/.moon/bin/moonrun` may be a moonup shim that adds `MOONUP_*` variables. */
function referenceMoonrun(): string | undefined {
  const candidates = [
    process.env['MOONRUN_REFERENCE'],
    path.join(homedir(), '.moonup/toolchains/latest/bin/moonrun'),
    path.join(homedir(), '.moon/bin/moonrun'),
  ];
  return candidates.find((c) => c !== undefined && c !== '' && existsSync(c));
}
const moonrun = referenceMoonrun();

const scratch = mkdtempSync(path.join(tmpdir(), 'moonrun-js-wasi-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function assemble(name: string): Uint8Array {
  const out = path.join(scratch, `${name}.wasm`);
  const r = spawnSync('wasm-tools', ['parse', path.join(watDir, `${name}.wat`), '-o', out]);
  if (r.status !== 0) {
    throw new Error(`wasm-tools parse ${name}: ${r.stderr.toString()}`);
  }
  return new Uint8Array(readFileSync(out));
}

/**
 * `<base>/root` is the run's working directory; `<base>/outside.txt` lies outside
 * the preopen. Entries are created in a fixed order so raw readdir order repeats.
 */
function layout(base: string, wasm: Uint8Array): string {
  rmSync(base, { recursive: true, force: true });
  const root = path.join(base, 'root');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(base, 'prog.wasm'), wasm);
  writeFileSync(path.join(base, 'outside.txt'), 'outside\n');
  writeFileSync(path.join(root, 'data.txt'), '0123456789\n');
  mkdirSync(path.join(root, 'sub'));
  writeFileSync(path.join(root, 'sub/inner.txt'), 'inner\n');
  mkdirSync(path.join(root, 'rd'));
  writeFileSync(path.join(root, 'rd/f1'), 'x');
  mkdirSync(path.join(root, 'rd/d1'));
  symlinkSync('f1', path.join(root, 'rd/l1'));
  symlinkSync('data.txt', path.join(root, 'link-in'));
  symlinkSync('../outside.txt', path.join(root, 'link-out'));
  symlinkSync('nothing-here', path.join(root, 'dangling'));
  symlinkSync('sub', path.join(root, 'link-dir'));
  mkdirSync(path.join(root, 'full'));
  writeFileSync(path.join(root, 'full/keep'), 'keep\n');
  mkdirSync(path.join(root, 'empty'));
  return root;
}

/** A sorted description of the tree, to compare filesystem effects. */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = path.join(dir, name);
      const rel = prefix + name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        return [`${rel} -> ${readlinkSync(p)}`];
      }
      if (st.isDirectory()) {
        return [`${rel}/`, ...tree(p, `${rel}/`)];
      }
      return [`${rel} = ${JSON.stringify(readFileSync(p, 'utf8'))}`];
    });
}

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

interface Case {
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_ENV = { A: '1', B: 'x=y' };

function capture(stdin: string): StdioPort & { out: Uint8Array[]; err: Uint8Array[] } {
  const input = new TextEncoder().encode(stdin);
  let offset = 0;
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  return {
    out,
    err,
    writeStdout: (b) => out.push(b.slice()),
    writeStderr: (b) => err.push(b.slice()),
    readStdin: (buffer) => {
      const n = Math.min(buffer.length, input.length - offset);
      buffer.set(input.subarray(offset, offset + n));
      offset += n;
      return n;
    },
  };
}

function fixedEnv(vars: Readonly<Record<string, string>>): EnvPort {
  const map = new Map(Object.entries(vars));
  return {
    get: (k) => map.get(k),
    entries: () => [...map],
    set: (k, v) => {
      map.set(k, v);
    },
    unset: (k) => {
      map.delete(k);
    },
  };
}

function exitCode(outcome: RunOutcome): number {
  switch (outcome.kind) {
    case 'completed':
      return 0;
    case 'exited':
      return outcome.code;
    default:
      throw new Error(`unexpected outcome ${JSON.stringify(outcome)}`);
  }
}

const decode = (chunks: readonly Uint8Array[]): string =>
  Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('latin1');

async function runInProcess(name: string, c: Case = {}): Promise<Captured & { tree: string[] }> {
  const wasm = assemble(name);
  const base = path.join(scratch, `${name}-engine`);
  const root = layout(base, wasm);
  const loaded = compileBytes(wasm, '../prog.wasm');
  if (!loaded.ok) {
    throw new Error(loaded.error.chain.join(': '));
  }
  const stdio = capture(c.stdin ?? '');
  const host = { ...nodeHost({ cwd: root }), stdio, env: fixedEnv(c.env ?? DEFAULT_ENV) };
  const outcome = await run(loaded.value, host, { args: c.args ?? [] });
  return {
    stdout: decode(stdio.out),
    stderr: decode(stdio.err),
    exit: exitCode(outcome),
    tree: tree(base),
  };
}

function runBinary(
  command: readonly string[],
  name: string,
  c: Case,
): Captured & { tree: string[] } {
  const wasm = assemble(name);
  // Both runners use the same absolute working directory, recreated in between.
  const base = path.join(scratch, `${name}-diff`);
  const root = layout(base, wasm);
  const [exe = '', ...pre] = command;
  const r = spawnSync(exe, [...pre, '../prog.wasm', '--', ...(c.args ?? [])], {
    cwd: root,
    env: { ...(c.env ?? DEFAULT_ENV) },
    input: c.stdin ?? '',
  });
  return {
    stdout: r.stdout.toString('latin1'),
    stderr: r.stderr.toString('latin1'),
    exit: r.status ?? -1,
    tree: tree(base),
  };
}

const lines = (s: string): string[] => s.split('\n');

type ReaddirCall =
  | { readonly kind: 'rd'; readonly errno: number; readonly bytes: Buffer | undefined }
  | { readonly kind: 'num'; readonly errno: number };

/** Splits wasi-readdir.wat output: `$rd` prints errno, used and the raw bytes; two calls print only errno. */
function parseReaddirDumps(out: Buffer): ReaddirCall[] {
  let at = 0;
  const line = (): number => {
    const end = out.indexOf('\n', at);
    const n = Number(out.subarray(at, end).toString());
    at = end + 1;
    return n;
  };
  const calls: ReaddirCall[] = [];
  for (let i = 0; at < out.length; i++) {
    const errno = line();
    if (i === 16 || i === 17) {
      calls.push({ kind: 'num', errno });
      continue;
    }
    const used = line();
    const bytes = errno === 0 ? out.subarray(at, at + used) : undefined;
    at += errno === 0 ? used : 0;
    calls.push({ kind: 'rd', errno, bytes });
  }
  return calls;
}

/** `d_next:d_type:name` for each complete dirent. */
function dirents(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let at = 0; at + 24 <= bytes.length; ) {
    const len = bytes.readUInt32LE(at + 16);
    expect(bytes.readBigUInt64LE(at + 8)).toBe(0n);
    out.push(
      `${bytes.readBigUInt64LE(at)}:${bytes[at + 20] ?? -1}:${bytes.toString('latin1', at + 24, at + 24 + len)}`,
    );
    at += 24 + len;
  }
  return out;
}

const CASES: Readonly<Record<string, readonly Case[]>> = {
  'wasi-args-env': [{ args: ['foo', 'bär baz'] }],
  'wasi-stdio': [{ stdin: 'The quick brown fox jumps\n' }],
  'wasi-open': [{}],
  'wasi-paths': [{}],
  'wasi-readdir': [{}],
  'wasi-start': [{}],
  'wasi-nomem': [{}],
  'wasi-exit-start': [{}],
  'wasi-exit': ['7', '-1', '0', '256', '2147483647', '-2147483648'].map((n) => ({ args: [n] })),
};

describe.skipIf(!hasWasmTools)('wasi_snapshot_preview1 (engine)', () => {
  it('passes argv and the run environment', async () => {
    const r = await runInProcess('wasi-args-env', { args: ['foo', 'bär baz'] });
    expect(lines(Buffer.from(r.stdout, 'latin1').toString('utf8'))).toEqual([
      ...['0', '3', '26', '0', '../prog.wasm', 'foo', 'bär baz'],
      ...['0', '2', '10', '0', 'A=1', 'B=x=y'],
      // args_sizes_get faults; argc is written before the size pointer faults
      ...['21', '21', '3'],
      // args_get faults on the second slot after copying the first string
      ...['21', '../prog.wasm'],
      ...['21', '21'],
      // random_get: ok, straddling fault, empty at the end, empty past the end
      ...['0', '21', '0', '21'],
      '',
    ]);
    expect(r.exit).toBe(0);
  });

  it('writes and reads the standard streams', async () => {
    const r = await runInProcess('wasi-stdio', { stdin: 'The quick brown fox jumps\n' });
    expect(r.stderr).toBe('err!\n');
    expect(lines(r.stdout)).toEqual([
      ...['hello world', '0', '12', '0', '5'],
      ...['76', '76', '8', '8'],
      ...['21', 'hello 21', '0', '0', '21', 'hello world', '21', '0', '0'],
      ...['0', '26', 'The quick brown fox jumps', '0', '0'],
      ...['76', '76', '76', '8', '0', '21', 'hello '],
    ]);
  });

  it('opens files inside the preopen only', async () => {
    const r = await runInProcess('wasi-open');
    expect(lines(r.stdout)).toEqual([
      // flags and rights validation, then descriptor checks, then the path
      ...['28', '28', '28', '58', '58', '28', '28', '8', '76', '76', '28', '21'],
      // read-only data.txt as fd 4
      ...['0', '4', '0', '11', '0123456789', '0', '0', '76', '-1'],
      // ../, absolute, sub/../ (fd 5), symlinks, dangling, link-dir, trailing slash on a file
      ...['76', '76', '0', '5', '32', '0', '6', '76', '76', '76', '76', '0', '7', '32', '54'],
      // create (fd 8), exclusive, missing parent, missing file
      ...['0', '8', '0', '3', '20', '44', '44'],
      // OpenOptions EINVAL cases, append (fd 9), truncate (fd 10), write-only read
      ...['28', '28', '0', '9', '0', '3', '0', '10', '0', '1', '76', '0'],
      // directories: sub (fd 11), not a dir, DIRECTORY with CREAT/EXCL, with TRUNC
      ...['0', '11', '54', '28', '28'],
      // via the sub fd (fd 12), escaping it, reading/writing the directory fd
      ...['0', '12', '0', '6', 'inner', '76', '8', '0', '8', '-1'],
      // empty path: as a directory (fd 13), as a file (fd 14) reading EISDIR
      ...['0', '13', '0', '14', '31', '0'],
      // a file fd with every right (fd 15) used as a directory
      ...['0', '15', '8'],
      // sub without inheritable rights (fd 16)
      ...['0', '16', '76', '0', '17'],
      // the fault on the result pointer consumed fd 18
      ...['21', '0', '19'],
      ...['0', '8', '0', '8', '8', '8', '8', '8', '0'],
      // the next fd is 20, not a reused one
      ...['0', '20'],
      // prestat
      ...['0', '0', '1', '8', '8', '21', '0', '.***37', '8', '21', '0'],
      '',
    ]);
  });

  it('creates, removes, renames and reads links', async () => {
    const r = await runInProcess('wasi-paths');
    expect(lines(r.stdout)).toEqual([
      ...['0', '20', '76', '76', '76', '76', '76', '76', '44', '76', '8', '21', '20', '54'],
      ...['55', '54', '0', '44', '0', '54', '76', '76'],
      ...['31', '44', '0', '76', '76'],
      ...['0', '44', '76', '76', '76', '76', '0', '55', '0', '21'],
      ...['0', '8', 'data.txt', '0', '3', 'dat', '0', '12', 'nothing-here'],
      ...['28', '44', '21', '44', '76', '76', '21'],
      '',
    ]);
    expect(r.tree).toContain('root/inner-moved.txt = "inner\\n"');
    expect(r.tree).not.toContain('root/link-out -> ../outside.txt');
    expect(r.tree).toContain('outside.txt = "outside\\n"');
  });

  it('lists directories with cookies and truncated dirents', async () => {
    const r = await runInProcess('wasi-readdir');
    const calls = parseReaddirDumps(Buffer.from(r.stdout, 'latin1'));
    const first = calls[0];
    const all = first?.kind === 'rd' ? (first.bytes ?? Buffer.alloc(0)) : Buffer.alloc(0);
    expect(first?.errno).toBe(0);
    const entries = dirents(all);
    // "." and ".." come first; the rest is in raw OS order with d_next = index + 1.
    expect(entries.slice(0, 2)).toEqual(['1:3:.', '2:3:..']);
    expect(
      entries
        .slice(2)
        .map((e) => e.replace(/^\d+:/, ''))
        .sort(),
    ).toEqual(['3:d1', '4:f1', '7:l1']);
    expect(entries.slice(2).map((e) => e.split(':')[0])).toEqual(['3', '4', '5']);
    expect(all.length).toBe(24 * 5 + 1 + 2 + 2 + 2 + 2);
    const at = (i: number): number => {
      let offset = 0;
      for (const e of entries.slice(0, i)) {
        offset += 24 + (e.split(':')[2]?.length ?? 0);
      }
      return offset;
    };
    const expected = [
      [0, all],
      [0, all.subarray(0, 1)],
      [0, all.subarray(0, 24)],
      [0, all.subarray(0, 25)],
      [0, all.subarray(0, 30)],
      [0, Buffer.alloc(0)],
      [0, all.subarray(at(1))],
      [0, all.subarray(at(2))],
      [0, all.subarray(at(4))],
      [0, Buffer.alloc(0)],
      [0, Buffer.alloc(0)],
      [0, Buffer.alloc(0)],
      [0, Buffer.alloc(0)],
      [76, undefined],
      [8, undefined],
      [8, undefined],
      [21],
      [21],
      [76, undefined],
    ];
    expect(calls.map((c) => [c.errno, ...(c.kind === 'num' ? [] : [c.bytes])])).toEqual(expected);
  });

  it('faults memory imports called from the start function', async () => {
    const r = await runInProcess('wasi-start');
    expect(lines(r.stdout)).toEqual(['21', '21', '8', '21', '21', '21', '21', '8', '0', '']);
  });

  it('faults without exported memory', async () => {
    expect((await runInProcess('wasi-nomem')).exit).toBe(37);
  });

  it('exits from the start function', async () => {
    const r = await runInProcess('wasi-exit-start');
    expect(r).toMatchObject({ exit: 3, stdout: '' });
  });

  it('maps proc_exit codes like moonrun', async () => {
    const codes: number[] = [];
    for (const n of ['7', '-1', '256', '-2147483648']) {
      const r = await runInProcess('wasi-exit', { args: [n] });
      expect(r).toMatchObject({ stdout: 'bye', stderr: 'err' });
      codes.push(r.exit);
    }
    expect(codes).toEqual([7, 1, 256, 1]);
  });
});

describe.skipIf(!hasWasmTools || moonrun === undefined)(
  'wasi_snapshot_preview1 (vs moonrun)',
  () => {
    for (const [name, cases] of Object.entries(CASES)) {
      cases.forEach((c, i) => {
        it(`${name} #${i}`, () => {
          const expected = runBinary([moonrun ?? ''], name, c);
          const actual = runBinary([process.execPath, cli], name, c);
          expect(actual).toEqual(expected);
        });
      });
    }
  },
);
