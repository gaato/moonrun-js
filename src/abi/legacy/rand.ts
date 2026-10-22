import { StdRng } from '../../domains/stdrng.ts';
import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';
import { rustPanic } from '../panic.ts';

export const rand: ImportFamily = (ctx) => ({
  // moonrun reads the seed as i32 and casts it to u64, so negative seeds sign-extend.
  stdrng_seed_from_u64: fn(['i32'], 'externref', (seed) => StdRng.seedFromU64(BigInt(seed))),
  stdrng_gen_range: fn(['externref', 'i32'], 'i32', (rng, ubound) => {
    if (!(rng instanceof StdRng)) {
      throw new TypeError('expected a StdRng');
    }
    if (ubound <= 0) {
      return rustPanic(ctx, RAND_EMPTY_RANGE_LOCATION, 'cannot sample empty range');
    }
    return rng.genRangeI32(0, ubound);
  }),
});

// moonrun 0.1.20261016 is built against rand 0.8.6 on GitHub's runners.
const RAND_EMPTY_RANGE_LOCATION =
  '/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/rand-0.8.6/src/rng.rs:134:9';
