/**
 * Handler typing for `moonbitlang/async`, derived from the generated import table.
 * A handler's parameter and result types come from the table, so a handler cannot
 * disagree with moonrun's registry; `AsyncHandlers` requires exactly one handler
 * per non-fake symbol.
 */
import type { ASYNC_IMPORTS } from '../../generated/async-imports.ts';
import type {
  GeneratedHandler,
  GeneratedHandlers,
  GeneratedImpl,
  GeneratedSuspendingHandler,
} from '../define.ts';

type Table = typeof ASYNC_IMPORTS;

export type AsyncSymbol = keyof Table;

/** Symbols moonrun implements on Linux (everything but `fake`). */
export type ImplementedSymbol = {
  [K in AsyncSymbol]: Table[K]['kind'] extends 'fake' ? never : K;
}[AsyncSymbol];

/** The JavaScript signature of the import `K` (u32/u64 already normalized). */
export type AsyncImpl<K extends AsyncSymbol> = GeneratedImpl<Table[K]>;

/** An import that may suspend the guest (`WebAssembly.Suspending`). */
export type SuspendingHandler<K extends AsyncSymbol> = GeneratedSuspendingHandler<Table[K]>;

export type AsyncHandler<K extends AsyncSymbol> = GeneratedHandler<Table[K]>;

/** One handler for every implemented symbol. */
export type AsyncHandlers = GeneratedHandlers<Pick<Table, ImplementedSymbol>>;

/** A family's share of the handlers; object literals are checked against it for typos. */
export type HandlerGroup = Partial<AsyncHandlers>;
