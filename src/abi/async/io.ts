import { type AsyncEnv, handle, status } from './env.ts';
import { checkedAdd } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/**
 * `io/read/unix` and `io/write/unix`: one nonblocking `read`/`write` on a pollable handle. The guest slice
 * is borrowed only for the call.
 */
export function io(env: AsyncEnv) {
  const { kernel, memory } = env;
  return {
    'io/read/unix': (fd, dst, offset, len) =>
      status(env, () => kernel.read(handle(fd), memory.view(checkedAdd(dst, offset), len))),
    'io/write/unix': (fd, src, offset, len) =>
      status(env, () => kernel.write(handle(fd), memory.view(checkedAdd(src, offset), len))),
  } satisfies HandlerGroup;
}
