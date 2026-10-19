import type { ImportFamily } from '../context.ts';
import { fn } from '../define.ts';

/** Opaque handle returned by `instant_now`. */
interface Instant {
  readonly startNs: bigint;
}

function isInstant(v: unknown): v is Instant {
  return typeof v === 'object' && v !== null && 'startNs' in v && typeof v.startNs === 'bigint';
}

export const time: ImportFamily = (ctx) => ({
  // moonrun returns `[millis]` and relies on V8's ToBigInt; returning the BigInt is equivalent.
  now: fn([], 'i64', () => BigInt(Math.trunc(ctx.host.clock.nowMs()))),
  instant_now: fn([], 'externref', (): Instant => ({ startNs: ctx.host.clock.monotonicNs() })),
  instant_elapsed_as_secs_f64: fn(['externref'], 'f64', (instant) => {
    if (!isInstant(instant)) {
      throw new TypeError('expected an Instant');
    }
    return Number(ctx.host.clock.monotonicNs() - instant.startNs) / 1e9;
  }),
});
