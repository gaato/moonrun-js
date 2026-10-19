import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StatValues } from '../../src/kernel/file.ts';
import { packStat, statRequest } from '../../src/kernel/fs-codec.ts';

// The stat layout stays a TypeScript port (docs/reuse.md); this checks it against
// upstream filesystem/job/stat.rs compiled as is (crates/stat-layout, test-only wasm).

const wasm = readFileSync(path.join(import.meta.dirname, '../fixtures/wasm/stat-layout.wasm'));
const { exports } = new WebAssembly.Instance(new WebAssembly.Module(wasm), {});
const memory = exports['memory'] as WebAssembly.Memory;
const statPack = exports['stat_pack'] as (
  mask: number,
  capacity: number,
  present: number,
  values: number,
  out: number,
) => number;

const VALUES = [1n, 4096n, 2049n, 1234567n, 10n, 5n, 20n, 6n, 30n, 7n, -1n, 999_999_999n] as const;
// Scratch space far above the component's data and stack.
const VALUES_AT = 1 << 20;
const OUT_AT = VALUES_AT + 4096;

function rust(mask: number, capacity: number, present: number): Uint8Array | undefined {
  if (memory.buffer.byteLength < OUT_AT + 4096) {
    memory.grow(Math.ceil((OUT_AT + 4096 - memory.buffer.byteLength) / 65536));
  }
  new BigInt64Array(memory.buffer, VALUES_AT, 12).set(VALUES);
  const len = statPack(mask, capacity, present, VALUES_AT, OUT_AT);
  return len < 0 ? undefined : new Uint8Array(memory.buffer, OUT_AT, len).slice();
}

function ts(mask: number, capacity: number, present: number): Uint8Array | undefined {
  const request = statRequest(mask, capacity);
  if (request === undefined) {
    return undefined;
  }
  const has = (bit: number): boolean => (present & (1 << bit)) !== 0;
  const time = (bit: number, i: number) =>
    has(bit) ? { seconds: VALUES[i] ?? 0n, nanoseconds: VALUES[i + 1] ?? 0n } : undefined;
  const values: StatValues = {
    ...(has(0) ? { kind: 'regular' } : {}),
    ...(has(1) ? { size: VALUES[1] } : {}),
    ...(has(2) ? { deviceId: VALUES[2] } : {}),
    ...(has(3) ? { fileId: VALUES[3] } : {}),
    ...(has(4) ? { accessTime: time(4, 4) } : {}),
    ...(has(5) ? { modifyTime: time(5, 6) } : {}),
    ...(has(6) ? { changeTime: time(6, 8) } : {}),
    ...(has(7) ? { createTime: time(7, 10) } : {}),
  } as StatValues;
  return packStat(request, values);
}

describe('stat layout (fs-codec vs upstream stat.rs)', () => {
  it('agrees on every mask, presence pattern and capacity', () => {
    let cases = 0;
    for (let mask = 0; mask < 512; mask++) {
      for (const present of [0, 0xff, 0x55, 0xaa, 0x0f]) {
        for (const capacity of [0, 7, 8, 40, 200]) {
          expect(ts(mask, capacity, present)).toEqual(rust(mask, capacity, present));
          cases++;
        }
      }
    }
    expect(cases).toBe(512 * 25);
  });
});
