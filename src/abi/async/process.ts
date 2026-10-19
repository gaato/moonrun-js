import { type AsyncError, INVAL } from '../../kernel/errors.ts';
import type { Handle } from '../../kernel/handles.ts';
import type { SpawnInputs } from '../../kernel/process.ts';
import { ok, type Result } from '../../ports/result.ts';
import { type AsyncEnv, AsyncFailure, handle, status, unwrap } from './env.ts';
import { readGuestPath } from './fs.ts';
import { readI32Array } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** `SIGKILL`. */
const SIGKILL = 9;

/**
 * `process/*` and the process Jobs of `thread_pool/*` (moonrun `async_api::process` and
 * the spawn/wait parts of `async_api::thread_pool`).
 */
export function processes(env: AsyncEnv) {
  const { ctx, kernel, memory } = env;
  const host = kernel.processes;
  const inputs = host.inputs;
  const text = (ptr: number, len: number): string => readGuestPath(memory, ptr, len);
  /** `inherited_unix_env`: the Run's environment (the provisioned one under a policy). */
  const inherited = (): string[] => ctx.host.env.entries().map(([k, v]) => `${k}=${v}`);
  const stdio = (stdin: bigint, stdout: bigint, stderr: bigint) =>
    unwrap(host.acquireStdio([handle(stdin), handle(stdout), handle(stderr)]));
  const spawnJob = (
    taken: Result<SpawnInputs, AsyncError>,
    path: number,
    pathLen: number,
    std: readonly [bigint, bigint, bigint],
    cwd: () => string | undefined,
  ): Handle => {
    const spawnInputs = unwrap(taken);
    const program = text(path, pathLen);
    const dir = cwd();
    return unwrap(host.insertSpawnJob(spawnInputs, program, stdio(...std), dir));
  };
  return {
    'process/get_curr_env': () => inputs.insertEnv(inherited()),
    'process/env_block_length': (block) => unwrap(inputs.envLength(handle(block))),
    'process/allocate_env_block': (size) =>
      inputs.insertEnv(Array.from({ length: size }, () => undefined)),
    // Ownership moves into the spawn Job (async PR 511).
    'process/free_env': () => {},
    'process/free_argv': () => {},
    'process/write_env_block': (dst, src) => unwrap(inputs.transferEnv(handle(dst), handle(src))),
    'process/env_block_add_entry': (block, index, key, keyLen, value, valueLen) => {
      const k = text(key, keyLen);
      const v = text(value, valueLen);
      unwrap(inputs.envSet(handle(block), index, k, v));
    },
    'process/make_env': (inherit) => inputs.insertBuilder(inherit === 0 ? [] : inherited()),
    'process/env_add_entry': (builder, key, keyLen, value, valueLen) => {
      const k = text(key, keyLen);
      const v = text(value, valueLen);
      unwrap(inputs.builderAdd(handle(builder), k, v));
    },
    'process/make_argv_array/unix': (len) => inputs.insertArgv(len),
    'process/argv_array_add_encoded_entry/unix': (argv, index, arg, argLen) => {
      const value = text(arg, argLen);
      unwrap(inputs.argvSet(handle(argv), index, value));
    },
    'process/argv_array_add_entry/unix': (argv, index, arg, argLen) => {
      const value = text(arg, argLen);
      unwrap(inputs.argvSet(handle(argv), index, value));
    },
    'process/open_pid_handle': (pid) =>
      unwrap(
        host.openPidHandle(pid, (errno) => {
          kernel.errno = errno;
        }),
      ),
    'process/get_process_result': (pidfd, pid, out) =>
      status(env, () => {
        const code = host.processResult(handle(pidfd), pid);
        if (!code.ok) {
          return code;
        }
        memory.view(out, 4);
        memory.setU32(out, code.value >>> 0);
        return ok(0);
      }),
    'process/terminate': (pid, signal) => unwrap(host.signal(pid, signal)),
    'process/kill': (pid) => unwrap(host.signal(pid, SIGKILL)),
    'thread_pool/spawn_job/unix': (path, pathLen, args, envBlock, stdin, stdout, stderr) =>
      spawnJob(
        inputs.takeSpawnInputs(handle(args), handle(envBlock)),
        path,
        pathLen,
        [stdin, stdout, stderr],
        () => undefined,
      ),
    'thread_pool/make_spawn_job/unix': (
      path,
      pathLen,
      args,
      envBlock,
      inheritedCount,
      stdin,
      stdout,
      stderr,
      cwd,
      cwdLen,
      hasCwd,
    ) => {
      const taken = inputs.takeLegacySpawnInputs(handle(args), handle(envBlock), inheritedCount);
      const spawnInputs = unwrap(taken);
      const program = text(path, pathLen);
      const dir = hasCwd === 0 ? undefined : text(cwd, cwdLen);
      return unwrap(host.insertSpawnJob(spawnInputs, program, stdio(stdin, stdout, stderr), dir));
    },
    'thread_pool/spawn_job/set_cwd': (job, cwd, cwdLen) => {
      const dir = text(cwd, cwdLen);
      unwrap(host.setCwd(handle(job), dir));
    },
    'thread_pool/spawn_job_get_result_handle': (job) => unwrap(host.spawnResultHandle(handle(job))),
    // The legacy wrapper lowers the Job's (never installed) copy-output closure too.
    'thread_pool/get_spawn_job_result_handle': (job, copyOutput) => {
      if (copyOutput !== 0) {
        throw new AsyncFailure(INVAL);
      }
      return unwrap(host.spawnResultHandle(handle(job)));
    },
    'thread_pool/make_wait_for_process_job': (pidfd, pid) =>
      unwrap(host.insertWaitJob(handle(pidfd), pid)),
    'thread_pool/make_sigwait_job': (signals, len) =>
      unwrap(host.insertSigwaitJob(readI32Array(memory, signals, len))),
  } satisfies HandlerGroup;
}
