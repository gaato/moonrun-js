import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { compileBytes } from '../../engine/load.ts';
import { type RunOutcome, run, type TestArgs } from '../../engine/run.ts';
import { nodeHost } from './index.ts';

export const VERSION = '0.0.0';
const COMPAT = 'compat moonrun 0.1.20261012 748b63c';

interface Command {
  readonly path: string;
  readonly args: string[];
  readonly noStackTrace: boolean;
  readonly testArgs: string | undefined;
  readonly stackSize: number | undefined;
  readonly policy: string | undefined;
  readonly policySourceDir: string | undefined;
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(['--test-args', '--stack-size', '--policy', '--policy-source-dir']);

/** Mirrors moonrun's clap definition: flags may appear before `--`, args allow hyphen values. */
function parse(argv: readonly string[]): Command | 'version' | 'help' {
  let filePath: string | undefined;
  const args: string[] = [];
  const values = new Map<string, string>();
  let noStackTrace = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--version' || a === '-V') {
      return 'version';
    }
    if (a === '--help' || a === '-h') {
      return 'help';
    }
    if (a === '--no-stack-trace') {
      noStackTrace = true;
      continue;
    }
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(flag)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) {
        throw new UsageError(
          `a value is required for '${flag} <${flag.slice(2).toUpperCase()}>' but none was supplied`,
        );
      }
      values.set(flag, v);
      continue;
    }
    if (filePath === undefined) {
      if (a.startsWith('-') && a !== '-') {
        throw new UsageError(`unexpected argument '${a}' found`);
      }
      filePath = a;
    } else {
      args.push(a);
    }
  }
  if (filePath === undefined) {
    throw new UsageError('the following required arguments were not provided:\n  <PATH>');
  }
  const stackSize = values.get('--stack-size');
  if (values.has('--policy-source-dir') && !values.has('--policy')) {
    throw new UsageError('the following required arguments were not provided:\n  --policy <PATH>');
  }
  return {
    path: filePath,
    args,
    noStackTrace,
    testArgs: values.get('--test-args'),
    stackSize: stackSize === undefined ? undefined : Number.parseInt(stackSize, 10),
    policy: values.get('--policy'),
    policySourceDir: values.get('--policy-source-dir'),
  };
}

/** anyhow's `{:?}` rendering of an error chain, as printed by moonrun's `main`. */
export function formatErrorChain(chain: readonly string[]): string {
  const [head = '', ...causes] = chain;
  let out = `Error: ${head}`;
  if (causes.length === 1) {
    out += `\n\nCaused by:\n${indent(causes[0] ?? '', '    ')}`;
  } else if (causes.length > 1) {
    out += '\n\nCaused by:';
    causes.forEach((cause, i) => {
      out += `\n${indent(`${i}: ${cause}`, '    ', '       ')}`;
    });
  }
  return out;
}

function indent(text: string, first: string, rest: string = first): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first + line : line.length === 0 ? line : rest + line))
    .join('\n');
}

function fail(chain: readonly string[]): never {
  process.stderr.write(`${formatErrorChain(chain)}\n`);
  process.exit(1);
}

async function main(argv: readonly string[]): Promise<number> {
  let command: ReturnType<typeof parse>;
  try {
    command = parse(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(
        `error: ${e.message}\n\nUsage: moonrun-js [OPTIONS] <PATH> [ARGS]...\n\nFor more information, try '--help'.\n`,
      );
      return 2;
    }
    throw e;
  }
  if (command === 'version') {
    process.stdout.write(`moonrun-js ${VERSION} (${COMPAT})\n`);
    return 0;
  }
  if (command === 'help') {
    process.stdout.write('Usage: moonrun-js [OPTIONS] <PATH> [ARGS]...\n');
    return 0;
  }
  if (!existsSync(command.path)) {
    fail(['no such file']);
  }
  if (path.extname(command.path) !== '.wasm') {
    fail(['Unsupported file type']);
  }
  let testArgs: TestArgs | undefined;
  if (command.testArgs !== undefined) {
    try {
      testArgs = JSON.parse(command.testArgs) as TestArgs;
    } catch (e) {
      fail([e instanceof Error ? e.message : String(e)]);
    }
  }
  const bytes = new Uint8Array(readFileSync(command.path));
  const loaded = compileBytes(bytes, command.path, {
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    resolve: (dir, rel) => path.resolve(dir, rel),
    dirname: (p) => path.dirname(p),
  });
  if (!loaded.ok) {
    fail(loaded.error.chain);
  }
  const host = nodeHost({ currentExe: path.resolve(command.path) });
  const outcome: RunOutcome = await run(loaded.value, host, {
    args: command.args,
    testArgs,
    noStackTrace: command.noStackTrace,
  });
  switch (outcome.kind) {
    case 'completed':
      return 0;
    case 'exited':
      return outcome.code;
    case 'guest-failure':
      return 1;
    case 'signaled':
      process.kill(process.pid, outcome.signal);
      return 128 + outcome.signal;
    case 'host-failure':
      fail(outcome.failure.chain);
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
