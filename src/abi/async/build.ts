import { ASYNC_IMPORTS, ASYNC_MODULE } from '../../generated/async-imports.ts';
import {
  fn,
  type ImportDef,
  type JsArgs,
  type ModuleImports,
  type ResultType,
  suspending,
  type ValType,
} from '../define.ts';
import { GuestFault } from '../memory.ts';
import { AsyncFailure, debugOf } from './env.ts';
import type { AsyncHandler, AsyncHandlers, AsyncSymbol, ImplementedSymbol } from './types.ts';

type Entry = (typeof ASYNC_IMPORTS)[AsyncSymbol];
type AnyImpl = (...args: unknown[]) => unknown;

/** moonrun's host-error text for a failed import. */
function hostError(symbol: string, e: unknown): unknown {
  if (e instanceof AsyncFailure) {
    return new Error(`${ASYNC_MODULE}.${symbol} failed: ${debugOf(e.error)}`);
  }
  if (e instanceof GuestFault) {
    return new Error(`${ASYNC_MODULE}.${symbol} failed: Fault`);
  }
  return e;
}

function signature(entry: Entry): { params: readonly ValType[]; result: ResultType } {
  return { params: entry.params.map(([, type]) => type), result: entry.result };
}

function define(symbol: string, entry: Entry, handler: AsyncHandler<AsyncSymbol>): ImportDef {
  const { params, result } = signature(entry);
  const suspends = typeof handler !== 'function';
  const impl = (suspends ? handler.impl : handler) as AnyImpl;
  const guarded = (...args: unknown[]): unknown => {
    let value: unknown;
    try {
      value = impl(...args);
    } catch (e) {
      throw hostError(symbol, e);
    }
    if (value instanceof Promise) {
      return value.catch((e: unknown) => {
        throw hostError(symbol, e);
      });
    }
    return value;
  };
  // The table is the signature; `AsyncHandler` already tied the handler's types to it.
  const typed = guarded as (...args: JsArgs<readonly ValType[]>) => never;
  return suspends ? suspending(params, result, typed) : fn(params, result, typed);
}

/** A platform-inactive import: links, but must never be called on Linux. */
function fake(symbol: string, entry: Entry): ImportDef {
  const { params, result } = signature(entry);
  return fn(params, result, (): never => {
    throw new Error(`platform-inactive ${ASYNC_MODULE} import \`${symbol}\` was called`);
  });
}

function isImplemented(symbol: AsyncSymbol): symbol is ImplementedSymbol {
  return ASYNC_IMPORTS[symbol].kind !== 'fake';
}

/** Every `moonbitlang/async` import: the handlers plus generated stubs for fake symbols. */
export function buildAsyncImports(handlers: AsyncHandlers): ModuleImports {
  const imports: Record<string, ImportDef> = {};
  for (const symbol of Object.keys(ASYNC_IMPORTS) as AsyncSymbol[]) {
    const entry = ASYNC_IMPORTS[symbol];
    imports[symbol] = isImplemented(symbol)
      ? define(symbol, entry, handlers[symbol] as AsyncHandler<AsyncSymbol>)
      : fake(symbol, entry);
  }
  return imports;
}
