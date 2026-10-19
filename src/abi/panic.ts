import { TerminationSignal } from '../kernel/termination.ts';
import type { RunContext } from './context.ts';

const SIGABRT = 6;

/**
 * A Rust `panic!` inside a V8 callback. moonrun cannot unwind through V8, so the
 * process prints the panic report and aborts (SIGABRT); there is no guest trap and
 * no `Error:` line. The thread id in the report is the process id.
 */
export function rustPanic(ctx: RunContext, location: string, message: string): never {
  // The abort skips flushing Rust's line-buffered stdout.
  ctx.stdio.discardStdout();
  ctx.stdio.writeStderrText(
    `\nthread 'main' (${ctx.host.platform.pid}) panicked at ${location}:\n${message}\n` +
      'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n' +
      'fatal runtime error: failed to initiate panic, error 5, aborting\n',
  );
  ctx.termination.request({ kind: 'signal', signal: SIGABRT });
  throw new TerminationSignal();
}
