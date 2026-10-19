/**
 * Handler typing for `moonbitlang/async`, derived from the generated import table.
 * A handler's parameter and result types come from the table, so a handler cannot
 * disagree with moonrun's registry; `AsyncHandlers` requires exactly one handler
 * per non-fake symbol.
 */
import type { ASYNC_IMPORTS } from '../../generated/async-imports.ts';

type Table = typeof ASYNC_IMPORTS;

export type AsyncSymbol = keyof Table;

/** Symbols moonrun implements on Linux (everything but `fake`). */
export type ImplementedSymbol = {
  [K in AsyncSymbol]: Table[K]['kind'] extends 'fake' ? never : K;
}[AsyncSymbol];

type JsOf<T> = T extends 'i64' | 'u64' ? bigint : T extends 'i32' | 'u32' ? number : never;

type ArgsOf<P> = {
  -readonly [I in keyof P]: P[I] extends readonly [string, infer T] ? JsOf<T> : never;
};

type ReturnOf<R> = R extends 'void' ? void : JsOf<R>;

/** The JavaScript signature of the import `K` (u32/u64 already normalized). */
export type AsyncImpl<K extends AsyncSymbol> = (
  ...args: ArgsOf<Table[K]['params']>
) => ReturnOf<Table[K]['result']>;

/** An import that may suspend the guest (`WebAssembly.Suspending`). */
export interface SuspendingHandler<K extends AsyncSymbol> {
  readonly suspends: true;
  readonly impl: (
    ...args: ArgsOf<Table[K]['params']>
  ) => ReturnOf<Table[K]['result']> | Promise<ReturnOf<Table[K]['result']>>;
}

export type AsyncHandler<K extends AsyncSymbol> = AsyncImpl<K> | SuspendingHandler<K>;

/** One handler for every implemented symbol. */
export type AsyncHandlers = { readonly [K in ImplementedSymbol]: AsyncHandler<K> };

/** A family's share of the handlers; object literals are checked against it for typos. */
export type HandlerGroup = Partial<AsyncHandlers>;
