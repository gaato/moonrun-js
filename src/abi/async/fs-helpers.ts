import { INVAL } from '../../kernel/errors.ts';
import { ok } from '../../ports/result.ts';
import { LINUX_ERRNO } from '../errno.ts';
import { type AsyncEnv, AsyncFailure, status } from './env.ts';
import { cString, writeUtf16 } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** Linux `sizeof(struct linux_dirent64)` header (24) plus `NAME_MAX` (255). */
const DIR_BUFFER_MIN_SIZE = 24 + 255;

/** moonrun `tmp_path_from_env`: `$TMPDIR` with a trailing `/`, or `/tmp/`. */
export function tmpPath(tmpdir: string | undefined): string {
  if (tmpdir === undefined || tmpdir === '') {
    return '/tmp/';
  }
  return tmpdir.endsWith('/') ? tmpdir : `${tmpdir}/`;
}

/** The pure `fs/*` helpers; Jobs, readdir buffers and locks belong to the filesystem domain. */
export function fsHelpers(env: AsyncEnv) {
  const { ctx, kernel, memory } = env;
  const tmp = (): string => tmpPath(ctx.host.env.get('TMPDIR'));
  return {
    'fs/dir_buffer_min_size': () => DIR_BUFFER_MIN_SIZE,
    'fs/errno_is_lock_violation': (errno) => (errno === LINUX_ERRNO.EAGAIN ? 1 : 0),
    'fs/get_tmp_path_len': () => tmp().length,
    'fs/get_tmp_path': (ptr, len) =>
      status(env, () => {
        const path = tmp();
        if (path.length !== len) {
          throw new AsyncFailure(INVAL);
        }
        writeUtf16(memory, ptr, path);
        return ok(0);
      }),
    'fs/get_tmp_path_buffer': () => kernel.cBuffers.insert(cString(tmp())),
  } satisfies HandlerGroup;
}
