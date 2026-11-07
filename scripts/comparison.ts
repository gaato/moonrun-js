import { createHash } from 'node:crypto';

/** D12: sort result records inside each protocol block as well as the blocks. */
export function unorderedResults(stdout: string): string {
  // Concurrent upstream helper builds print these complete summaries in
  // completion order. Preserve their exact paths and multiplicity, like results.
  // They share the runner's stdout, so one can also land between a protocol
  // block's lines; take them out before the blocks are parsed.
  const artifacts: string[] = [];
  let rest = stdout.replace(
    /^Artifacts:\n {2}moonbitlang\/async_test_programs\/[^\s]+ {2}native {2}<root>\/_build\/test_programs\/native\/debug\/build\/moonbitlang\/async_test_programs\/[^\n]+\n/gm,
    (block) => {
      artifacts.push(block);
      return '';
    },
  );
  const records: string[] = [];
  rest = rest.replace(
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
  return `${rest}\0${records.sort().join('\n')}\0${artifacts.sort().join('')}`;
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
  /**
   * Per target, the exact stderr lines (each ending in `\n`, paths under the project
   * shown as `<root>`) that this divergence makes its aborted helpers write. The
   * reference stderr must be empty and the actual one made only of these lines,
   * possibly split into pieces by the other helpers' writes (`stderrOfVocabulary`).
   * Only D16 may declare them: its failed lock tests abort their native helpers,
   * which report on the inherited stderr.
   */
  readonly stderrVocabulary?: Readonly<Record<string, readonly string[]>>;
  readonly flaky?: boolean;
}
export type ExpectedDifferences = Readonly<Record<string, readonly ExpectedDifference[]>>;

function testKeys(entry: ExpectedDifference): string[] {
  return Object.entries(entry.tests)
    .flatMap(([file, indices]) => indices.map((index) => JSON.stringify([file, index])))
    .sort();
}

/**
 * D39: Deno's ctime has whole seconds, so these comparisons depend on where the run
 * falls within a second. One entry each: they fail independently of each other.
 */
const D39_FLAKY_TESTS = ['{"timestamp_test.mbt":[0]}', '{"timestamp_test.mbt":[2]}'];
/** Where those tests run: moonbitlang/async's fs package, and its copy in core/async. */
const D39_FLAKY_INVOCATIONS = [
  JSON.stringify(['async', 'moonbitlang/async/fs/fs.blackbox_test.wasm']),
  JSON.stringify(['core', 'async/fs/fs.blackbox_test.wasm']),
];

/** A field this checker does not know, such as a renamed one, would otherwise be ignored. */
const ENTRY_FIELDS = [
  'suite',
  'invocation',
  'divergence',
  'tests',
  'fingerprints',
  'stderrVocabulary',
  'flaky',
];

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
      const unknown = Object.keys(entry).filter((key) => !ENTRY_FIELDS.includes(key));
      if (unknown.length > 0) throw new Error(`Unknown expected-difference field: ${unknown[0]}`);
      if (!entry.invocation.endsWith('.wasm') || !['core', 'async'].includes(entry.suite))
        throw new Error('Expected difference needs a suite and wasm invocation');
      if (
        entry.flaky !== undefined &&
        (entry.flaky !== true ||
          runtime !== 'deno' ||
          entry.divergence !== 'D39' ||
          !D39_FLAKY_INVOCATIONS.includes(JSON.stringify([entry.suite, entry.invocation])) ||
          !D39_FLAKY_TESTS.includes(JSON.stringify(entry.tests)))
      )
        throw new Error('Only the D39 ctime tests may be flaky');
      if (entry.stderrVocabulary !== undefined) {
        if (entry.divergence !== 'D16') {
          throw new Error('Only D16 may record a stderr difference');
        }
        for (const [target, lines] of Object.entries(entry.stderrVocabulary)) {
          if (
            entry.fingerprints[target] === undefined ||
            lines.length === 0 ||
            new Set(lines).size !== lines.length ||
            lines.some((line) => !line.endsWith('\n') || line.indexOf('\n') !== line.length - 1)
          ) {
            throw new Error('Invalid stderr vocabulary');
          }
        }
      }
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

/** At most this many lines may be open (started, not finished) at once: one per helper. */
const MAX_OPEN_LINES = 32;
/** Search steps after which a stderr is rejected rather than decided. */
const MAX_STDERR_STEPS = 200_000;

/**
 * Whether `stderr` consists only of lines of `vocabulary`, where concurrent writers may
 * split a line into pieces around other writers' output (D16).
 *
 * D16's failed lock tests abort several native helpers at once. How many helpers, which
 * stack each reports, and how their writes interleave on the shared stderr vary per run,
 * even within a line, so the stderr cannot be recorded exactly. Instead, `stderr` is
 * read left to right as pieces: each piece either starts a line of `vocabulary` or
 * continues a line that an earlier piece started and that is still open, and the
 * pieces of one line, in order, must spell exactly one vocabulary line. At the end no
 * line may be open. `root` replaces `<root>` in both texts first: a helper's write can
 * split the project path, which `<root>` normalization then misses.
 */
export function stderrOfVocabulary(
  stderr: string,
  vocabulary: readonly string[],
  root: string,
): boolean {
  const text = stderr.replaceAll('<root>', root);
  const lines = [...new Set(vocabulary.map((line) => line.replaceAll('<root>', root)))];
  if (text === '' || !text.endsWith('\n') || lines.length === 0) return false;
  /** The longest piece at `pos` that extends the open `prefix` to a prefix of some line. */
  const longest = (prefix: string, pos: number): number => {
    let best = 0;
    for (const line of lines) {
      if (!line.startsWith(prefix)) continue;
      let k = 0;
      while (prefix.length + k < line.length && text[pos + k] === line[prefix.length + k]) k++;
      best = Math.max(best, k);
    }
    return best;
  };
  const isLine = new Set(lines);
  const failed = new Set<string>();
  let steps = 0;
  const search = (pos: number, open: readonly string[]): boolean => {
    if (pos === text.length) return open.length === 0;
    if (++steps > MAX_STDERR_STEPS) return false;
    const key = `${pos}\0${open.join('\0')}`;
    if (failed.has(key)) return false;
    // Continue an open line (each distinct one once), or start a new one.
    const candidates: Array<{ prefix: string; index: number }> = [
      ...[...new Set(open)].map((prefix) => ({ prefix, index: open.indexOf(prefix) })),
      ...(open.length < MAX_OPEN_LINES ? [{ prefix: '', index: -1 }] : []),
    ];
    const tries = candidates
      .map((c) => ({ ...c, max: longest(c.prefix, pos) }))
      .filter((c) => c.max > 0)
      .sort((a, b) => b.max - a.max);
    for (const { prefix, index, max } of tries) {
      for (let k = max; k >= 1; k--) {
        const grown = prefix + text.slice(pos, pos + k);
        const rest = index < 0 ? [...open] : open.filter((_, i) => i !== index);
        const next = isLine.has(grown) ? rest : [...rest, grown].sort();
        if (search(pos + k, next)) return true;
        if (steps > MAX_STDERR_STEPS) return false;
      }
    }
    failed.add(key);
    return false;
  };
  return search(0, []);
}

export function matchExpectedDifferences(
  reference: string,
  actual: string,
  entries: readonly ExpectedDifference[],
  target: string,
  stderr?: { readonly reference: string; readonly actual: string; readonly root: string },
): { stdout: string; matched: ExpectedDifference[]; stderrMatched: boolean } {
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
    // An entry that declares its stderr matches only together with such a stderr.
    const vocabulary = entry.stderrVocabulary?.[target];
    if (
      vocabulary !== undefined &&
      (stderr === undefined ||
        stderr.reference !== '' ||
        !stderrOfVocabulary(stderr.actual, vocabulary, stderr.root))
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
  const stderrMatched = matched.some((entry) => entry.stderrVocabulary?.[target] !== undefined);
  return { stdout, matched, stderrMatched };
}
