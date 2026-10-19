import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';
import { readUtf8Char } from './print.ts';

export const io: ImportFamily = (ctx) => ({
  read_bytes_from_stdin: fn([], 'externref', () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(65536);
      const n = ctx.stdio.readStdin(chunk);
      if (n === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, n));
      total += n;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }),
  read_char: fn([], 'i32', () => readUtf8Char(ctx)),
  write_char: fn(['i32', 'u32'], 'void', (fd, ch) => {
    // Rust `char::from_u32(..).unwrap()` rejects surrogates and out-of-range values.
    if ((ch >= 0xd800 && ch <= 0xdfff) || ch > 0x10ffff) {
      throw new Error('called `Option::unwrap()` on a `None` value');
    }
    const text = String.fromCodePoint(ch);
    if (fd === 1) {
      ctx.stdio.writeStdoutText(text);
    } else if (fd === 2) {
      ctx.stdio.writeStderrText(text);
    }
  }),
  flush: fn(['i32'], 'void', (fd) => {
    if (fd === 1) {
      ctx.stdio.flushStdout();
    }
  }),
});
