import type { DiagnosticLine } from '../diagnostics/render.ts';

const HEX = /^[0-9a-fA-F]+$/;

/** Port of moonrun `parse_stack_line` for V8-style stacks. */
export function parseStackLine(line: string): DiagnosticLine {
  const body = line.trimStart();
  const indentation = line.slice(0, line.length - body.length);
  if (!body.startsWith('at ')) {
    return { kind: 'text', text: line };
  }
  const frame = body.slice(3);
  if (frame.endsWith(')')) {
    const inner = frame.slice(0, -1);
    const split = inner.lastIndexOf(' (');
    if (split >= 0) {
      const fn = inner.slice(0, split);
      const location = inner.slice(split + 2).trimEnd();
      const at = location.lastIndexOf(':0x');
      const hex = at >= 0 ? location.slice(at + 3) : '';
      const moduleOffset = hex.length > 0 && HEX.test(hex) ? Number.parseInt(hex, 16) : undefined;
      return { kind: 'frame', indentation, fn, moduleOffset };
    }
  }
  const fn = frame.trimEnd();
  if (fn.length > 0 && !/\s/u.test(fn)) {
    return { kind: 'frame', indentation, fn, moduleOffset: undefined };
  }
  return { kind: 'text', text: line };
}

/**
 * True for frames moonrun could never show: moonrun's host functions are native
 * callbacks and its exports are called from Rust, so only guest (wasm) frames appear.
 */
function isHostFrame(line: string): boolean {
  const body = line.trimStart();
  if (!body.startsWith('at ')) {
    return false;
  }
  const frame = body.slice(3);
  if (frame.startsWith('async ')) {
    return true;
  }
  const open = frame.lastIndexOf(' (');
  const location = frame.endsWith(')') && open >= 0 ? frame.slice(open + 2, -1) : frame;
  return !location.startsWith('wasm://');
}

/** The exception's stack (or string form) as moonrun would see it. */
export function exceptionLines(exception: unknown): DiagnosticLine[] {
  let text: string;
  const stack =
    typeof exception === 'object' && exception !== null && 'stack' in exception
      ? exception.stack
      : undefined;
  if (stack !== undefined && stack !== null) {
    text = String(stack);
  } else {
    text = String(exception);
  }
  return text
    .split('\n')
    .filter((line) => !isHostFrame(line))
    .map(parseStackLine);
}
