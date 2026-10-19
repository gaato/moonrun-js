import { demangleMangledFunctionName } from '../../diagnostics/demangle.ts';
import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';

const MODULE = 'moonbit:ffi/memory-sanitizer';
/** moonrun captures `StackTrace::current_stack_trace(scope, 32)`. */
const STACK_FRAMES = 32;

interface LiveObject {
  readonly size: number;
  readonly stack: readonly string[];
}

/** Raw function names of the current guest frames, innermost first (moonrun `capture_stack`). */
function captureGuestStack(): string[] {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES + 16;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at /, ''));
  // Host frames above the guest do not exist in moonrun (its callbacks are native).
  const firstGuest = frames.findIndex((f) => f.includes('wasm://'));
  if (firstGuest < 0) {
    return [];
  }
  return frames
    .slice(firstGuest, firstGuest + STACK_FRAMES)
    .filter((f) => f.includes('wasm://'))
    .map((f) => {
      const open = f.lastIndexOf(' (');
      return f.endsWith(')') && open >= 0 ? f.slice(0, open) : '<anonymous>';
    });
}

function formatStack(stack: readonly string[], title: string): string {
  if (stack.length === 0) {
    return '';
  }
  return `\n${title}:${stack.map((f) => `\n    at ${demangleMangledFunctionName(f)}`).join('')}`;
}

function failure(name: string, message: string): Error {
  return new Error(`${MODULE}.${name} failed: ${message}`);
}

/** `moonbit:ffi/memory-sanitizer`. Leaks are reported only when the run completes normally. */
export const memorySanitizer: ImportFamily = (ctx) => {
  const live = new Map<number, LiveObject>();
  ctx.onCompleted(() => leakReport(live));
  return {
    'register-object-alloc': fn(['u32', 'u32'], 'void', (size, ptr) => {
      const existing = live.get(ptr);
      if (existing !== undefined) {
        throw failure(
          'register-object-alloc',
          `object ${ptr} is already live with size ${existing.size}${formatStack(existing.stack, 'previous allocation stack')}`,
        );
      }
      live.set(ptr, { size, stack: captureGuestStack() });
    }),
    'register-object-free': fn(['u32'], 'void', (ptr) => {
      if (!live.delete(ptr)) {
        throw failure('register-object-free', `invalid object ${ptr}`);
      }
    }),
    'object-is-valid': fn(['u32'], 'i32', (ptr) => (live.has(ptr) ? 1 : 0)),
  };
};

function leakReport(live: ReadonlyMap<number, LiveObject>): string | undefined {
  if (live.size === 0) {
    return undefined;
  }
  // moonrun keeps live objects in a BTreeMap, so the report is ordered by address.
  const entries = [...live.entries()].sort(([a], [b]) => a - b);
  const total = entries.reduce((sum, [, o]) => sum + o.size, 0);
  let report = `moonrun memory sanitizer detected ${live.size} leaked object${live.size === 1 ? '' : 's'} (${total} bytes)`;
  for (const [ptr, object] of entries) {
    report += `\nleaked object ${ptr} (${object.size} bytes)${formatStack(object.stack, 'allocation stack')}`;
  }
  return report;
}

export const MEMORY_SANITIZER_MODULE = MODULE;
