import { existsSync, readFileSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { osCapabilities } from '../../abi/os-capabilities.ts';
import { PolicyComponent } from '../../domains/policy/component.ts';
import { POLICY_URL } from '../../domains/policy/policy-url.ts';
import { compileBytes } from '../../engine/load.ts';
import { type RunOutcome, run, type TestArgs } from '../../engine/run.ts';
import { colorEnabled, parseArgs } from './cli-args.ts';
import { nodeComponentModule, nodeDiagnostics } from './components.ts';
import { nodeHost } from './index.ts';
import { takeInheritedPolicy } from './policy-loader.ts';

export const VERSION = '0.0.0';
const COMPAT = 'compat moonrun 0.1.20261012 748b63c';

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
    .map((line, i) => (i === 0 ? first + line : rest + line))
    .join('\n');
}

function fail(chain: readonly string[]): never {
  writeSync(2, `${formatErrorChain(chain)}\n`);
  process.exit(1);
}

/**
 * Raw argv bytes after the script, from /proc/self/cmdline: `process.argv` replaces
 * invalid UTF-8 with U+FFFD, but clap and moonrun see the raw bytes.
 */
function rawArgs(count: number): Buffer[] | undefined {
  try {
    const parts = readFileSync('/proc/self/cmdline').subarray(0, -1);
    const all: Buffer[] = [];
    let start = 0;
    for (let i = 0; i <= parts.length; i++) {
      if (i === parts.length || parts[i] === 0) {
        all.push(parts.subarray(start, i));
        start = i + 1;
      }
    }
    return all.length >= count ? all.slice(all.length - count) : undefined;
  } catch {
    return undefined;
  }
}

/** Rust `std::path::absolute` on Unix: joins the cwd but keeps `..` (no normalization beyond `.` and repeated `/`). */
function rustAbsolute(raw: Buffer): Uint8Array {
  const joined =
    raw[0] === 0x2f ? raw : Buffer.concat([Buffer.from(process.cwd()), Buffer.from('/'), raw]);
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= joined.length; i++) {
    if (i === joined.length || joined[i] === 0x2f) {
      const part = joined.subarray(start, i);
      if (part.length > 0 && !(part.length === 1 && part[0] === 0x2e)) {
        parts.push(part);
      }
      start = i + 1;
    }
  }
  const trailing =
    joined.length > 1 && joined[joined.length - 1] === 0x2f ? [Buffer.from('/')] : [];
  return Buffer.concat(parts.flatMap((p) => [Buffer.from('/'), p]).concat(trailing));
}

const decoder = new TextDecoder();

async function main(argv: readonly string[]): Promise<number> {
  // moonrun takes the inherited policy before clap parses (main.rs:96-98); its errors are bare.
  const inherited = takeInheritedPolicy(process.env);
  if (!inherited.ok) {
    fail(inherited.error.chain);
  }
  const command = parseArgs(rawArgs(argv.length) ?? argv.map((a) => Buffer.from(a)), {
    version: `${VERSION} (${COMPAT})`,
    color: {
      stdout: colorEnabled(process.stdout.isTTY === true, process.env),
      stderr: colorEnabled(process.stderr.isTTY === true, process.env),
    },
  });
  if (command.kind === 'exit') {
    writeSync(command.code === 0 ? 1 : 2, command.message);
    return command.code;
  }
  const rawPath = Buffer.from(command.path);
  const name = decoder.decode(command.path);
  if (!existsSync(rawPath)) {
    fail(['no such file']);
  }
  if (path.extname(name) !== '.wasm') {
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
  const bytes = new Uint8Array(readFileSync(rawPath));
  const loaded = compileBytes(bytes, name, nodeDiagnostics());
  if (!loaded.ok) {
    fail(loaded.error.chain);
  }
  const host = nodeHost({ currentExe: rustAbsolute(rawPath) });
  // moonrun `Runtime::new`: an inherited policy wins over `--policy`.
  let policy: PolicyComponent | undefined;
  if (inherited.value !== undefined || command.policy !== undefined) {
    const module = nodeComponentModule(POLICY_URL);
    if (!module.ok) {
      fail([module.error.message ?? module.error.code]);
    }
    policy = new PolicyComponent(
      module.value,
      osCapabilities(host, (b) => host.stdio.writeStderr(b)),
    );
    const result =
      inherited.value !== undefined
        ? policy.loadInherited(inherited.value)
        : policy.loadFile(command.policy ?? '', command.policySourceDir);
    if (!result.ok) {
      fail(result.error.chain);
    }
  }
  const outcome: RunOutcome = await run(loaded.value, host, {
    args: command.args,
    testArgs,
    noStackTrace: command.noStackTrace,
    policy,
  });
  switch (outcome.kind) {
    case 'completed':
      return 0;
    case 'exited':
      return outcome.code;
    case 'guest-failure':
      return 1;
    case 'panicked':
      // Rust's exit code for a panic in `main`.
      return 101;
    case 'signaled':
      process.kill(process.pid, outcome.signal);
      return 128 + outcome.signal;
    case 'host-failure':
      fail(outcome.failure.chain);
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
