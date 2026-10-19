import type { ImportFamily } from '../context.ts';
import { fn, value } from '../define.ts';

function bytes(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array)) {
    throw new TypeError('Expected a Uint8Array');
  }
  if (v.buffer instanceof ArrayBuffer && v.buffer.detached) {
    throw new TypeError('Cannot operate on a detached ArrayBuffer');
  }
  return v;
}

/** moonrun `relative_index`: truncate, negative counts from the end, clamp to [0, length]. */
function relativeIndex(index: number, length: number): number {
  const i = Math.trunc(index);
  if (Number.isNaN(i)) {
    return 0;
  }
  return i < 0 ? Math.min(Math.max(length + i, 0), length) : Math.min(i, length);
}

function range(start: number, len: number, length: number): readonly [number, number] {
  const end = relativeIndex(start + len, length);
  return [Math.min(relativeIndex(start, length), end), end];
}

/**
 * `ffi-bytes`: Uint8Array helpers with their own one-page memory, separate from the
 * guest's (moonrun `v8/ffi_bytes.rs`).
 */
export const ffiBytes: ImportFamily = () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
    from_memory: fn(['i32', 'i32'], 'externref', (offset, length) => {
      const [s, e] = range(offset, length, memory.buffer.byteLength);
      return new Uint8Array(memory.buffer.slice(s, e));
    }),
    new: fn(['i32'], 'externref', (length) => {
      if (length < 0) {
        throw new RangeError('Invalid typed array length');
      }
      return new Uint8Array(length);
    }),
    get: fn(['externref', 'i32'], 'i32', (b, index) => bytes(b)[index] ?? 0),
    // Returns the assigned value, like the JS assignment moonrun performs.
    set: fn(['externref', 'i32', 'i32'], 'i32', (b, index, v) => {
      bytes(b)[index] = v;
      return v;
    }),
    copy: fn(
      ['externref', 'i32', 'externref', 'i32', 'i32'],
      'void',
      (dst, dstOff, src, srcOff, len) => {
        const source = bytes(src);
        const destination = bytes(dst);
        const [s, e] = range(srcOff, len, source.length);
        const n = e - s;
        const d = Number.isNaN(dstOff) ? 0 : Math.trunc(dstOff);
        if (d < 0 || d > Math.max(destination.length - n, 0) || n > destination.length) {
          throw new RangeError('Source is too large for the destination byte array');
        }
        destination.set(source.subarray(s, e), d);
      },
    ),
    // Returns the array, like `Uint8Array.prototype.fill`.
    fill: fn(['externref', 'i32', 'i32', 'i32'], 'externref', (b, start, v, len) => {
      const a = bytes(b);
      const [s, e] = range(start, len, a.length);
      return a.fill(v & 0xff, s, e);
    }),
    length: fn(['externref'], 'i32', (b) => bytes(b).length),
    equals: fn(['externref', 'externref'], 'i32', (a, b) => {
      const x = bytes(a);
      const y = bytes(b);
      return x.length === y.length && x.every((v, i) => v === y[i]) ? 1 : 0;
    }),
    asString: fn(['externref', 'i32', 'i32'], 'externref', (b, start, len) => {
      const a = bytes(b);
      const [s, e] = range(start, len, a.length);
      const units = new Uint16Array(Math.floor((e - s) / 2));
      for (let i = 0; i < units.length; i++) {
        units[i] = (a[s + 2 * i] ?? 0) | ((a[s + 2 * i + 1] ?? 0) << 8);
      }
      let out = '';
      for (let i = 0; i < units.length; i += 8192) {
        out += String.fromCharCode(...units.subarray(i, i + 8192));
      }
      return out;
    }),
    memory: value(memory),
  };
};
