import { read, readSync, writeSync } from 'node:fs';
import type { StdioPort } from '../../ports/stdio.ts';

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function isAgain(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'EAGAIN';
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (e) {
      // A non-blocking stdio inherited from the parent; wait briefly and retry.
      if (!isAgain(e)) {
        throw e;
      }
      Atomics.wait(sleeper, 0, 0, 1);
    }
  }
}

/** Process stdio through raw fds; `process.stdout`/`process.stdin` are never touched. */
export function nodeStdio(): StdioPort {
  return {
    writeStdout: (bytes) => writeAll(1, bytes),
    writeStderr: (bytes) => writeAll(2, bytes),
    readStdin: (buffer) => {
      for (;;) {
        try {
          return readSync(0, buffer, 0, buffer.length, null);
        } catch (e) {
          if (isAgain(e)) {
            Atomics.wait(sleeper, 0, 0, 1);
            continue;
          }
          if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'EOF') {
            return 0;
          }
          throw e;
        }
      }
    },
    readStdinAsync: (buffer) =>
      new Promise((resolve, reject) => {
        read(0, buffer, 0, buffer.length, null, (e, n) => {
          if (e === null) {
            resolve(n);
          } else if (e.code === 'EOF') {
            resolve(0);
          } else {
            reject(e);
          }
        });
      }),
  };
}
