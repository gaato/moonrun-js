import type { ImportFamily } from '../context.ts';
import { fn, value } from '../define.ts';

export const exception: ImportFamily = () => {
  const tag = new WebAssembly.Tag({ parameters: [] });
  const throwImpl = (): never => {
    const e = new WebAssembly.Exception(tag, []);
    // Equivalent of `traceStack: true`, but starting at the guest frame that called `throw`.
    Error.captureStackTrace(e, throwImpl);
    throw e;
  };
  return {
    tag: value(tag),
    throw: fn([], 'void', throwImpl),
  };
};
