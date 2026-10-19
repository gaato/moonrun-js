/**
 * Declarative import definitions.
 *
 * Every host import is written as `fn(params, result, impl)`. The parameter and
 * result types of `impl` are inferred from the signature tuple, so a handler can
 * never disagree with its declared signature. Unsigned types (`u32`, `u64`) are
 * normalized before `impl` sees them.
 */

/** Value types as the host sees them. `u32`/`u64` are `i32`/`i64` on the wire. */
export type ValType = 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64' | 'externref';
export type ResultType = ValType | 'void';

type JsOf<T extends ValType> = T extends 'i64' | 'u64'
  ? bigint
  : T extends 'externref'
    ? unknown
    : number;

export type JsArgs<P extends readonly ValType[]> = { -readonly [K in keyof P]: JsOf<P[K]> };
export type JsReturn<R extends ResultType> = R extends ValType ? JsOf<R> : void;

/** Signatures emitted by the upstream import-table generators. */
export interface GeneratedSignature {
  readonly params: readonly (readonly [string, ValType])[];
  readonly result: ResultType;
}

type GeneratedArgs<P extends GeneratedSignature['params']> = {
  -readonly [I in keyof P]: P[I] extends readonly [string, infer T extends ValType]
    ? JsOf<T>
    : never;
};

export type GeneratedImpl<S extends GeneratedSignature> = (
  ...args: GeneratedArgs<S['params']>
) => JsReturn<S['result']>;

export interface GeneratedSuspendingHandler<S extends GeneratedSignature> {
  readonly suspends: true;
  readonly impl: (
    ...args: GeneratedArgs<S['params']>
  ) => JsReturn<S['result']> | Promise<JsReturn<S['result']>>;
}

export type GeneratedHandler<S extends GeneratedSignature> =
  | GeneratedImpl<S>
  | GeneratedSuspendingHandler<S>;

export type GeneratedHandlers<T extends { readonly [K in keyof T]: GeneratedSignature }> = {
  readonly [K in keyof T]: GeneratedHandler<T[K]>;
};

export interface FunctionImport {
  readonly kind: 'function';
  readonly params: readonly ValType[];
  readonly result: ResultType;
  /** True when the host may need to wait; such imports are wrapped with `WebAssembly.Suspending`. */
  readonly suspends: boolean;
  readonly impl: (...args: never[]) => unknown;
}

/** A non-function import (tag, memory, global) provided as a ready value. */
export interface ValueImport {
  readonly kind: 'value';
  readonly value: unknown;
}

export type ImportDef = FunctionImport | ValueImport;

/** Imports of one wasm import module, keyed by field name. */
export type ModuleImports = Readonly<Record<string, ImportDef>>;

export function fn<const P extends readonly ValType[], const R extends ResultType>(
  params: P,
  result: R,
  impl: (...args: JsArgs<P>) => JsReturn<R>,
): FunctionImport {
  return { kind: 'function', params, result, suspends: false, impl };
}

/** An import that may return a promise; the guest is suspended until it settles. */
export function suspending<const P extends readonly ValType[], const R extends ResultType>(
  params: P,
  result: R,
  impl: (...args: JsArgs<P>) => JsReturn<R> | Promise<JsReturn<R>>,
): FunctionImport {
  return { kind: 'function', params, result, suspends: true, impl };
}

export function value(v: unknown): ValueImport {
  return { kind: 'value', value: v };
}

/** The wasm-level type of a host value type. */
export function wireType(t: ValType): 'i32' | 'i64' | 'f32' | 'f64' | 'externref' {
  switch (t) {
    case 'u32':
      return 'i32';
    case 'u64':
      return 'i64';
    default:
      return t;
  }
}

/** Converts raw wasm arguments to the host view declared by `params`. */
export function normalizeArgs(params: readonly ValType[], args: unknown[]): unknown[] {
  for (let i = 0; i < params.length; i++) {
    const t = params[i];
    const a = args[i];
    if (t === 'u32' && typeof a === 'number') {
      args[i] = a >>> 0;
    } else if (t === 'u64' && typeof a === 'bigint') {
      args[i] = BigInt.asUintN(64, a);
    }
  }
  return args;
}
