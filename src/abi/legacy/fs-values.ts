import type { ModuleImports } from '../define.ts';
import { fn } from '../define.ts';

/** V8's `String::MAX_LENGTH` on 64-bit. */
const MAX_STRING_LENGTH = 2 ** 29 - 24;
const MAX_BYTE_ARRAY_LENGTH = 2 ** 32 - 1;
const END_OF_STRING_ARRAY = 'ffi_end_of_/string_array';

/** `args.string_lossy`: ToString, then unpaired surrogates become U+FFFD. */
export function lossyString(v: unknown): string {
  return String(v).toWellFormed();
}

/** Growable unit buffer; unlike a JS string it keeps unpaired surrogates. */
class Growable<A extends Uint8Array | Uint16Array> {
  #data: A;
  #used = 0;
  readonly #alloc: (length: number) => A;

  constructor(alloc: (length: number) => A) {
    this.#alloc = alloc;
    this.#data = alloc(0);
  }

  get used(): number {
    return this.#used;
  }

  push(unit: number): void {
    if (this.#used === this.#data.length) {
      const grown = this.#alloc(Math.max(64, this.#data.length * 2));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data[this.#used++] = unit;
  }

  units(): A {
    return this.#data.subarray(0, this.#used) as A;
  }
}

/** The brand of one kind of builder or reader; handles of another kind are rejected. */
class HandleType {}

class Handle {
  readonly type: HandleType;
  readonly payload: unknown;
  position = 0;

  constructor(type: HandleType, payload: unknown) {
    this.type = type;
    this.payload = payload;
  }
}

function handleOf(type: HandleType, value: unknown): Handle {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('Expected a Moonrun builder or reader');
  }
  if (!(value instanceof Handle) || value.type !== type) {
    throw new TypeError('Incorrect Moonrun builder or reader type');
  }
  return value;
}

function builderOf<A extends Uint8Array | Uint16Array>(
  type: HandleType,
  value: unknown,
): Growable<A> {
  const handle = handleOf(type, value);
  if (!(handle.payload instanceof Growable)) {
    throw new TypeError('Incorrect Moonrun builder or reader type');
  }
  return handle.payload as Growable<A>;
}

function toObject(v: unknown): object {
  if (v === null || v === undefined) {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  return Object(v);
}

function propertyKey(v: unknown): PropertyKey {
  return typeof v === 'number' || typeof v === 'symbol' ? v : String(v);
}

function lengthOf(v: unknown): unknown {
  return Reflect.get(toObject(v), 'length');
}

function newBuilder<A extends Uint8Array | Uint16Array>(
  type: HandleType,
  alloc: (length: number) => A,
): Handle {
  return new Handle(type, new Growable(alloc));
}

function createString(units: Uint16Array): string {
  let out = '';
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.subarray(i, i + 8192));
  }
  return out;
}

function readCodeUnit(type: HandleType, value: unknown): number {
  const reader = handleOf(type, value);
  if (typeof reader.payload !== 'string') {
    throw new TypeError('Expected a string');
  }
  if (reader.position >= reader.payload.length) {
    return -1;
  }
  return reader.payload.charCodeAt(reader.position++);
}

/** Reads from the live source on every call, so later mutations are seen. */
function readElement(type: HandleType, value: unknown, end: unknown): unknown {
  const reader = handleOf(type, value);
  const source = toObject(reader.payload);
  if (reader.position >= Number(Reflect.get(source, 'length'))) {
    return end;
  }
  return Reflect.get(source, reader.position++);
}

/**
 * The value helpers of `__moonbit_fs_unstable`: opaque string and byte-array
 * builders and readers over JS values (moonrun `filesystem/v8/values.rs`).
 */
export function valueHelpers(): ModuleImports {
  const stringBuilder = new HandleType();
  const byteBuilder = new HandleType();
  const stringReader = new HandleType();
  const byteReader = new HandleType();
  const stringArrayReader = new HandleType();
  const noop = fn(['externref'], 'void', () => {});
  return {
    begin_create_string: fn([], 'externref', () =>
      newBuilder(stringBuilder, (n) => new Uint16Array(n)),
    ),
    string_append_char: fn(['externref', 'i32'], 'void', (handle, unit) => {
      const builder = builderOf<Uint16Array>(stringBuilder, handle);
      if (builder.used >= MAX_STRING_LENGTH) {
        throw new RangeError('Invalid string length');
      }
      builder.push(unit & 0xffff);
    }),
    finish_create_string: fn(['externref'], 'externref', (handle) =>
      createString(builderOf<Uint16Array>(stringBuilder, handle).units()),
    ),
    begin_create_byte_array: fn([], 'externref', () =>
      newBuilder(byteBuilder, (n) => new Uint8Array(n)),
    ),
    byte_array_append_byte: fn(['externref', 'i32'], 'void', (handle, byte) => {
      const builder = builderOf<Uint8Array>(byteBuilder, handle);
      if (builder.used >= MAX_BYTE_ARRAY_LENGTH) {
        throw new RangeError('Invalid array length');
      }
      builder.push(byte & 0xff);
    }),
    finish_create_byte_array: fn(['externref'], 'externref', (handle) =>
      builderOf<Uint8Array>(byteBuilder, handle).units().slice(),
    ),
    begin_read_string: fn(['externref'], 'externref', (s) => new Handle(stringReader, s)),
    string_read_char: fn(['externref'], 'i32', (h) => readCodeUnit(stringReader, h)),
    begin_read_byte_array: fn(['externref'], 'externref', (a) => new Handle(byteReader, a)),
    byte_array_read_byte: fn(['externref'], 'externref', (h) => readElement(byteReader, h, -1)),
    begin_read_string_array: fn(
      ['externref'],
      'externref',
      (a) => new Handle(stringArrayReader, a),
    ),
    string_array_read_string: fn(['externref'], 'externref', (h) =>
      readElement(stringArrayReader, h, END_OF_STRING_ARRAY),
    ),
    // finish operations do not invalidate a reader
    finish_read_string: noop,
    finish_read_byte_array: noop,
    finish_read_string_array: noop,
    array_len: fn(['externref'], 'externref', lengthOf),
    array_get: fn(['externref', 'externref'], 'externref', (array, index) =>
      Reflect.get(toObject(array), propertyKey(index)),
    ),
    jsvalue_is_string: fn(['externref'], 'i32', (v) => (typeof v === 'string' ? 1 : 0)),
  };
}
