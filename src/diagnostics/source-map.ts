// Port of crates/moonrun/src/source_map.rs (moon @ 748b63c).
// Kept free of `node:` imports: file access goes through `SourceMapIo`.

const SOURCE_MAPPING_URL = 'sourceMappingURL';
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface Mapping {
  address: number;
  source: number;
  line: number;
}

/** The source file and one-based line associated with a Wasm byte offset. */
export interface SourcePosition {
  file: string;
  line: number;
}

export interface SourceMapIo {
  /** Returns undefined when the file cannot be read as UTF-8 text. */
  readText(path: string): string | undefined;
  /** Like `path.resolve(dir, rel)`: an absolute `rel` is returned unchanged. */
  resolve(dir: string, rel: string): string;
  dirname(path: string): string;
}

/** A parsed moon_wat2wasm address-oriented source map. */
export class SourceMap {
  readonly #sources: readonly string[];
  readonly #mappings: readonly Mapping[];

  constructor(sources: readonly string[], mappings: readonly Mapping[]) {
    this.#sources = sources;
    this.#mappings = mappings;
  }

  /** Finds the last mapping at or before `offset`. */
  position(offset: number): SourcePosition | undefined {
    const index = partitionPoint(this.#mappings, (m) => m.address <= offset) - 1;
    const mapping = this.#mappings[index];
    if (mapping === undefined) return undefined;
    const file = this.#sources[mapping.source];
    if (file === undefined) return undefined;
    return { file, line: mapping.line + 1 };
  }
}

/** Same probing order as Rust's `slice::partition_point`. */
function partitionPoint<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let size = items.length;
  if (size === 0) return 0;
  let base = 0;
  while (size > 1) {
    const half = Math.floor(size / 2);
    const mid = base + half;
    const item = items[mid];
    if (item !== undefined && predicate(item)) base = mid;
    size -= half;
  }
  const first = items[base];
  return base + (first !== undefined && predicate(first) ? 1 : 0);
}

export function parseSourceMap(json: string): SourceMap | undefined {
  const raw = parseRawSourceMap(json);
  if (raw === undefined) return undefined;
  const mappings = decodeMappings(raw.mappings);
  if (mappings === undefined) return undefined;
  return new SourceMap(raw.sources, mappings);
}

/** Accepts what serde derives for `{ sources: Vec<String>, mappings: String }`. */
function parseRawSourceMap(json: string): { sources: string[]; mappings: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  // serde also accepts a struct encoded as a two-element array.
  const [sources, mappings] = Array.isArray(value)
    ? value.length === 2
      ? value
      : []
    : isRecord(value)
      ? [value['sources'], value['mappings']]
      : [];
  if (typeof mappings !== 'string' || !Array.isArray(sources)) return undefined;
  if (!sources.every((s): s is string => typeof s === 'string')) return undefined;
  return { sources, mappings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// VLQ values are i64 in Rust; BigInt keeps overflow behavior identical.
function decodeMappings(value: string): Mapping[] | undefined {
  const mappings: Mapping[] = [];
  let source = 0n;
  let originalLine = 0n;

  const lines = value.split(';');
  for (const [generatedLine, line] of lines.entries()) {
    let generatedColumn = 0n;
    for (const segment of line.split(',')) {
      if (segment === '') continue;
      const values = decodeVlqSegment(segment);
      const first = values?.[0];
      if (values === undefined || first === undefined) return undefined;
      const column = checkedAdd(generatedColumn, first);
      if (column === undefined) return undefined;
      generatedColumn = column;

      const [, sourceDelta, lineDelta] = values;
      if (values.length >= 4 && sourceDelta !== undefined && lineDelta !== undefined) {
        const nextSource = checkedAdd(source, sourceDelta);
        if (nextSource === undefined) return undefined;
        source = nextSource;
        const nextLine = checkedAdd(originalLine, lineDelta);
        if (nextLine === undefined) return undefined;
        originalLine = nextLine;
        if (generatedLine === 0) {
          if (generatedColumn < 0n || source < 0n || originalLine < 0n) return undefined;
          mappings.push({
            address: Number(generatedColumn),
            source: Number(source),
            line: Number(originalLine),
          });
        }
      }
    }
  }
  return mappings;
}

function checkedAdd(a: bigint, b: bigint): bigint | undefined {
  const sum = a + b;
  return sum === BigInt.asIntN(64, sum) ? sum : undefined;
}

function base64Digit(ch: number): number | undefined {
  if (ch >= 0x41 && ch <= 0x5a) return ch - 0x41;
  if (ch >= 0x61 && ch <= 0x7a) return ch - 0x61 + 26;
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30 + 52;
  if (ch === 0x2b) return 62;
  if (ch === 0x2f) return 63;
  return undefined;
}

function decodeVlqSegment(segment: string): bigint[] | undefined {
  // The Rust code walks UTF-8 bytes; any non-ASCII char is invalid either way.
  const bytes = new TextEncoder().encode(segment);
  const values: bigint[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const ch = bytes[pos];
      pos += 1;
      if (ch === undefined) return undefined;
      const digit = base64Digit(ch);
      if (digit === undefined) return undefined;
      if (shift >= 64n) return undefined; // checked_shl
      value = BigInt.asIntN(64, value | (BigInt(digit & 31) << shift));
      if ((digit & 32) === 0) break;
      shift += 5n;
    }
    const negative = (value & 1n) !== 0n;
    value >>= 1n;
    values.push(negative ? BigInt.asIntN(64, -value) : value);
  }
  return values;
}

/**
 * Loads the source map associated with these Wasm bytes, if it is locally
 * available. Source maps are optional diagnostics, so malformed metadata and
 * I/O errors deliberately degrade to an absent map.
 */
export function loadSourceMap(
  wasmPath: string,
  wasmBytes: Uint8Array,
  io: SourceMapIo,
): SourceMap | undefined {
  const url = sourceMappingUrl(wasmBytes);
  const usable =
    url !== undefined &&
    url !== '' &&
    !url.startsWith('data:') &&
    !url.startsWith('http://') &&
    !url.startsWith('https://');
  const mapPath = usable ? io.resolve(io.dirname(wasmPath), url) : `${wasmPath}.map`;
  const text = io.readText(mapPath);
  return text === undefined ? undefined : parseSourceMap(text);
}

/** Finds the `sourceMappingURL` custom section; any malformed section ends the search. */
export function sourceMappingUrl(wasm: Uint8Array): string | undefined {
  if (wasm.length < WASM_HEADER.length || !WASM_HEADER.every((b, i) => wasm[i] === b))
    return undefined;

  let sectionStart = WASM_HEADER.length;
  while (sectionStart < wasm.length) {
    const sectionId = wasm[sectionStart];
    const len = readU32Leb(wasm, sectionStart + 1);
    if (len === undefined) return undefined;
    const [sectionLen, payloadStart] = len;
    const payloadEnd = payloadStart + sectionLen;
    if (payloadEnd > wasm.length) return undefined;
    const payload = wasm.subarray(payloadStart, payloadEnd);

    if (sectionId === 0) {
      const nameLen = readU32Leb(payload, 0);
      if (nameLen === undefined) return undefined;
      const nameEnd = nameLen[1] + nameLen[0];
      if (nameEnd > payload.length) return undefined;
      if (isSourceMappingName(payload.subarray(nameLen[1], nameEnd))) {
        const urlLen = readU32Leb(payload, nameEnd);
        if (urlLen === undefined) return undefined;
        const urlEnd = urlLen[1] + urlLen[0];
        if (urlEnd > payload.length) return undefined;
        try {
          return utf8.decode(payload.subarray(urlLen[1], urlEnd));
        } catch {
          return undefined;
        }
      }
    }

    sectionStart = payloadEnd;
  }
  return undefined;
}

function isSourceMappingName(name: Uint8Array): boolean {
  return (
    name.length === SOURCE_MAPPING_URL.length &&
    name.every((b, i) => b === SOURCE_MAPPING_URL.charCodeAt(i))
  );
}

/** Reads a u32 LEB128 of at most 5 bytes; returns [value, endIndex]. */
function readU32Leb(
  bytes: Uint8Array,
  start: number,
): readonly [value: number, end: number] | undefined {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = bytes[start + index];
    if (byte === undefined) return undefined;
    if (index === 4 && (byte & 0xf0) !== 0) return undefined;
    value += (byte & 0x7f) * 2 ** (index * 7);
    if ((byte & 0x80) === 0) return [value, start + index + 1];
  }
  return undefined;
}
