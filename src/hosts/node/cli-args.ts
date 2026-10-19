// moonrun's command line, parsed by its own clap definition (crates/moonrun-cli: the
// upstream `struct Commandline`), with the program name and version of moonrun-js (D5).
import { ComponentAbi, nulList, utf8 } from '../../components/abi.ts';
import { CLI_URL, nodeComponentModule } from './components.ts';

export const PROGRAM = 'moonrun-js';

export interface Command {
  readonly kind: 'run';
  /** The module path as raw bytes (on Unix a path need not be UTF-8). */
  readonly path: Uint8Array;
  readonly args: string[];
  readonly noStackTrace: boolean;
  readonly testArgs: string | undefined;
  readonly stackSize: number | undefined;
  readonly policy: Uint8Array | undefined;
  readonly policySourceDir: Uint8Array | undefined;
}

/** clap printed a message and wants this exit status (help/version: 0 on stdout). */
export interface Exit {
  readonly kind: 'exit';
  readonly code: number;
  readonly message: string;
}

export interface ParseOptions {
  /** `--version` text after the program name. */
  readonly version: string;
  /** Whether clap may style messages for stdout / stderr (clap's `ColorChoice::Auto`). */
  readonly color: { readonly stdout: boolean; readonly stderr: boolean };
}

interface Parsed {
  readonly path_hex: string;
  readonly args: string[];
  readonly no_stack_trace: boolean;
  readonly test_args: string | null;
  readonly stack_size: number | null;
  readonly policy_hex: string | null;
  readonly policy_source_dir_hex: string | null;
}

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

/** Parses `argv` (raw bytes, without the program) like moonrun. */
export function parseArgs(argv: readonly Uint8Array[], options: ParseOptions): Command | Exit {
  const module = nodeComponentModule(CLI_URL);
  if (!module.ok) {
    throw new Error(module.error.message);
  }
  const abi = new ComponentAbi(new WebAssembly.Instance(module.value, {}), 'cli');
  const color = (options.color.stdout ? 1 : 0) | (options.color.stderr ? 2 : 0);
  const code = abi.call('cli_parse', nulList([PROGRAM, ...argv]), PROGRAM, options.version, color);
  if (code !== -1) {
    return { kind: 'exit', code, message: abi.resultText() };
  }
  const parsed = JSON.parse(utf8(abi.result())) as Parsed;
  return {
    kind: 'run',
    path: fromHex(parsed.path_hex),
    args: parsed.args,
    noStackTrace: parsed.no_stack_trace,
    testArgs: parsed.test_args ?? undefined,
    stackSize: parsed.stack_size ?? undefined,
    policy: parsed.policy_hex === null ? undefined : fromHex(parsed.policy_hex),
    policySourceDir:
      parsed.policy_source_dir_hex === null ? undefined : fromHex(parsed.policy_source_dir_hex),
  };
}

/** anstream's `ColorChoice::Auto` decision (what clap uses), Unix rules. */
export function colorEnabled(isTty: boolean, env: NodeJS.ProcessEnv): boolean {
  const clicolor = env['CLICOLOR'];
  const noColor = env['NO_COLOR'];
  const force = env['CLICOLOR_FORCE'];
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  if (force !== undefined && force !== '0') {
    return true;
  }
  if (clicolor === '0') {
    return false;
  }
  const term = env['TERM'];
  const termColor = term !== undefined && term !== 'dumb';
  return isTty && (termColor || clicolor !== undefined || env['CI'] !== undefined);
}
