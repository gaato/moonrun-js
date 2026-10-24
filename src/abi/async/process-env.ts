import { fileKindCode } from '../../kernel/file.ts';
import { TerminationSignal } from '../../kernel/termination.ts';
import { ok } from '../../ports/result.ts';
import { requestExit } from '../legacy/sys.ts';
import { type AsyncEnv, fail, handle, status, unwrap } from './env.ts';
import { readI32Array } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** Signals by `signal/get_signal_by_index` (SIGINT, SIGTERM, SIGHUP; no SIGBREAK on Linux). */
const SIGNALS_BY_INDEX: readonly number[] = [2, 15, 1, -1];

/**
 * The small process-shaped families: stdio handles, pid, clock, randomness,
 * platform, termination and signal registration.
 */
export function processEnv(env: AsyncEnv) {
  const { ctx, kernel, memory } = env;
  return {
    'stdio/kind_of_fd': (fd) =>
      status(env, () => {
        const kind = kernel.kindOfFd(handle(fd));
        return kind.ok ? ok(fileKindCode(kind.value)) : kind;
      }),
    'stdio/get_stdio_handle': (id) => {
      const found = kernel.stdHandle(id);
      if (found.ok) {
        return found.value;
      }
      fail(env, found.error);
      return kernel.resources.invalidHandle;
    },
    'env_util/getpid': () => ctx.host.platform.pid,
    'time/get_ms_since_epoch': () => BigInt(Math.trunc(ctx.host.clock.nowMs())),
    'random/fill': (buffer, length) =>
      status(env, () => {
        ctx.host.random.fill(memory.view(buffer, length));
        return ok(0);
      }),
    // moonrun-js always presents Linux.
    'runtime/get_platform': () => 0,
    'runtime/exit': (code) => requestExit(ctx, code),
    'runtime/terminate_process_by_signal': (signal) => {
      // The native stub kills the process; moonrun records the outcome for the CLI instead.
      ctx.termination.request({ kind: 'signal', signal });
      throw new TerminationSignal();
    },
    'signal/get_signal_by_index': (index) => SIGNALS_BY_INDEX[index] ?? -1,
    'signal/set_global_cancellation_signals': (all, allLen, signals, signalsLen) => {
      const known = readI32Array(memory, all, allLen);
      const selected = readI32Array(memory, signals, signalsLen);
      kernel.signals.configure(known, selected);
    },
    'signal/start_signal_handler': () => unwrap(kernel.startSignalHandler()),
    'signal/terminate_signal_handler': () => kernel.signals.stop(),
  } satisfies HandlerGroup;
}
