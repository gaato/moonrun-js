/** Raw access to the process standard streams. Writes are synchronous and complete. */
export interface StdioPort {
  writeStdout(bytes: Uint8Array): void;
  writeStderr(bytes: Uint8Array): void;
  /** Reads into `buffer`; returns the byte count, 0 at end of input. */
  readStdin(buffer: Uint8Array): number;
  /**
   * One `read(2)` of stdin off the JavaScript thread (the host's I/O pool); resolves to the
   * byte count, 0 at end of input, and rejects with the error (`code`, e.g. `EAGAIN` for a
   * nonblocking stdin without data). It cannot be interrupted once started.
   */
  readStdinAsync(buffer: Uint8Array): Promise<number>;
}
