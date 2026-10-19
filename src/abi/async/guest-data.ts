import { FAULT } from '../../kernel/errors.ts';
import type { GuestMemory } from '../memory.ts';
import { AsyncFailure } from './env.ts';

/** `u32::checked_add` for guest pointers. */
export function checkedAdd(ptr: number, offset: number): number {
  const sum = ptr + offset;
  if (sum > 0xffff_ffff) {
    throw new AsyncFailure(FAULT);
  }
  return sum;
}

/** moonrun `write_u16`: UTF-16 units at a 2-aligned guest offset. */
export function writeUtf16(memory: GuestMemory, ptr: number, units: string): void {
  if (units.length !== 0 && ptr % 2 !== 0) {
    throw new AsyncFailure(FAULT);
  }
  const bytes = memory.view(ptr, units.length * 2);
  for (let i = 0; i < units.length; i++) {
    const unit = units.charCodeAt(i);
    bytes[2 * i] = unit & 0xff;
    bytes[2 * i + 1] = unit >> 8;
  }
}

/** A little-endian `i32` array in guest memory. */
export function readI32Array(memory: GuestMemory, ptr: number, len: number): number[] {
  const byteLength = len * 4;
  if (byteLength > 0xffff_ffff) {
    throw new AsyncFailure(FAULT);
  }
  const bytes = memory.view(ptr, byteLength);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: len }, (_, i) => data.getInt32(i * 4, true));
}

const encoder = new TextEncoder();

/** A Unix native string: UTF-8 bytes plus a NUL terminator (moonrun `copy_c_string_bytes`). */
export function cString(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}
