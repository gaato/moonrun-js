import { TerminationSignal } from '../../kernel/termination.ts';
import type { ImportFamily, RunContext } from '../context.ts';
import { fn } from '../define.ts';

export function requestExit(ctx: RunContext, code: number): never {
  ctx.termination.request({ kind: 'exit', code });
  throw new TerminationSignal();
}

export const sys: ImportFamily = (ctx) => ({
  exit: fn(['i32'], 'void', (code) => requestExit(ctx, code)),
  // moonrun-js always presents a Linux-shaped platform.
  is_windows: fn([], 'i32', () => 0),
});
