import { FAULT } from '../../kernel/errors.ts';
import { NULL_HANDLE } from '../../kernel/handles.ts';
import { type AsyncEnv, AsyncFailure, handle, unwrap } from './env.ts';
import { checkedAdd } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** moonrun `checked_range`: `[offset, offset + len)` inside `bytes`. */
function range(bytes: Uint8Array, offset: number, len: number): Uint8Array {
  if (offset + len > bytes.length) {
    throw new AsyncFailure(FAULT);
  }
  return bytes.subarray(offset, offset + len);
}

/** `c_buffer/*`: Host Buffers addressed by handle. */
export function cBuffer(env: AsyncEnv) {
  const { kernel, memory } = env;
  const buffers = kernel.cBuffers;
  return {
    'c_buffer/new': (size) => buffers.insert(new Uint8Array(size)),
    'c_buffer/free': (ptr) => unwrap(buffers.free(handle(ptr))),
    'c_buffer/is_null': (ptr) => (handle(ptr) === NULL_HANDLE ? 1 : 0),
    'c_buffer/length': (buf) => unwrap(buffers.get(handle(buf))).length,
    'c_buffer/c_buffer_get': (buf, index) => {
      const value = unwrap(buffers.get(handle(buf)))[index];
      if (value === undefined) {
        throw new AsyncFailure(FAULT);
      }
      return value;
    },
    'c_buffer/strlen': (buf) => {
      const at = unwrap(buffers.get(handle(buf))).indexOf(0);
      if (at < 0) {
        throw new AsyncFailure(FAULT);
      }
      return at;
    },
    'c_buffer/blit_to_c': (dst, dstOffset, src, srcOffset, len) => {
      const source = memory.view(src, checkedAdd(srcOffset, len));
      const target = unwrap(buffers.get(handle(dst)));
      range(target, dstOffset, len).set(range(source, srcOffset, len));
    },
    'c_buffer/blit_from_c': (src, srcOffset, dst, dstOffset, len) => {
      const target = memory.view(dst, checkedAdd(dstOffset, len));
      const source = unwrap(buffers.get(handle(src)));
      range(target, dstOffset, len).set(range(source, srcOffset, len));
    },
  } satisfies HandlerGroup;
}
