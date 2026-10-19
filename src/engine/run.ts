import { createAsyncKernel } from '../abi/async/index.ts';
import type { ImportFamily, RunContext } from '../abi/context.ts';
import { FAMILIES } from '../abi/families.ts';
import { GuestMemory } from '../abi/memory.ts';
import { render } from '../diagnostics/render.ts';
import { Stdio, Utf16Writer } from '../domains/stdio.ts';
import { type Termination, TerminationCell } from '../kernel/termination.ts';
import type { Host } from '../ports/host.ts';
import { buildImports } from './imports.ts';
import type { HostFailure, LoadedModule } from './load.ts';
import { exceptionLines } from './stack.ts';

/** Test selection passed by `moon test` (`--test-args`). Ranges are half-open. */
export interface TestArgs {
  readonly package: string;
  readonly file_and_index: ReadonlyArray<
    readonly [string, ReadonlyArray<{ readonly start: number; readonly end: number }>]
  >;
}

export interface RunOptions {
  /** Guest arguments after argv[0]. */
  readonly args: readonly string[];
  readonly testArgs?: TestArgs | undefined;
  readonly noStackTrace?: boolean | undefined;
  /** Replaces or extends the built-in import families (mainly for tests). */
  readonly families?: Readonly<Record<string, ImportFamily>> | undefined;
}

export type RunOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'signaled'; readonly signal: number }
  /** The guest trapped or threw; the diagnostic was already written to stderr. */
  | { readonly kind: 'guest-failure'; readonly diagnostic: string }
  | { readonly kind: 'host-failure'; readonly failure: HostFailure };

type CallOutcome =
  | { readonly kind: 'returned'; readonly value: unknown }
  | { readonly kind: 'terminated'; readonly termination: Termination }
  | { readonly kind: 'guest-failure'; readonly diagnostic: string }
  | { readonly kind: 'host-failure'; readonly message: string };

const TEST_RESULT_BEGIN = '----- BEGIN MOON TEST RESULT -----\n';
const TEST_RESULT_END = '----- END MOON TEST RESULT -----\n';

function exportedFunction(
  exports: WebAssembly.Exports,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  const value = exports[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'function') {
    throw new TypeError(`export \`${name}\` is not a function`);
  }
  return value as (...args: unknown[]) => unknown;
}

function terminationOutcome(termination: Termination): RunOutcome {
  return termination.kind === 'exit'
    ? { kind: 'exited', code: termination.code }
    : { kind: 'signaled', signal: termination.signal };
}

/** Runs a loaded module once with a fresh set of host state. */
export async function run(
  loaded: LoadedModule,
  host: Host,
  options: RunOptions,
): Promise<RunOutcome> {
  const stdio = new Stdio(host.stdio);
  const termination = new TerminationCell();
  const cleanups: (() => void)[] = [];
  const completionChecks: (() => string | undefined)[] = [];
  const asyncKernel = createAsyncKernel(host);
  cleanups.push(() => asyncKernel.teardown());
  const ctx: RunContext = {
    host,
    stdio,
    printWriter: new Utf16Writer(),
    memory: new GuestMemory(),
    termination,
    asyncKernel,
    moduleName: loaded.name,
    args: options.args,
    onCompleted: (check) => {
      completionChecks.push(check);
    },
    onTeardown: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
  const noStackTrace = options.noStackTrace ?? false;

  const classify = (error: unknown): CallOutcome => {
    const lines = exceptionLines(error);
    const formatted = render(lines, loaded.sourceMap, noStackTrace);
    if (error instanceof WebAssembly.RuntimeError || error instanceof WebAssembly.Exception) {
      return { kind: 'guest-failure', diagnostic: formatted };
    }
    // anyhow adds its own "Error:" label; V8 already put one on a plain Error.
    return {
      kind: 'host-failure',
      message: formatted.startsWith('Error: ') ? formatted.slice(7) : formatted,
    };
  };

  const settle = (threw: boolean, value: unknown): CallOutcome => {
    const requested = termination.current;
    if (requested !== undefined) {
      return { kind: 'terminated', termination: requested };
    }
    return threw ? classify(value) : { kind: 'returned', value };
  };

  const families = options.families === undefined ? FAMILIES : { ...FAMILIES, ...options.families };
  const { imports, suspends } = buildImports(loaded.module, ctx, families, loaded.stringImports);

  const call = async (
    f: (...args: unknown[]) => unknown,
    args: unknown[],
  ): Promise<CallOutcome> => {
    try {
      const value = suspends ? await WebAssembly.promising(f)(...args) : f(...args);
      return settle(false, value);
    } catch (e) {
      return settle(true, e);
    }
  };

  const finish = (outcome: CallOutcome, context: string | undefined): RunOutcome => {
    switch (outcome.kind) {
      case 'returned':
        return { kind: 'completed' };
      case 'terminated':
        return terminationOutcome(outcome.termination);
      case 'guest-failure':
        stdio.writeStderrText(`${outcome.diagnostic}\n`);
        return { kind: 'guest-failure', diagnostic: outcome.diagnostic };
      case 'host-failure':
        return {
          kind: 'host-failure',
          failure: {
            chain: context === undefined ? [outcome.message] : [context, outcome.message],
          },
        };
    }
  };

  const execute = async (): Promise<RunOutcome> => {
    let instance: WebAssembly.Instance;
    try {
      instance = new WebAssembly.Instance(loaded.module, imports);
    } catch (e) {
      const outcome = settle(true, e);
      return finish(outcome, `failed to instantiate \`${loaded.name}\``);
    }
    if (termination.current !== undefined) {
      return terminationOutcome(termination.current);
    }
    const exports = instance.exports;
    const memory = exports['memory'];
    if (memory instanceof WebAssembly.Memory) {
      ctx.memory.bind(memory);
    }

    if (options.testArgs !== undefined) {
      const execute = exportedFunction(exports, 'moonbit_test_driver_internal_execute');
      if (execute === undefined) {
        return hostFailure('test module does not export `moonbit_test_driver_internal_execute`');
      }
      const finishDriver = exportedFunction(exports, 'moonbit_test_driver_finish');
      if (finishDriver === undefined) {
        return hostFailure('test module does not export `moonbit_test_driver_finish`');
      }
      for (const [file, ranges] of options.testArgs.file_and_index) {
        for (const { start, end } of ranges) {
          for (let index = start; index < end; index++) {
            const outcome = await call(execute, [file, index]);
            if (outcome.kind === 'terminated') {
              return terminationOutcome(outcome.termination);
            }
            if (outcome.kind === 'host-failure') {
              return finish(outcome, 'failed to execute a MoonBit test');
            }
            if (outcome.kind === 'guest-failure') {
              const result = JSON.stringify({
                type: 'result',
                file,
                index,
                message: outcome.diagnostic,
              });
              stdio.writeStdoutText(`${TEST_RESULT_BEGIN}${result}\n${TEST_RESULT_END}`);
            }
          }
        }
      }
      return finish(await call(finishDriver, []), 'failed to finish the MoonBit test driver');
    }

    const start = exportedFunction(exports, '_start');
    if (start === undefined) {
      return { kind: 'completed' };
    }
    return finish(await call(start, []), undefined);
  };

  try {
    const outcome = await execute();
    if (outcome.kind !== 'completed') {
      return outcome;
    }
    for (const check of completionChecks) {
      const failure = check();
      if (failure !== undefined) {
        return hostFailure(failure);
      }
    }
    return outcome;
  } finally {
    stdio.flushStdout();
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

function hostFailure(message: string): RunOutcome {
  return { kind: 'host-failure', failure: { chain: [message] } };
}
