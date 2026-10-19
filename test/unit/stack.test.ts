import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { guestFrame } from '../../src/diagnostics/stack.ts';
import { exceptionLines, parseStackLine, rememberFunctionBodies } from '../../src/engine/stack.ts';

describe('runtime stacks', () => {
  it('keeps Node anonymous locations and normalizes Deno labels', () => {
    const location = 'wasm://wasm/abcd:wasm-function[0]:0x23';
    expect(parseStackLine(`    at <anonymous> (${location})`)).toEqual(
      parseStackLine(`    at ${location}`),
    );
  });

  it.each([false, true])('recovers Deno anonymous indices with native builtins=%s', (native) => {
    const result = spawnSync('wasm-tools', ['parse', '-'], {
      input: `(module ${native ? '(import "wasm:js-string" "length" (func (param externref) (result i32)))' : '(import "m" "f" (func))'} (func nop) (func (export "trap") unreachable))`,
    });
    expect(result.status).toBe(0);
    const bytes = new Uint8Array(result.stdout);
    const module = new WebAssembly.Module(bytes, native ? { builtins: ['js-string'] } : {});
    rememberFunctionBodies(module, bytes);
    const instance = new WebAssembly.Instance(module, { m: { f: () => {} } });
    let stack = '';
    try {
      (instance.exports['trap'] as () => void)();
    } catch (e) {
      stack = e instanceof Error ? (e.stack ?? '') : '';
    }
    const location = /wasm:\/\/wasm\/[^)\s]+/.exec(stack)?.[0];
    expect(location).toBeDefined();
    if (location === undefined) return;
    const deno = location.replace(/wasm-function\[\d+\]/, 'wasm-function[0]');
    const frame = parseStackLine(`    at <anonymous> (${deno})`, module);
    expect(frame).toMatchObject({ kind: 'frame', fn: location });
    expect(location).toContain('wasm-function[2]');
  });

  it('parses JSC wasm frames and drops its JavaScript callers', () => {
    expect(
      exceptionLines({
        stack: "RuntimeError: Unreachable code should not be executed (evaluating 'f(...args)')",
      }),
    ).toEqual([{ kind: 'text', text: 'RuntimeError: unreachable' }]);
    expect(exceptionLines({ stack: 'Error\nf@[wasm code]\nrun@file:///app.ts:10:4' })).toEqual([
      { kind: 'text', text: 'Error' },
      { kind: 'frame', indentation: '    ', fn: 'f', moduleOffset: undefined },
    ]);
    expect(guestFrame('    at unknown')).toEqual({ name: '<anonymous>', location: undefined });
    expect(guestFrame('    at host (file:///app.ts:1:2)')).toBeUndefined();
    expect(guestFrame('    at <anonymous> (wasm://wasm/a:wasm-function[0]:0x23)')?.name).toBe(
      '<anonymous>',
    );
  });
});
