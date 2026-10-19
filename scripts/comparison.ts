import { createHash } from 'node:crypto';

/** D12: sort result records inside each protocol block as well as the blocks. */
export function unorderedResults(stdout: string): string {
  const records: string[] = [];
  const rest = stdout.replace(
    /----- BEGIN MOON TEST RESULT -----\n([\s\S]*?)\n----- END MOON TEST RESULT -----\n/g,
    (block, body: string) => {
      const lines = body.split('\n');
      // Sort only protocol JSON records. Preserve malformed or arbitrary output.
      if (
        !lines.every((line) => {
          try {
            const value: unknown = JSON.parse(line);
            return (
              typeof value === 'object' &&
              value !== null &&
              'type' in value &&
              (value.type === 'result' || value.type === 'start')
            );
          } catch {
            return false;
          }
        })
      )
        return block;
      records.push(...lines);
      return '';
    },
  );
  return `${rest}\0${records.sort().join('\n')}`;
}

/** D3: unavailable JSC frame names/locations; applies to stderr only. */
export function jscStderr(stderr: string): string {
  return stderr
    .replace(/^( {4,})at [^\n]+$/gm, '$1at <D3>')
    .replace(
      /(Uncaught CompileError: )WebAssembly\.Module\(\): expected magic word [^\n]+ @\+0/g,
      '$1invalid wasm magic',
    )
    .replace(
      /(Uncaught CompileError: )WebAssembly\.Module doesn't parse at byte 0: module doesn't start with '\\0asm'(?: \(evaluating '[^\n]*'\))?/g,
      '$1invalid wasm magic',
    )
    .replace(
      /LinkError: WebAssembly\.Instance\(\): Import #\d+ "([^"]+)" "([^"]+)": function import requires a callable/g,
      'LinkError: callable import $1:$2 required',
    )
    .replace(
      /LinkError: import function ([^\s]+) must be callable(?: \(evaluating '[^\n]*'\))?/g,
      'LinkError: callable import $1 required',
    );
}

export interface ExpectedDifference {
  readonly suite: string;
  /** Artifact path relative to <build>/<target>/debug/test/. */
  readonly invocation: string;
  readonly divergence: string;
  readonly tests: Readonly<Record<string, readonly number[]>>;
  /** Fingerprint per target; absent targets are outside this entry's scope. */
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly flaky?: boolean;
}
export type ExpectedDifferences = Readonly<Record<string, readonly ExpectedDifference[]>>;

function testKeys(entry: ExpectedDifference): string[] {
  return Object.entries(entry.tests)
    .flatMap(([file, indices]) => indices.map((index) => JSON.stringify([file, index])))
    .sort();
}

export function validateExpectedDifferences(
  list: ExpectedDifferences,
  documentation: string,
): void {
  const ids = new Set([...documentation.matchAll(/^\| (D\d+) \|/gm)].map((match) => match[1]));
  const seen = new Set<string>();
  for (const [runtime, entries] of Object.entries(list)) {
    if (!['node', 'deno', 'bun'].includes(runtime)) throw new Error(`Unknown runtime: ${runtime}`);
    for (const entry of entries) {
      if (!ids.has(entry.divergence))
        throw new Error(`Undocumented divergence: ${entry.divergence}`);
      if (!entry.invocation.endsWith('.wasm') || !['core', 'async'].includes(entry.suite))
        throw new Error('Expected difference needs a suite and wasm invocation');
      if (
        entry.flaky !== undefined &&
        (entry.flaky !== true ||
          runtime !== 'deno' ||
          entry.divergence !== 'D39' ||
          entry.suite !== 'async' ||
          entry.invocation !== 'moonbitlang/async/fs/fs.blackbox_test.wasm' ||
          JSON.stringify(entry.tests) !== '{"timestamp_test.mbt":[0]}')
      )
        throw new Error('Only the D39 ctime test may be flaky');
      const keys = testKeys(entry);
      if (keys.length === 0 || Object.keys(entry.fingerprints).length === 0)
        throw new Error('Expected difference needs tests and target fingerprints');
      for (const indices of Object.values(entry.tests))
        if (indices.some((index) => !Number.isSafeInteger(index) || index < 0))
          throw new Error('Invalid expected test index');
      for (const [target, fingerprint] of Object.entries(entry.fingerprints)) {
        if (!['wasm', 'wasm-gc'].includes(target) || !/^[a-f0-9]{64}$/.test(fingerprint))
          throw new Error('Invalid target fingerprint');
        for (const key of keys) {
          const identity = JSON.stringify([runtime, entry.suite, target, entry.invocation, key]);
          if (seen.has(identity)) throw new Error(`Overlapping expected difference: ${identity}`);
          seen.add(identity);
        }
      }
    }
  }
}

const resultBlocks =
  /----- BEGIN MOON TEST RESULT -----\n([\s\S]*?)\n----- END MOON TEST RESULT -----\n/g;

/** Only unambiguous, canonical result records inside the protocol can be expected. */
export function resultRecords(stdout: string): Map<string, string> {
  const records = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const block of stdout.matchAll(resultBlocks)) {
    for (const line of (block[1] ?? '').split('\n')) {
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value !== 'object' ||
          value === null ||
          !('type' in value) ||
          value.type !== 'result' ||
          !('file' in value) ||
          typeof value.file !== 'string' ||
          !('index' in value) ||
          typeof value.index !== 'number' ||
          !('message' in value) ||
          typeof value.message !== 'string' ||
          JSON.stringify(value) !== line
        )
          continue;
        const key = JSON.stringify([value.file, value.index]);
        if (records.has(key)) duplicates.add(key);
        records.set(key, line);
      } catch {
        /* Arbitrary output remains subject to the ordinary comparison. */
      }
    }
  }
  for (const key of duplicates) records.delete(key);
  return records;
}

/** D3 drops unavailable frame labels, retaining count/text. D34's one shared port varies per run. */
export function differenceFingerprint(
  divergence: string,
  pairs: readonly (readonly [string, string])[],
): string {
  const canonical = (line: string): unknown => {
    const value = JSON.parse(line) as { message: string };
    if (divergence === 'D3') value.message = jscStderr(value.message);
    if (divergence === 'D34') {
      const ports = [...value.message.matchAll(/(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/g)];
      // A changed port relationship is a regression, not run-to-run variability.
      if (ports.length > 0 && new Set(ports.map((match) => match[1])).size === 1)
        value.message = value.message.replace(/((?:127\.0\.0\.1|0\.0\.0\.0):)\d+/g, '$1<port>');
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(pairs.map((pair) => pair.map(canonical))))
    .digest('hex');
}

export function matchExpectedDifferences(
  reference: string,
  actual: string,
  entries: readonly ExpectedDifference[],
  target: string,
): { stdout: string; matched: ExpectedDifference[] } {
  const ref = resultRecords(reference),
    js = resultRecords(actual);
  const replacements = new Map<string, string>();
  const matched: ExpectedDifference[] = [];
  for (const entry of entries) {
    const pairs: [string, string][] = [];
    for (const key of testKeys(entry)) {
      const a = ref.get(key),
        b = js.get(key);
      if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b]);
    }
    if (
      pairs.length !== testKeys(entry).length ||
      differenceFingerprint(entry.divergence, pairs) !== entry.fingerprints[target]
    )
      continue;
    matched.push(entry);
    for (const [a, b] of pairs) replacements.set(b, a);
  }
  // Replace only matched protocol records. All other output and fields still compare normally.
  const stdout = actual.replace(resultBlocks, (block, body: string) =>
    block.replace(body, () =>
      body
        .split('\n')
        .map((line) => replacements.get(line) ?? line)
        .join('\n'),
    ),
  );
  return { stdout, matched };
}
