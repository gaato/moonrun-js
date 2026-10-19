import { NULL_HANDLE } from '../../kernel/handles.ts';
import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';
import { LINUX_ERRNO } from '../errno.ts';

/** Bytes as one char per byte, so path splitting on `/` works on non-UTF-8 paths. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return s;
}

function fromLatin1(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Rust `Path::parent` for an absolute Unix path; `undefined` for `/`. */
export function parentPath(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') {
    return undefined;
  }
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) {
    return '';
  }
  return cut === 0 ? '/' : trimmed.slice(0, cut).replace(/\/+$/, '') || '/';
}

/**
 * `moonbitlang/core` `env/current_exe` and `env/current_exe_dir` (moonrun `core_api`):
 * a NUL-terminated native path in an async c_buffer, or the null handle with
 * `EINVAL` in async's errno when the module did not come from a file.
 */
export const moonbitlangCore: ImportFamily = (ctx) => {
  const kernel = ctx.asyncKernel;
  const pathHandle = (path: Uint8Array | undefined): bigint => {
    if (path === undefined) {
      kernel.errno = LINUX_ERRNO.EINVAL;
      return NULL_HANDLE;
    }
    const buffer = new Uint8Array(path.length + 1);
    buffer.set(path);
    return kernel.cBuffers.insert(buffer);
  };
  const exe = (): Uint8Array | undefined => ctx.host.platform.currentExe;
  return {
    'env/current_exe': fn([], 'u64', () => pathHandle(exe())),
    'env/current_exe_dir': fn([], 'u64', () => {
      const path = exe();
      const parent = path === undefined ? undefined : parentPath(latin1(path));
      return pathHandle(parent === undefined ? undefined : fromLatin1(parent));
    }),
  };
};
