import type { StdioPort } from '../ports/stdio.ts';

const encoder = new TextEncoder();
const NEWLINE = 0x0a;
const MAX_BUFFERED = 8192;

/**
 * Guest-facing standard streams. Stdout behaves like Rust's line-buffered
 * `std::io::stdout()` used by moonrun; stderr is unbuffered.
 */
export class Stdio {
  readonly #port: StdioPort;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;

  constructor(port: StdioPort) {
    this.#port = port;
  }

  writeStdout(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    this.#pending.push(bytes.slice());
    this.#pendingBytes += bytes.length;
    if (bytes.includes(NEWLINE) || this.#pendingBytes >= MAX_BUFFERED) {
      this.#flushThroughLastNewline(this.#pendingBytes >= MAX_BUFFERED);
    }
  }

  writeStdoutText(text: string): void {
    this.writeStdout(encoder.encode(text));
  }

  writeStderr(bytes: Uint8Array): void {
    if (bytes.length > 0) {
      this.#port.writeStderr(bytes);
    }
  }

  writeStderrText(text: string): void {
    this.writeStderr(encoder.encode(text));
  }

  flushStdout(): void {
    this.#flushThroughLastNewline(true);
  }

  readStdin(buffer: Uint8Array): number {
    return this.#port.readStdin(buffer);
  }

  #flushThroughLastNewline(all: boolean): void {
    if (this.#pendingBytes === 0) {
      return;
    }
    const joined = new Uint8Array(this.#pendingBytes);
    let offset = 0;
    for (const chunk of this.#pending) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    const cut = all ? joined.length : joined.lastIndexOf(NEWLINE) + 1;
    this.#port.writeStdout(joined.subarray(0, cut));
    const rest = joined.slice(cut);
    this.#pending = rest.length > 0 ? [rest] : [];
    this.#pendingBytes = rest.length;
  }
}

/**
 * Stateful UTF-16 code-unit writer behind `spectest.print_char`
 * (moonrun `Utf16Writer`). A dangling high surrogate survives an intervening
 * non-surrogate character; a second high surrogate prints U+FFFD.
 */
export class Utf16Writer {
  #danglingHigh: number | undefined;

  /** Returns false for a value that is not a Unicode scalar (moonrun fails the write). */
  write(stdio: Stdio, value: number): boolean {
    if (value >= 0xd800 && value <= 0xdbff) {
      const previous = this.#danglingHigh;
      this.#danglingHigh = value - 0xd800;
      if (previous !== undefined) {
        stdio.writeStdoutText('\u{fffd}');
      }
      return true;
    }
    let scalar = value;
    if (value >= 0xdc00 && value <= 0xdfff) {
      const high = this.#danglingHigh;
      this.#danglingHigh = undefined;
      scalar = high === undefined ? 0xfffd : 0x10000 + (high << 10) + (value - 0xdc00);
    }
    if (scalar < 0 || scalar > 0x10ffff) {
      return false;
    }
    stdio.writeStdoutText(String.fromCodePoint(scalar));
    return true;
  }
}
