import type { ImportFamily, RunContext } from '../abi/context.ts';
import { type FunctionImport, normalizeArgs } from '../abi/define.ts';
import { TerminationSignal } from '../kernel/termination.ts';

export interface BuiltImports {
  readonly imports: WebAssembly.Imports;
  /** True when some import may suspend, so exports must run under `WebAssembly.promising`. */
  readonly suspends: boolean;
}

function wrap(def: FunctionImport): unknown {
  const { params, impl } = def;
  const unsigned = params.some((p) => p === 'u32' || p === 'u64');
  const call = impl as (...args: unknown[]) => unknown;
  const wrapper = (...args: unknown[]): unknown => {
    try {
      return call(...(unsigned ? normalizeArgs(params, args) : args));
    } catch (e) {
      // Restart the stack at the guest frame that called this import, as a
      // native moonrun callback would.
      if (
        (e instanceof Error && !(e instanceof TerminationSignal)) ||
        e instanceof WebAssembly.Exception
      ) {
        Error.captureStackTrace(e, wrapper);
      }
      throw e;
    }
  };
  return def.suspends ? new WebAssembly.Suspending(wrapper) : wrapper;
}

/**
 * Builds the import object for `module`. Like moonrun, every known import module is
 * an object even when the guest needs a field we lack, so link errors read the same.
 */
export function buildImports(
  module: WebAssembly.Module,
  ctx: RunContext,
  families: Readonly<Record<string, ImportFamily>>,
  extra: WebAssembly.Imports,
): BuiltImports {
  const imports: WebAssembly.Imports = {};
  const built = new Map<string, ReturnType<ImportFamily>>();
  let suspends = false;
  for (const { module: name, name: field } of WebAssembly.Module.imports(module)) {
    const extraModule = extra[name];
    if (extraModule !== undefined) {
      imports[name] = extraModule;
      continue;
    }
    const family = families[name];
    if (family === undefined) {
      continue;
    }
    let defs = built.get(name);
    if (defs === undefined) {
      defs = family(ctx);
      built.set(name, defs);
    }
    const target = imports[name] ?? {};
    imports[name] = target;
    const def = Object.hasOwn(defs, field) ? defs[field] : undefined;
    if (def === undefined || Object.hasOwn(target, field)) {
      continue;
    }
    if (def.kind === 'value') {
      target[field] = def.value;
    } else {
      target[field] = wrap(def);
      suspends ||= def.suspends;
    }
  }
  return { imports, suspends };
}
