// The C ABI shared by the wasm components built from moonrun's Rust source (crates/,
// docs/reuse.md) and the TLS engine: inputs are copied into the component's memory
// through `<prefix>_alloc`, freed with `<prefix>_free`, and a variable-size result is read
// through `<prefix>_result_ptr` / `<prefix>_result_len`. Views of the component memory are
// recreated after every call because the component may grow its memory.

/** `usize::MAX` on wasm32: an absent optional input. */
export const ABSENT = -1;

type Fn = (...args: number[]) => number;

export interface AbiExports {
  readonly memory: WebAssembly.Memory;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One input buffer: bytes, a string (UTF-8), or `undefined` (passed as `0, ABSENT`). */
export type Input = Uint8Array | string | undefined;

export class ComponentAbi {
  readonly exports: WebAssembly.Exports;
  readonly #memory: WebAssembly.Memory;
  readonly #alloc: Fn;
  readonly #free: Fn;
  readonly #resultPtr: Fn;
  readonly #resultLen: Fn;

  constructor(instance: WebAssembly.Instance, prefix: string) {
    this.exports = instance.exports;
    const memory = instance.exports['memory'];
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new TypeError(`${prefix}: the component exports no memory`);
    }
    this.#memory = memory;
    this.#alloc = this.fn(`${prefix}_alloc`);
    this.#free = this.fn(`${prefix}_free`);
    this.#resultPtr = this.fn(`${prefix}_result_ptr`);
    this.#resultLen = this.fn(`${prefix}_result_len`);
  }

  /** An exported function; a missing one is a build mismatch, so it throws. */
  fn(name: string): Fn {
    const f = this.exports[name];
    if (typeof f !== 'function') {
      throw new TypeError(`component export \`${name}\` is missing`);
    }
    return f as Fn;
  }

  /**
   * Calls `name`: numbers are passed as they are, each buffer input as `(ptr, len)`
   * (copied in before the call and freed after it), `undefined` as `(0, ABSENT)`.
   */
  call(name: string, ...args: ReadonlyArray<number | Input>): number {
    const buffers: Array<[number, number]> = [];
    const raw: number[] = [];
    try {
      for (const arg of args) {
        if (typeof arg === 'number') {
          raw.push(arg);
          continue;
        }
        if (arg === undefined) {
          raw.push(0, ABSENT);
          continue;
        }
        const bytes = typeof arg === 'string' ? encoder.encode(arg) : arg;
        const len = bytes.length;
        if (len === 0) {
          raw.push(0, 0);
          continue;
        }
        const ptr = this.#alloc(len);
        buffers.push([ptr, len]);
        new Uint8Array(this.#memory.buffer, ptr, len).set(bytes);
        raw.push(ptr, len);
      }
      return this.fn(name)(...raw);
    } finally {
      for (const [ptr, len] of buffers) {
        this.#free(ptr, len);
      }
    }
  }

  /** A copy of the current result buffer. */
  result(): Uint8Array {
    const ptr = this.#resultPtr();
    const len = this.#resultLen();
    return new Uint8Array(this.#memory.buffer, ptr, len).slice();
  }

  resultText(): string {
    return decoder.decode(this.result());
  }

  /** The result split at NUL terminators. */
  resultList(): Uint8Array[] {
    const bytes = this.result();
    const out: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        out.push(bytes.subarray(start, i));
        start = i + 1;
      }
    }
    return out;
  }
}

export function utf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Bytes for a string, NUL-terminating each of `items`. */
export function nulList(items: readonly (string | Uint8Array)[]): Uint8Array {
  const parts = items.map((i) => (typeof i === 'string' ? encoder.encode(i) : i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + 1;
  }
  return out;
}
