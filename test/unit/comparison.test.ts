import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  differenceFingerprint,
  type ExpectedDifference,
  jscStderr,
  matchExpectedDifferences,
  unorderedResults,
  validateExpectedDifferences,
} from '../../scripts/comparison.ts';

const block = (lines: string[]): string =>
  `----- BEGIN MOON TEST RESULT -----\n${lines.join('\n')}\n----- END MOON TEST RESULT -----\n`;
const a = '{"type":"result","file":"signal_test.mbt","index":0,"message":""}';
const b = '{"type":"result","file":"signal_test.mbt","index":1,"message":""}';

describe('suite comparisons', () => {
  it('orders only upstream helper build summaries, retaining names and counts', () => {
    const artifact = (name: string) =>
      `Artifacts:\n  moonbitlang/async_test_programs/${name}  native  <root>/_build/test_programs/native/debug/build/moonbitlang/async_test_programs/${name}/${name}.exe\n`;
    const a = artifact('cat');
    const b = artifact('filter');
    expect(unorderedResults(a + b)).toBe(unorderedResults(b + a));
    expect(unorderedResults(a + a)).not.toBe(unorderedResults(a));
    expect(unorderedResults(a + b)).not.toBe(unorderedResults(a + artifact('sleep')));
    expect(unorderedResults('hello\nworld\n')).not.toBe(unorderedResults('world\nhello\n'));
  });

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

const result = (message: string, index = 0): string =>
  JSON.stringify({ type: 'result', file: 'socket_test.mbt', index, message });
const reference = result('');
const failure = result('OSError("Invalid argument")');
const entry = (divergence = 'D33'): ExpectedDifference => ({
  suite: 'async',
  invocation: 'moonbitlang/async/socket/socket.blackbox_test.wasm',
  divergence,
  tests: { 'socket_test.mbt': [0] },
  fingerprints: { wasm: differenceFingerprint(divergence, [[reference, failure]]) },
});

describe('expected suite differences', () => {
  it('matches exact test identities and messages, preserving raw unrelated output', () => {
    const expected = entry();
    const accepted = matchExpectedDifferences(
      block([reference]),
      block([failure]),
      [expected],
      'wasm',
    );
    expect(accepted.matched).toEqual([expected]);
    expect(accepted.stdout).toBe(block([reference]));
    const regression = matchExpectedDifferences(
      block([reference, result('', 1)]),
      `new output\n${block([failure, result('new failure', 1)])}`,
      [expected],
      'wasm',
    );
    expect(regression.matched).toEqual([expected]);
    expect(regression.stdout).toContain('new output');
    expect(regression.stdout).toContain('new failure');
  });
  it('does not accept changed, fixed, removed, duplicated, or unlisted test records', () => {
    for (const actual of [
      block([result('different error')]),
      block([reference]),
      '',
      block([failure, failure]),
      block([result('OSError("Invalid argument")', 1)]),
    ]) {
      const accepted = matchExpectedDifferences(block([reference]), actual, [entry()], 'wasm');
      expect(accepted.matched).toEqual([]);
      expect(accepted.stdout).toBe(actual);
    }
    expect(matchExpectedDifferences(block([reference]), block([failure]), [], 'wasm').stdout).toBe(
      block([failure]),
    );
  });
  it('requires every test in an entry to retain its expected difference', () => {
    const expected = {
      ...entry(),
      tests: { 'socket_test.mbt': [0, 1] },
      fingerprints: {
        wasm: differenceFingerprint('D33', [
          [reference, failure],
          [result('', 1), result('error', 1)],
        ]),
      },
    };
    expect(
      matchExpectedDifferences(
        block([reference, result('', 1)]),
        block([failure, result('', 1)]),
        [expected],
        'wasm',
      ).matched,
    ).toEqual([]);
  });
  it('pins D3 message text and frame count while tolerating unavailable frame labels', () => {
    const a = result('Error\n    at moonbit_fn'),
      b = result('Error\n    at unknown');
    const expected = {
      ...entry('D3'),
      fingerprints: { wasm: differenceFingerprint('D3', [[a, b]]) },
    };
    expect(matchExpectedDifferences(block([a]), block([b]), [expected], 'wasm').matched).toEqual([
      expected,
    ]);
    for (const changed of [
      'different Error\n    at unknown',
      'Error\n    at unknown\n    at unknown',
    ])
      expect(
        matchExpectedDifferences(block([a]), block([result(changed)]), [expected], 'wasm').matched,
      ).toEqual([]);
  });
  it('permits D34 port variation only when all occurrences retain the same port', () => {
    const a = result('127.0.0.1:1234 != 0.0.0.0:1234');
    const b = result('127.0.0.1:5678 != 0.0.0.0:5678');
    expect(differenceFingerprint('D34', [[reference, a]])).toBe(
      differenceFingerprint('D34', [[reference, b]]),
    );
    expect(differenceFingerprint('D34', [[reference, a]])).not.toBe(
      differenceFingerprint('D34', [[reference, result('127.0.0.1:5678 != 0.0.0.0:9999')]]),
    );
  });
  it('rejects undocumented IDs, overlapping tests, and arbitrary flaky exceptions', () => {
    const docs = '| D3 | stack |\n| D33 | TTL |\n| D39 | ctime |';
    expect(() => validateExpectedDifferences({ bun: [entry()] }, docs)).not.toThrow();
    expect(() => validateExpectedDifferences({ bun: [entry('D999')] }, docs)).toThrow(
      'Undocumented',
    );
    expect(() => validateExpectedDifferences({ bun: [entry(), entry()] }, docs)).toThrow(
      'Overlapping',
    );
    expect(() => validateExpectedDifferences({ bun: [{ ...entry(), flaky: true }] }, docs)).toThrow(
      'Only the D39',
    );
    const ctime: ExpectedDifference = {
      ...entry('D39'),
      invocation: 'moonbitlang/async/fs/fs.blackbox_test.wasm',
      tests: { 'timestamp_test.mbt': [0] },
      flaky: true,
    };
    expect(() => validateExpectedDifferences({ deno: [ctime] }, docs)).not.toThrow();
  });
});
