import { describe, expect, it } from 'vitest';
import type { ModuleImports } from '../../src/abi/define.ts';
import { lossyString, valueHelpers } from '../../src/abi/legacy/fs-values.ts';

function call(imports: ModuleImports, name: string, ...args: unknown[]): unknown {
  const def = imports[name];
  if (def === undefined || def.kind !== 'function') {
    throw new Error(`no import ${name}`);
  }
  return (def.impl as (...a: unknown[]) => unknown)(...args);
}

function buildString(h: ModuleImports, units: number[]): unknown {
  const builder = call(h, 'begin_create_string');
  for (const u of units) {
    call(h, 'string_append_char', builder, u);
  }
  return call(h, 'finish_create_string', builder);
}

describe('value helpers', () => {
  it('builds strings keeping unpaired surrogates', () => {
    const h = valueHelpers();
    expect(buildString(h, [0x68, 0xd83d, 0x69])).toBe('h\ud83di');
    expect(buildString(h, [0x1_0041])).toBe('A');
    expect(buildString(h, [])).toBe('');
  });

  it('builds long strings past the initial capacity', () => {
    const h = valueHelpers();
    const units = Array.from({ length: 20000 }, (_, i) => 0x41 + (i % 26));
    expect(buildString(h, units)).toBe(String.fromCharCode(...units));
  });

  it('builds byte arrays truncating to a byte', () => {
    const h = valueHelpers();
    const b = call(h, 'begin_create_byte_array');
    for (const v of [1, 300, -1]) {
      call(h, 'byte_array_append_byte', b, v);
    }
    expect(call(h, 'finish_create_byte_array', b)).toEqual(new Uint8Array([1, 44, 255]));
  });

  it('reads code units until -1', () => {
    const h = valueHelpers();
    const r = call(h, 'begin_read_string', 'a😀');
    const units = [0, 0, 0, 0].map(() => call(h, 'string_read_char', r));
    expect(units).toEqual([0x61, 0xd83d, 0xde00, -1]);
    expect(call(h, 'string_read_char', r)).toBe(-1);
  });

  it('reads live array elements and ends with the sentinel', () => {
    const h = valueHelpers();
    const source = ['x'];
    const r = call(h, 'begin_read_string_array', source);
    expect(call(h, 'string_array_read_string', r)).toBe('x');
    source.push('y');
    expect(call(h, 'string_array_read_string', r)).toBe('y');
    expect(call(h, 'string_array_read_string', r)).toBe('ffi_end_of_/string_array');
    const bytes = call(h, 'begin_read_byte_array', new Uint8Array([7]));
    expect([
      call(h, 'byte_array_read_byte', bytes),
      call(h, 'byte_array_read_byte', bytes),
    ]).toEqual([7, -1]);
  });

  it('rejects foreign or mismatched handles with TypeError', () => {
    const h = valueHelpers();
    const bytes = call(h, 'begin_create_byte_array');
    expect(() => call(h, 'string_append_char', null, 1)).toThrow(
      new TypeError('Expected a Moonrun builder or reader'),
    );
    expect(() => call(h, 'string_append_char', bytes, 1)).toThrow(
      new TypeError('Incorrect Moonrun builder or reader type'),
    );
    expect(() => call(h, 'string_read_char', call(h, 'begin_read_string', 1))).toThrow(
      new TypeError('Expected a string'),
    );
    expect(() => call(h, 'array_len', undefined)).toThrow(TypeError);
  });

  it('does not share handles between runs', () => {
    const a = valueHelpers();
    const b = valueHelpers();
    const builder = call(a, 'begin_create_string');
    expect(() => call(b, 'string_append_char', builder, 1)).toThrow(TypeError);
  });

  it('answers array_len, array_get and jsvalue_is_string', () => {
    const h = valueHelpers();
    expect(call(h, 'array_len', ['a', 'b'])).toBe(2);
    expect(call(h, 'array_get', ['a', 'b'], 1)).toBe('b');
    expect(call(h, 'jsvalue_is_string', 's')).toBe(1);
    expect(call(h, 'jsvalue_is_string', 1)).toBe(0);
  });

  it('converts lossy strings', () => {
    expect(lossyString('a\ud800b')).toBe('a�b');
    expect(lossyString(12)).toBe('12');
  });
});
