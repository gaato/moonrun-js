import { describe, expect, it } from 'vitest';
import { BrowserStdin } from '../../src/hosts/browser/streams.ts';

describe('browser streaming stdin', () => {
  it('waits asynchronously, preserves chunks and reaches EOF only after end', async () => {
    const stdin = new BrowserStdin();
    const buffer = new Uint8Array(4);
    let settled = false;
    const reading = stdin.readAsync(buffer).then((n) => {
      settled = true;
      return n;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await stdin.write(new Uint8Array([1, 2]));
    expect(await reading).toBe(2);
    expect(buffer.slice(0, 2)).toEqual(new Uint8Array([1, 2]));
    stdin.end();
    expect(await stdin.readAsync(buffer)).toBe(0);
    await expect(stdin.write(new Uint8Array([3]))).rejects.toMatchObject({ code: 'EPIPE' });
  });
  it('applies write backpressure and does not consume input for an aborted reader', async () => {
    const stdin = new BrowserStdin();
    let drained = false;
    const writing = stdin.write(new Uint8Array(65536)).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(await stdin.readAsync(new Uint8Array(1))).toBe(1);
    await writing;
    expect(drained).toBe(true);
    stdin.read(new Uint8Array(65536));
    const control = new AbortController();
    const read = stdin.readAsync(new Uint8Array(1), control.signal);
    control.abort();
    await expect(read).rejects.toMatchObject({ code: 'EINTR' });
    await stdin.write(new Uint8Array([7]));
    const remaining = new Uint8Array(1);
    expect(await stdin.readAsync(remaining)).toBe(1);
    expect(remaining[0]).toBe(7);
    stdin.close();
  });
});
