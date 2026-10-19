import { FAULT, INVAL } from '../../kernel/errors.ts';
import { type AsyncEnv, AsyncFailure, handle, unwrap } from './env.ts';
import { writeUtf16 } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

const lossy = new TextDecoder('utf-8');

/**
 * moonrun `decode_native_string` on Unix: bytes from `offset`, `len` bytes or up to
 * the first NUL when `len` is -1, decoded as lossy UTF-8.
 */
function decodeNative(bytes: Uint8Array, offset: number, len: number): string {
  if (offset > bytes.length) {
    throw new AsyncFailure(FAULT);
  }
  const rest = bytes.subarray(offset);
  let end: number;
  if (len === -1) {
    end = rest.indexOf(0);
  } else if (len < 0 || len > rest.length) {
    end = -1;
  } else {
    end = len;
  }
  if (end < 0) {
    throw new AsyncFailure(FAULT);
  }
  return lossy.decode(rest.subarray(0, end));
}

/** `os_string/*`: decoding host-native strings into guest UTF-16. */
export function osString(env: AsyncEnv) {
  const { kernel, memory } = env;
  const decode = (ptr: bigint, offset: number, len: number): string =>
    decodeNative(unwrap(kernel.cBuffers.get(handle(ptr))), offset, len);
  return {
    'os_string/decode_len': (ptr, offset, len) => decode(ptr, offset, len).length,
    'os_string/decode': (ptr, offset, len, out, outLen) => {
      const text = decode(ptr, offset, len);
      if (text.length !== outLen) {
        throw new AsyncFailure(INVAL);
      }
      writeUtf16(memory, out, text);
    },
  } satisfies HandlerGroup;
}
