import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadRunPolicy } from '../../src/hosts/node/policy-loader.ts';

/** Same rendering as anyhow's `{:?}` for an error chain, as `main` prints it. */
function anyhow(chain: readonly string[]): string {
  const [head = '', ...causes] = chain;
  const indent = (text: string, first: string, rest: string): string =>
    text
      .split('\n')
      .map((line, i) => (i === 0 ? first + line : rest + line))
      .join('\n');
  let out = `Error: ${head}`;
  if (causes.length === 1) {
    out += `\n\nCaused by:\n${indent(causes[0] ?? '', '    ', '    ')}`;
  } else if (causes.length > 1) {
    out += '\n\nCaused by:';
    causes.forEach((cause, i) => {
      out += `\n${indent(cause, `    ${i}: `, '       ')}`;
    });
  }
  return `${out}\n`;
}

const reference = ((): string | undefined => {
  const p =
    process.env['MOONRUN_REFERENCE'] ??
    path.join(homedir(), '.moonup/toolchains/latest/bin/moonrun');
  return existsSync(p) ? p : undefined;
})();

const dir = mkdtempSync(path.join(tmpdir(), 'policy-diff-'));
mkdirSync(path.join(dir, 'allowed'));
writeFileSync(path.join(dir, 'e.wasm'), Buffer.from('0061736d01000000', 'hex'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const JSON_CASES = [
  '{"fs":{"read":["nope"]}}',
  '{"x":1}',
  '{"fs":',
  '{"net":{"bind":["localhost:80"]}}',
  '{"net":{"connect":["::1:80"]}}',
  '{"process":{"spawn":true,"allow":[{"program":"a"}]}}',
  '{"process":{"allow":[{"program":"","args_prefix":[]}]}}',
  '{"process":{"allow":[{"program":"a\\u0000"}]}}',
  '{"process":{"allow":[{"program":"a","args_prefix":["b\\u0000"]}]}}',
  '{"env":{"from_host":["A","A"]}}',
  '{"env":{"required_from_host":["ZZZ_MISSING"]}}',
  '{"env":{"set":{"A=B":"x"}}}',
  '{"env":{"set":{"A":"x\\u0000"}}}',
  '',
  '[]',
  '{"fs":{"read":"x"}}',
  '{"fs":null}',
  '{"net":{"dns":[""]}}',
  '{"net":{"dns":["*."]}}',
  '{"net":{"connect":["a:b"]}}',
  '{"net":{"connect":["a:70000"]}}',
  '{"net":{"connect":["a:"]}}',
  '{"net":{"connect":["a"]}}',
  '{"net":{"connect":["[::1]"]}}',
  '{"net":{"connect":["[]:1"]}}',
  '{"fs":{"read":[1]}}',
  '{"fs":{"read":{}}}',
  '{"fs":{"read":[]},"fs":{}}',
  '{"process":{"allow":[{}]}}',
  '{"process":{"allow":[{"program":"a"}]}',
  '{"process":{"allow":[{"program":null}]}}',
  '{"process":{"spawn":null}}',
  '{"process":{"spawn":1}}',
  '{"process":{"spawn":1.5}}',
  '{"process":{"spawn":-1}}',
  '{"process":{"spawn":"x"}}',
  '{"process":[true]}',
  '{"fs":[[],[],[]]}',
  '{"fs":[["a"]]}',
  '[null,null,null,null]',
  '[null,null,null,null,1]',
  '[null,null]',
  '{"env":{"set":{"A":1}}}',
  '{"env":{"set":[]}}',
  '{"env":{"set":{"A":"x","A":"y"}}}',
  '{"net":{"dns":["a"],}}',
  '{"net":{"dns":["a",]}}',
  '{} x',
  '{"a" 1}',
  '{1:2}',
  '{"fs":{"read":["a\\q"]}}',
  "{'a':1}",
  '{"fs":{"read":[01]}}',
  '{"fs":{"read":[1e999]}}',
  '{"fs":{"read":[tru]}}',
  '{"fs":\n {"read":[nul]}}',
  '{"fs":{"read":["a\nb"]}}',
  '{"fs":{"read":["\\ud800"]}}',
  '{"fs":{"read":["\\udc00"]}}',
  '{"fs":{"read":["\\ud800\\u0041"]}}',
  '{"fs":{"read":["\\ud800\\x"]}}',
  '{"fs":{"read":["\\u00zz"]}}',
  '{"fs":{"read":"é",}}',
  '{"fs":"é"}',
  '"x"',
  '3',
  'null',
  'true',
  '{"x":',
  '{"fs"',
  '{"fs":{',
  '{"fs":{"read":[',
  '{"fs":{"read":["a',
  '{"fs":{"read":[-]}}',
  '{"fs":{"read":[1.]}}',
  '{"fs":{"read":[1e]}}',
  '{"fs":{"read":[+1]}}',
  '{"fs":{"read":[1.5e3]}}',
  '{"fs":{"read":[18446744073709551616]}}',
  '{"fs":{"read":[-9223372036854775809]}}',
  '{"fs":{"read":[-0]}}',
  '{"fs":{"read":[1.0]}}',
  '{"fs":{"read":[100000000000000000000]}}',
  '{"fs":{"read":["a" "b"]}}',
  '{"fs":{"read":["a" , , ]}}',
  '{"fs":{"read":}}',
  '{"fs":{"read" 1}}',
  '{"fs":{"read":[1}}',
  '{"fs":{"read":["a"}}',
  '{"fs":{"read":[]}]',
  '{"net":{"dns":[{}]}}',
  '{"net":{"dns":[null]}}',
  '{"net":{"dns":[false]}}',
  '{"process":{"allow":[[]]}}',
  '{"process":{"allow":[["git",1]]}}',
  '{"process":{"allow":[1]}}',
  '{"process":{"allow":[{"program":"a","x":1}]}}',
  '{"process":{"allow":[{"program":"a","program":"b"}]}}',
  '{"process":{"allow":[{"args_prefix":["a"]}]}}',
  '{"fs":{"read":["allowed"],"write":["allowed"]},"net":{"dns":["*.Example.com."],"connect":["a.b:443","[::1]:*","*:80"],"bind":["127.0.0.1:0","*:*"]},"process":{"allow":[{"program":"git"}]}}',
];

const TOML_CASES = [
  '[env]\nunknown = ["APP_ENV"]',
  'fs = 3',
  '[fs',
  '[process]\nspawn = "yes"',
  '[[process.allow]]\nargs_prefix = ["a"]\n',
  '[fs]\nread = "x"\n',
  '[fs]\nread = [1, 2]\n',
  'fs.read = ["a",\n  3]\n',
  '[env.set]\nA = 1\n',
  '[env]\nset = ["a"]\n',
  'x = 1\n',
  '[fs]\n[fs]\n',
  'a = \n',
  'a = 1\na = 2\n',
  '[process]\nspawn = true\nspawn = false\n',
  '[process]\nallow = [{program = "git", bogus = 1}]\n',
  'x = "abc\n',
  '[env.set]\nA = 2026-01-01\n',
  '[process]\nspawn = tru\n',
  '[[fs]]\n',
  '[process]\nallow = {program="git"}\n',
  'a\n',
  'a = 1 2\n',
  '[fs]\nread = [\n',
  '[fs]\nread = ["a"\n',
  '[fs]\nread = ["a",, "b"]\n',
  'a = 01\n',
  '[]\n',
  '[fs] x\n',
  '= 1\n',
  'a = "\\q"\n',
  "a = 'abc\n",
  'a = [1,\n',
  'a = 1.\n',
  'a = .5\n',
  '[a]\nb = 1\n[a.b]\n',
  'a.b = 1\n[a]\n',
  'a = 1\n[a]\n',
  '[[a]]\n[a]\n',
  'a = {b = 1, b = 2}\n',
  'a = 1e\n',
  'a = 5 =\n',
  'fs = {read = ["a"], write = 1}\n',
  'fs.read = "a"\n',
  '[fs.read]\nx=1\n',
  '[process]\nallow=[[]]\n',
  '[process]\nallow=[1]\n',
  '[process]\nallow=[["git"]]\n',
  '[fs]\nread = ["allowed"]\nwrite = ["allowed"]\n\n[net]\nconnect = ["a.b:443"]\n\n[[process.allow]]\nprogram = "git"\nargs_prefix = ["status"]\n',
  '# only a comment\n',
  '',
];

describe.skipIf(reference === undefined)('policy loading matches the reference moonrun', () => {
  const run = (name: string, content: string): void => {
    writeFileSync(path.join(dir, name), content);
    const real = spawnSync(reference ?? '', ['--policy', name, 'e.wasm'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const here = process.cwd();
    process.chdir(dir);
    let mine: string;
    try {
      const loaded = loadRunPolicy({ policyPath: name, env: { ...process.env } });
      mine = loaded.ok ? '' : anyhow(loaded.error.chain);
    } finally {
      process.chdir(here);
    }
    // A policy that loads then runs an empty module; only load failures are compared.
    const realFailure = real.stderr.startsWith('Error: failed to load') ? real.stderr : '';
    expect(mine).toBe(realFailure);
  };
  it.each(JSON_CASES.map((c, i) => [i, c] as const))('json case %i', (i, content) => {
    run(`case-${i}.json`, content);
  });
  it.each(TOML_CASES.map((c, i) => [i, c] as const))('toml case %i', (i, content) => {
    run(`case-${i}.toml`, content);
  });
});
