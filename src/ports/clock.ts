export interface ClockPort {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Monotonic nanoseconds from an arbitrary origin. */
  monotonicNs(): bigint;
}
