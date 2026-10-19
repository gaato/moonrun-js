/**
 * Fallback for engines that do not resolve `wasm:js-string` builtins or imported
 * string constants natively. Natively resolved imports disappear from
 * `WebAssembly.Module.imports()`, so whatever remains is filled here
 * (moonrun's wasmtime backend does the same).
 */
const JS_STRING = 'wasm:js-string';
const CONSTANTS = '_';

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
    } else if (name === JS_STRING && kind === 'function' && Object.hasOwn(builtins, field)) {
      imports[JS_STRING] = { ...imports[JS_STRING], [field]: builtins[field] };
    }
  }
  return imports;
}
