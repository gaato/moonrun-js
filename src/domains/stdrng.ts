import { chacha12 } from '@noble/ciphers/chacha.js';

const M64 = (1n << 64n) - 1n;
const PCG_MUL = 6364136223846793005n;
const PCG_INC = 11634580027462260723n;
const WORDS = 64;
const NONCE = new Uint8Array(12);
const ZEROS = new Uint8Array(WORDS * 4);

/**
 * Bit-exact rand 0.8.5–0.8.6 `StdRng` (rand_chacha 0.3.1 `ChaCha12Rng`), the generator behind
 * `__moonbit_rand_unstable`. rand_chacha's djb layout (64-bit counter, stream 0) equals
 * IETF ChaCha with an all-zero nonce while the block counter stays below 2^32.
 */
export class StdRng {
  readonly #key: Uint8Array;
  readonly #buffer = new Uint32Array(WORDS);
  #index = WORDS;
  #block = 0;

  private constructor(key: Uint8Array) {
    this.#key = key;
  }

  /** rand_core 0.6.4 `seed_from_u64`: PCG32 output fills the 32-byte key. */
  static seedFromU64(seed: bigint): StdRng {
    let state = BigInt.asUintN(64, seed);
    const key = new Uint8Array(32);
    const view = new DataView(key.buffer);
    for (let i = 0; i < 8; i++) {
      state = (state * PCG_MUL + PCG_INC) & M64;
      const xorshifted = Number((((state >> 18n) ^ state) >> 27n) & 0xffffffffn);
      const rot = Number(state >> 59n);
      view.setUint32(i * 4, ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0, true);
    }
    return new StdRng(key);
  }

  nextU32(): number {
    if (this.#index >= WORDS) {
      const out = chacha12(this.#key, NONCE, ZEROS, undefined, this.#block);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      for (let i = 0; i < WORDS; i++) {
        this.#buffer[i] = view.getUint32(i * 4, true);
      }
      this.#block += 4;
      this.#index = 0;
    }
    return this.#buffer[this.#index++] ?? 0;
  }

  /** rand 0.8.5 `gen_range(low..high)` for i32 (`UniformInt::sample_single_inclusive`). Requires low < high. */
  genRangeI32(low: number, high: number): number {
    const range = ((high - 1 - low + 1) | 0) >>> 0;
    if (range === 0) {
      return this.nextU32() | 0;
    }
    // The conservative zone `(range << range.leading_zeros()).wrapping_sub(1)`.
    const zone = ((range << Math.clz32(range)) - 1) >>> 0;
    for (;;) {
      const product = BigInt(this.nextU32()) * BigInt(range);
      if (Number(product & 0xffffffffn) <= zone) {
        return (low + Number(product >> 32n)) | 0;
      }
    }
  }
}
