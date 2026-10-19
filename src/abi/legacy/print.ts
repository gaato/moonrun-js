import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';

/** `spectest.print_char`; `moonbit.string_to_js_string` is the same function in moonrun. */
export function printChar(ctx: Parameters<ImportFamily>[0]) {
  return fn(['u32'], 'void', (value) => {
    if (!ctx.printWriter.write(ctx.stdio, value)) {
      throw new Error('invalid character');
    }
  });
}

/** Reads one UTF-8 character from stdin; -1 at end of input or on invalid input. */
export function readUtf8Char(ctx: Parameters<ImportFamily>[0]): number {
  const one = new Uint8Array(1);
  if (ctx.stdio.readStdin(one) === 0) {
    return -1;
  }
  const first = one[0] ?? 0;
  const length =
    first <= 0x7f
      ? 1
      : first >= 0xc0 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf7
            ? 4
            : 0;
  if (length === 0) {
    return -1;
  }
  const bytes = new Uint8Array(length);
  bytes[0] = first;
  let filled = 1;
  while (filled < length) {
    const n = ctx.stdio.readStdin(bytes.subarray(filled));
    if (n === 0) {
      return -1;
    }
    filled += n;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.codePointAt(0) ?? -1;
  } catch {
    return -1;
  }
}

export const spectest: ImportFamily = (ctx) => ({
  print_char: printChar(ctx),
  read_char: fn([], 'i32', () => readUtf8Char(ctx)),
});

export const moonbit: ImportFamily = (ctx) => ({
  string_to_js_string: printChar(ctx),
});

export const consoleLog: ImportFamily = (ctx) => ({
  log: fn(['externref'], 'void', (value) => {
    ctx.stdio.writeStdoutText(`${String(value)}\n`);
  }),
});
