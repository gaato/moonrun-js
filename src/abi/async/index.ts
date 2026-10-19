import { AsyncKernel, type AsyncKernelOptions, type FdKind } from '../../kernel/async-kernel.ts';
import { type AsyncError, native } from '../../kernel/errors.ts';
import { fdKindOfMode } from '../../kernel/file.ts';
import type { ProcessOptions } from '../../kernel/processes.ts';
import type { StdioStream } from '../../kernel/resource.ts';
import { GlobalScheduler } from '../../kernel/scheduler.ts';
import type { HostFd } from '../../ports/files.ts';
import type { Host } from '../../ports/host.ts';
import { err, ok, type Result } from '../../ports/result.ts';
import type { ImportFamily } from '../context.ts';
import { buildAsyncImports } from './build.ts';
import { cBuffer } from './c-buffer.ts';
import type { AsyncEnv } from './env.ts';
import { eventBus } from './event-bus.ts';
import { fdUtil } from './fd-util.ts';
import { filesystem } from './fs.ts';
import { fsHelpers } from './fs-helpers.ts';
import { io } from './io.ts';
import { osError } from './os-error.ts';
import { osString } from './os-string.ts';
import { processes } from './process.ts';
import { processEnv } from './process-env.ts';
import { sockets } from './socket.ts';
import { threadPool } from './thread-pool.ts';
import { tls } from './tls.ts';
import type { AsyncHandlers, ImplementedSymbol } from './types.ts';

/** The `--policy` checks of the Async Host (absent: everything is allowed). */
export type PolicySeams = Pick<
  AsyncKernelOptions,
  'authorizeFilesystem' | 'authorizeNetwork' | 'recordResolved'
> & {
  /** Spawn rule, child provenance and moonx inheritance (`HostProcess`). */
  readonly process?: Omit<ProcessOptions, 'port'>;
};

/** The Async Host of a run, over the host's stdio and the global event loop. */
export function createAsyncKernel(host: Host, policy: PolicySeams = {}): AsyncKernel {
  const { process, ...seams } = policy;
  return new AsyncKernel({
    ...seams,
    process: { ...process, port: host.process },
    osSignals: host.signals,
    stdio: host.stdio,
    scheduler: new GlobalScheduler(),
    files: host.files,
    net: host.net,
    dns: host.dns,
    stdioKind: (stream: StdioStream): Result<FdKind, AsyncError> => {
      const stat = host.files.fstat(stream as HostFd);
      return stat.ok ? ok(fdKindOfMode(stat.value.mode)) : err(native(stat.error.code));
    },
  });
}

/** Compile-time exactness: no handler for a symbol the table does not implement. */
function exact<H extends AsyncHandlers>(
  handlers: H & { readonly [K in Exclude<keyof H, ImplementedSymbol>]: never },
): AsyncHandlers {
  return handlers;
}

/** Every handler of the run; family groups must not overlap (checked by a unit test). */
export function asyncHandlerGroups(env: AsyncEnv) {
  return [
    eventBus(env),
    threadPool(env),
    osError(env),
    cBuffer(env),
    osString(env),
    fdUtil(env),
    io(env),
    processEnv(env),
    fsHelpers(env),
    filesystem(env),
    sockets(env),
    tls(env),
    processes(env),
  ] as const;
}

export function asyncHandlers(env: AsyncEnv): AsyncHandlers {
  const [a, b, c, d, e, f, g, h, i, j, k, l, m] = asyncHandlerGroups(env);
  return exact({
    ...a,
    ...b,
    ...c,
    ...d,
    ...e,
    ...f,
    ...g,
    ...h,
    ...i,
    ...j,
    ...k,
    ...l,
    ...m,
  });
}

/** The `moonbitlang/async` import module. */
export const moonbitlangAsync: ImportFamily = (ctx) =>
  buildAsyncImports(asyncHandlers({ ctx, kernel: ctx.asyncKernel, memory: ctx.memory }));
