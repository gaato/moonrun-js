import { wasmFunctions } from './wasm-sections.ts';

/**
 * Fallback for engines that do not resolve `wasm:js-string` builtins or imported
 * string constants natively. Natively resolved imports disappear from
 * `WebAssembly.Module.imports()`, so whatever remains is filled here
 * (moonrun's wasmtime backend does the same).
 */
const JS_STRING = 'wasm:js-string';
const CONSTANTS = '_';
const adapted = new WeakMap<WebAssembly.Module, string>();

function brokenNativeEquals(): boolean {
  // (module (import "wasm:js-string" "equals" (func (param externref externref)
  // (result i32))) (export "eq" (func 0)))
  const probe = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 111, 111, 1, 127, 2, 25, 1, 14, 119, 97, 115, 109,
    58, 106, 115, 45, 115, 116, 114, 105, 110, 103, 6, 101, 113, 117, 97, 108, 115, 0, 0, 7, 6, 1,
    2, 101, 113, 0, 0,
  ]);
  try {
    const module = new WebAssembly.Module(probe, { builtins: ['js-string'] });
    if (WebAssembly.Module.imports(module).length !== 0) return false;
    const eq = new WebAssembly.Instance(module, {}).exports['eq'] as (
      a: unknown,
      b: unknown,
    ) => number;
    return eq('x', null) !== 0 || eq(null, 'x') !== 0 || eq(null, null) !== 1;
  } catch {
    return true;
  }
}
const needsEqualsFallback = brokenNativeEquals();

/** Keep native GC-array builtins; route only a broken native equals through JS. */
export function compileStringModule(
  bytes: Uint8Array,
  options: WebAssembly.CompileOptions,
): WebAssembly.Module {
  const original = new WebAssembly.Module(bytes, options);
  if (!needsEqualsFallback) return original;
  const imports = wasmFunctions(bytes)?.imports ?? [];
  const equals = imports.filter((entry) => entry.module === JS_STRING && entry.name === 'equals');
  if (equals.length === 0) return original;
  // Same UTF-8 length: preserve code/source-map offsets. Avoid accepting an
  // unrelated import if the guest already uses our preferred namespace.
  const namespaces = new Set(imports.map((entry) => entry.module));
  let namespace = 'host:js-string';
  for (let i = 0; namespaces.has(namespace); i++)
    namespace = `${i.toString(36).padStart(4, '0')}:js-string`;
  const patched = bytes.slice();
  for (const entry of equals) patched.set(new TextEncoder().encode(namespace), entry.moduleStart);
  const module = new WebAssembly.Module(patched, options);
  adapted.set(module, namespace);
  return module;
}

function str(v: unknown): string {
  if (typeof v !== 'string') {
    throw new WebAssembly.RuntimeError('illegal cast');
  }
  return v;
}

const builtins: Record<string, (...args: never[]) => unknown> = {
  cast: (v: unknown) => str(v),
  test: (v: unknown) => (typeof v === 'string' ? 1 : 0),
  fromCharCode: (c: number) => String.fromCharCode(c & 0xffff),
  fromCodePoint: (c: number) => {
    if (c >>> 0 > 0x10ffff) {
      throw new WebAssembly.RuntimeError('invalid code point');
    }
    return String.fromCodePoint(c >>> 0);
  },
  charCodeAt: (s: unknown, i: number) => {
    const v = str(s);
    if (i >>> 0 >= v.length) {
      throw new WebAssembly.RuntimeError('string offset out of bounds');
    }
    return v.charCodeAt(i >>> 0);
  },
  codePointAt: (s: unknown, i: number) => {
    const v = str(s);
    if (i >>> 0 >= v.length) {
      throw new WebAssembly.RuntimeError('string offset out of bounds');
    }
    return v.codePointAt(i >>> 0) ?? 0;
  },
  length: (s: unknown) => str(s).length,
  concat: (a: unknown, b: unknown) => str(a) + str(b),
  substring: (s: unknown, start: number, end: number) => {
    const v = str(s);
    const st = start >>> 0;
    const en = end >>> 0;
    return st >= v.length || st > en ? '' : v.substring(st, en);
  },
  equals: (a: unknown, b: unknown) => {
    if ((a !== null && typeof a !== 'string') || (b !== null && typeof b !== 'string')) {
      throw new WebAssembly.RuntimeError('illegal cast');
    }
    return a === b ? 1 : 0;
  },
  compare: (a: unknown, b: unknown) => {
    const x = str(a);
    const y = str(b);
    return x < y ? -1 : x > y ? 1 : 0;
  },
  // GC arrays are opaque to JS, so the array builtins cannot be emulated.
  fromCharCodeArray: () => {
    throw new WebAssembly.RuntimeError(
      'wasm:js-string.fromCharCodeArray requires native js-string builtins',
    );
  },
  intoCharCodeArray: () => {
    throw new WebAssembly.RuntimeError(
      'wasm:js-string.intoCharCodeArray requires native js-string builtins',
    );
  },
};

export function stringImports(module: WebAssembly.Module): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
    if (name === CONSTANTS && kind === 'global') {
      imports[CONSTANTS] = { ...imports[CONSTANTS], [field]: field };
    } else if (
      (name === JS_STRING || (name === adapted.get(module) && field === 'equals')) &&
      kind === 'function' &&
      Object.hasOwn(builtins, field)
    ) {
      imports[name] = { ...imports[name], [field]: builtins[field] };
    }
  }
  return imports;
}
