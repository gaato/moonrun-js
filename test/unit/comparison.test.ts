import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { jscStderr, unorderedResults } from '../../scripts/comparison.ts';

const block = (lines: string[]): string =>
  `----- BEGIN MOON TEST RESULT -----\n${lines.join('\n')}\n----- END MOON TEST RESULT -----\n`;
const a = '{"type":"result","file":"signal_test.mbt","index":0,"message":""}';
const b = '{"type":"result","file":"signal_test.mbt","index":1,"message":""}';

describe('suite comparisons', () => {
  it('sorts records within protocol blocks, preserving multiplicity and other output', () => {
    expect(unorderedResults(block([a, b]))).toBe(unorderedResults(block([b, a])));
    expect(unorderedResults(block([a]) + block([b]))).toBe(unorderedResults(block([b, a])));
    expect(unorderedResults(block([a, a, b]))).not.toBe(unorderedResults(block([a, b])));
    expect(unorderedResults(`hello\n${block([a, b])}`)).not.toBe(
      unorderedResults(`different\n${block([b, a])}`),
    );
    expect(unorderedResults(block([a, b.replace('"message":""', '"message":"failed"')]))).not.toBe(
      unorderedResults(block([a, b])),
    );
    expect(unorderedResults(block(['arbitrary text']))).toContain('arbitrary text');
  });
  it('normalizes unavailable JSC frame information, preserving errors and frame count', () => {
    expect(jscStderr('Error: Fault\n    at __moonbit_main')).toBe(
      jscStderr('Error: Fault\n    at unknown'),
    );
    expect(jscStderr('Error: other\n    at unknown')).not.toBe(
      jscStderr('Error: Fault\n    at unknown'),
    );
    expect(jscStderr('Error\n    at f\n    at g')).not.toBe(jscStderr('Error\n    at unknown'));
  });
  it('the nested moon relay preserves its complete stdout, stderr, and failure status', () => {
    const result = spawnSync(
      'node',
      [
        'scripts/record-shim.ts',
        '--nested-moon',
        process.execPath,
        '-e',
        'process.stdout.write("out");process.stderr.write("Warning");process.stderr.write(": detail\\n");process.exitCode=7',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('Warning: detail\n');
  });
});
