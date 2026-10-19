import { LINUX_ERRNO, strerrorOfErrno } from '../errno.ts';
import { type AsyncEnv, handle, unwrap } from './env.ts';
import { cString } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

const is = (expected: number) => (errno: number) => (errno === expected ? 1 : 0);

/** `os_error/*`: the per-run errno, strerror, and the compat predicates (async #566). */
export function osError(env: AsyncEnv) {
  const { kernel } = env;
  return {
    'os_error/get_errno': () => kernel.errno,
    'os_error/errno_to_string': (errno) => kernel.cBuffers.insert(cString(strerrorOfErrno(errno))),
    'os_error/free_errno_str': (ptr) => unwrap(kernel.cBuffers.free(handle(ptr))),
    'os_error/is_nonblocking_io_error': (errno) =>
      errno === LINUX_ERRNO.EAGAIN || errno === LINUX_ERRNO.EINPROGRESS ? 1 : 0,
    'os_error/is_EINTR': is(LINUX_ERRNO.EINTR),
    'os_error/is_ENOENT': is(LINUX_ERRNO.ENOENT),
    'os_error/is_EEXIST': is(LINUX_ERRNO.EEXIST),
    'os_error/is_EACCES': is(LINUX_ERRNO.EACCES),
    'os_error/is_ECONNREFUSED': is(LINUX_ERRNO.ECONNREFUSED),
    'os_error/is_ERROR_NOTIFY_ENUM_DIR': () => 0,
    'os_error/get_ENOTDIR': () => LINUX_ERRNO.ENOTDIR,
    'os_error/get_ENOTSUP': () => LINUX_ERRNO.ENOTSUP,
  } satisfies HandlerGroup;
}
