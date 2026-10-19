/**
 * moonrun's command line, parsed with the same rules as its clap definition
 * (`moonrun <PATH> [ARGS]...` with `allow_hyphen_values` on ARGS):
 * - options are recognized before the path and between the path and the first ARG;
 * - once ARGS have started, every token is an ARG; `--` also starts ARGS;
 * - after the path, unknown hyphenated tokens are ARGS rather than errors.
 * Error texts follow clap's, with the program name of this implementation (D5).
 */

export const PROGRAM = 'moonrun-js';

export interface Command {
  readonly kind: 'run';
  readonly path: string;
  /** Index of the path in argv, to recover its raw bytes. */
  readonly pathIndex: number;
  readonly args: string[];
  readonly noStackTrace: boolean;
  readonly testArgs: string | undefined;
  readonly stackSize: number | undefined;
  readonly policy: string | undefined;
  readonly policySourceDir: string | undefined;
}

export type Parsed = Command | { readonly kind: 'version' } | { readonly kind: 'help' };

/** A clap usage error; `message` is the full text printed to stderr (exit status 2). */
export class UsageError extends Error {}

const VALUE_OPTIONS: Readonly<Record<string, string>> = {
  '--test-args': 'TEST_ARGS',
  '--stack-size': 'STACK_SIZE',
  '--policy': 'PATH',
  '--policy-source-dir': 'PATH',
};

const MORE = "\n\nFor more information, try '--help'.\n";

function usageError(message: string, usage: string): UsageError {
  return new UsageError(`error: ${message}\n\nUsage: ${PROGRAM} ${usage}${MORE}`);
}

function plainError(message: string): UsageError {
  return new UsageError(`error: ${message}${MORE}`);
}

/** Rust `usize::from_str` error texts. */
function parseUsize(text: string): number | string {
  if (text === '') {
    return 'cannot parse integer from empty string';
  }
  if (!/^\+?[0-9]+$/.test(text)) {
    return 'invalid digit found in string';
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 'number too large to fit in target type';
}

export function parseArgs(argv: readonly string[]): Parsed {
  let path: string | undefined;
  let pathIndex = -1;
  const args: string[] = [];
  const values = new Map<string, string>();
  let noStackTrace = false;
  let trailing = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (trailing || args.length > 0) {
      if (path === undefined) {
        path = a;
        pathIndex = i;
      } else {
        args.push(a);
      }
      continue;
    }
    if (a === '--') {
      trailing = true;
      continue;
    }
    const isOption = a.startsWith('-') && a !== '-';
    if (!isOption) {
      if (path === undefined) {
        path = a;
        pathIndex = i;
      } else {
        args.push(a);
      }
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (name === '--version' || name === '-V') {
      return { kind: 'version' };
    }
    if (name === '--help' || name === '-h') {
      return { kind: 'help' };
    }
    if (name === '--no-stack-trace') {
      if (noStackTrace) {
        throw usageError(
          "the argument '--no-stack-trace' cannot be used multiple times",
          '[OPTIONS] <PATH> [ARGS]...',
        );
      }
      noStackTrace = true;
      continue;
    }
    const valueName = VALUE_OPTIONS[name];
    if (valueName !== undefined) {
      const display = `${name} <${valueName}>`;
      let value = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
      if (eq <= 0) {
        i++;
      }
      if (value !== undefined && eq <= 0 && value.startsWith('-') && value !== '-') {
        value = undefined;
        i--;
      }
      if (value === undefined) {
        throw plainError(`a value is required for '${display}' but none was supplied`);
      }
      if (values.has(name)) {
        throw usageError(
          `the argument '${display}' cannot be used multiple times`,
          '[OPTIONS] <PATH> [ARGS]...',
        );
      }
      values.set(name, value);
      continue;
    }
    if (path !== undefined) {
      args.push(a);
      continue;
    }
    throw usageError(
      `unexpected argument '${a}' found\n\n  tip: to pass '${a}' as a value, use '-- ${a}'`,
      '[OPTIONS] <PATH> [ARGS]...',
    );
  }
  if (path === undefined) {
    throw usageError(
      'the following required arguments were not provided:\n  <PATH>',
      '<PATH> [ARGS]...',
    );
  }
  if (values.has('--policy-source-dir') && !values.has('--policy')) {
    throw usageError(
      'the following required arguments were not provided:\n  --policy <PATH>',
      '--policy <PATH> <PATH> [ARGS]...',
    );
  }
  const stackSizeText = values.get('--stack-size');
  let stackSize: number | undefined;
  if (stackSizeText !== undefined) {
    const parsed = parseUsize(stackSizeText);
    if (typeof parsed === 'string') {
      throw plainError(
        `invalid value '${stackSizeText}' for '--stack-size <STACK_SIZE>': ${parsed}`,
      );
    }
    stackSize = parsed;
  }
  return {
    kind: 'run',
    path,
    pathIndex,
    args,
    noStackTrace,
    testArgs: values.get('--test-args'),
    stackSize,
    policy: values.get('--policy'),
    policySourceDir: values.get('--policy-source-dir'),
  };
}
