export interface RandomPort {
  /** Fills `buffer` with cryptographically secure bytes. */
  fill(buffer: Uint8Array): void;
}
