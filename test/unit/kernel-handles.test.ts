import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asHandle, type Handle, Handles, HostKeys, NULL_HANDLE } from '../../src/kernel/handles.ts';
import { ResourceTable } from '../../src/kernel/resource.ts';

const h = (v: bigint): Handle => asHandle(v);

describe('HostKeys', () => {
  it('encodes keys like slotmap KeyData::as_ffi', () => {
    const keys = new HostKeys();
    expect(keys.insert('job')).toBe(0x1_0000_0001n);
    expect(keys.insert('poll')).toBe(0x1_0000_0002n);
    expect(NULL_HANDLE).toBe(0x1_ffff_ffffn);
    expect(keys.kind(NULL_HANDLE)).toBeUndefined();
    expect(keys.kind(h(0n))).toBeUndefined();
  });

  it('reuses freed slots LIFO with the next odd version', () => {
    const keys = new HostKeys();
    const a = keys.insert('job');
    const b = keys.insert('job');
    expect(keys.remove(a)).toBe('job');
    expect(keys.remove(b)).toBe('job');
    // b was freed last, so its slot comes back first, at version 3.
    expect(keys.insert('poll')).toBe(0x3_0000_0002n);
    expect(keys.insert('poll')).toBe(0x3_0000_0001n);
    expect(keys.insert('poll')).toBe(0x1_0000_0003n);
    expect(keys.kind(a)).toBeUndefined();
    expect(keys.kind(b)).toBeUndefined();
  });

  it('treats an even version like slotmap from_ffi (forced odd)', () => {
    const keys = new HostKeys();
    const a = keys.insert('job');
    expect(keys.kind(h(a & 0xffff_ffffn))).toBe('job');
    expect(keys.kind(h(a + 0x1_0000_0000n))).toBeUndefined();
  });

  it('matches a model under random insert/remove sequences', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.constant(-1), fc.nat(40)), { maxLength: 200 }), (ops) => {
        const keys = new HostKeys();
        const live: Handle[] = [];
        const dead = new Set<Handle>();
        for (const op of ops) {
          if (op === -1 || live.length === 0) {
            const handle = keys.insert('resource');
            expect(live).not.toContain(handle);
            expect(dead.has(handle)).toBe(false);
            expect(handle).not.toBe(NULL_HANDLE);
            live.push(handle);
          } else {
            const [handle] = live.splice(op % live.length, 1);
            if (handle !== undefined) {
              expect(keys.remove(handle)).toBe('resource');
              expect(keys.remove(handle)).toBeUndefined();
              dead.add(handle);
            }
          }
          for (const handle of live) {
            expect(keys.kind(handle)).toBe('resource');
          }
          for (const handle of dead) {
            expect(keys.kind(handle)).toBeUndefined();
          }
          expect(keys.size).toBe(live.length);
        }
      }),
    );
  });
});

describe('Handles', () => {
  it('validates both the central kind and table membership', () => {
    const keys = new HostKeys();
    const first = new Handles<number>(keys, 'c-buffer');
    const second = new Handles<number>(keys, 'c-buffer');
    const other = new Handles<number>(keys, 'addr-info');
    const a = first.insert(1);
    const b = second.insert(2);
    const c = other.insert(3);
    for (const key of [NULL_HANDLE, b, c]) {
      expect(first.get(key)).toBeUndefined();
      expect(first.remove(key)).toBeUndefined();
    }
    expect(first.remove(a)).toBe(1);
    expect(keys.kind(a)).toBeUndefined();
    const replacement = other.insert(4);
    expect(replacement).not.toBe(a);
    expect(other.get(a)).toBeUndefined();
  });

  it('takeAll retires every key', () => {
    const keys = new HostKeys();
    const table = new Handles<string>(keys, 'worker');
    const a = table.insert('a');
    const b = table.insert('b');
    expect(table.takeAll()).toEqual(['a', 'b']);
    expect(keys.kind(a)).toBeUndefined();
    expect(keys.kind(b)).toBeUndefined();
    expect(table.size).toBe(0);
  });
});

describe('ResourceTable', () => {
  it('reserves invalid and stdio handles first', () => {
    const keys = new HostKeys();
    const table = new ResourceTable(keys);
    expect(table.invalidHandle).toBe(0x1_0000_0001n);
    expect([table.stdioHandle(0), table.stdioHandle(1), table.stdioHandle(2)]).toEqual([
      0x1_0000_0002n,
      0x1_0000_0003n,
      0x1_0000_0004n,
    ]);
    expect(table.get(table.invalidHandle)).toEqual({ ok: false, error: { kind: 'badf' } });
    expect(table.get(table.stdioHandle(1)).ok).toBe(true);
    // Reserved handles cannot be closed.
    expect(table.remove(table.stdioHandle(1)).ok).toBe(false);
    expect(table.remove(table.invalidHandle).ok).toBe(false);
    expect(table.get(table.stdioHandle(1)).ok).toBe(true);
  });
});
