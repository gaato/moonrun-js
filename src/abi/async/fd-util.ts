import { FAULT } from '../../kernel/errors.ts';
import { fileKindCode } from '../../kernel/file.ts';
import { ok } from '../../ports/result.ts';
import { type AsyncEnv, AsyncFailure, bool, handle, status, zeroOrMinusOne } from './env.ts';
import { checkedAdd } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

export { fileKindCode };

/** The wasm `FileTime` record: three (i64 seconds, i32 nanoseconds) pairs at 16-byte strides. */
const FILE_TIME_RECORD_LEN = 48;

/** `fd_util/*`: pipes, descriptor flags and FileTime accessors. */
export function fdUtil(env: AsyncEnv) {
  const { kernel, memory } = env;
  const i64At = (ptr: number, offset: number): bigint => {
    const at = checkedAdd(ptr, offset);
    const bytes = memory.view(at, 8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
  };
  const i32At = (ptr: number, offset: number): number => {
    const at = checkedAdd(ptr, offset);
    const bytes = memory.view(at, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
  };
  return {
    'fd_util/invalid_fd': () => kernel.resources.invalidHandle,
    'fd_util/close_fd': (fd) => zeroOrMinusOne(env, () => kernel.closeFd(handle(fd))),
    'fd_util/pipe': (dst, len, readAsync, writeAsync) =>
      status(env, () => {
        if (len < 2) {
          throw new AsyncFailure(FAULT);
        }
        memory.view(dst, 16);
        const [reader, writer] = kernel.pipe(bool(readAsync), bool(writeAsync));
        memory.setU64(dst, reader);
        memory.setU64(checkedAdd(dst, 8), writer);
        return ok(0);
      }),
    'fd_util/kind_of_fd': (fd) =>
      status(env, () => {
        const kind = kernel.kindOfFd(handle(fd));
        return kind.ok ? ok(fileKindCode(kind.value)) : kind;
      }),
    'fd_util/set_cloexec': (fd) => zeroOrMinusOne(env, () => kernel.setCloexec(handle(fd))),
    // ADR 0010: a compat import must not change the blocking mode of (possibly stdio) fds.
    'fd_util/set_nonblocking/unix': () => 0,
    'fd_util/sizeof_file_time': () => FILE_TIME_RECORD_LEN,
    'fd_util/get_atime_sec': (ptr) => i64At(ptr, 0),
    'fd_util/get_atime_nsec': (ptr) => i32At(ptr, 8),
    'fd_util/get_mtime_sec': (ptr) => i64At(ptr, 16),
    'fd_util/get_mtime_nsec': (ptr) => i32At(ptr, 24),
    'fd_util/get_ctime_sec': (ptr) => i64At(ptr, 32),
    'fd_util/get_ctime_nsec': (ptr) => i32At(ptr, 40),
  } satisfies HandlerGroup;
}
