/** Raw access to the process standard streams. Writes are synchronous and complete. */
export interface StdioPort {
  writeStdout(bytes: Uint8Array): void;
  writeStderr(bytes: Uint8Array): void;
  /** Reads into `buffer`; returns the byte count, 0 at end of input. */
  readStdin(buffer: Uint8Array): number;
}
