import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';

const MODULE = 'moonbit:ffi/memory-sanitizer';
/** moonrun captures `StackTrace::current_stack_trace(scope, 32)`. */
const STACK_FRAMES = 32;

/** Raw function names of the current guest frames, innermost first (moonrun `capture_stack`). */
function captureGuestStack(): string[] {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES + 16;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  return stack
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      const frame = guestFrame(line);
      return frame === undefined ? [] : [frame.name];
    })
    .slice(0, STACK_FRAMES);
}

function failure(name: string, message: string): Error {
  return new Error(`${MODULE}.${name} failed: ${message}`);
}

/**
 * `moonbit:ffi/memory-sanitizer` (the V8 adapter, v8/memory_sanitizer.rs): the state and
 * texts are upstream's memory_sanitizer.rs in moonrun-diag; this captures the guest stack
 * and turns failures into the adapter's host errors. Leaks are reported only when the
 * run completes normally.
 */
export const memorySanitizer: ImportFamily = (ctx) => {
  const sanitizer = ctx.diagnostics.sanitizer();
  ctx.onTeardown(() => sanitizer.dispose());
  ctx.onCompleted(() => sanitizer.checkLeaks());
  return {
    'register-object-alloc': fn(['u32', 'u32'], 'void', (size, ptr) => {
      const error = sanitizer.registerAlloc(size, ptr, captureGuestStack());
      if (error !== undefined) {
        throw failure('register-object-alloc', error);
      }
    }),
    'register-object-free': fn(['u32'], 'void', (ptr) => {
      const error = sanitizer.registerFree(ptr);
      if (error !== undefined) {
        throw failure('register-object-free', error);
      }
    }),
    'object-is-valid': fn(['u32'], 'i32', (ptr) => (sanitizer.isValid(ptr) ? 1 : 0)),
  };
};

export const MEMORY_SANITIZER_MODULE = MODULE;

import { guestFrame } from '../../diagnostics/stack.ts';
