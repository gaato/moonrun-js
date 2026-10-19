import type { ImportFamily, RunContext } from '../../abi/context.ts';
import { fn, type ImportDef } from '../../abi/define.ts';
import { FAMILIES } from '../../abi/families.ts';
import { compileBytes, fromCompiled } from '../../engine/load.ts';
import { type RunOutcome, run } from '../../engine/run.ts';
import type { Handle } from '../../kernel/handles.ts';
import { Children, feedChild } from '../../kernel/process.ts';
import { TerminationSignal } from '../../kernel/termination.ts';
import type { BrowserHost } from './host.ts';
import type { BrowserIo, ByteWriter } from './streams.ts';

/** Per-Run signal dispatch. Captured signals use the kernel; default action stops at suspension. */
export class BrowserControl {
  readonly abort = new AbortController();
  readonly #captures = new Map<number, Set<() => void>>();
  readonly #contexts = new Set<RunContext>();
  readonly #aborted: Promise<number>;
  #abort: (signal: number) => void = () => {};
  #signal: number | undefined;
  constructor() {
    this.#aborted = new Promise((resolve) => {
      this.#abort = resolve;
    });
  }
  readonly signals = {
    capture: (signal: number, handler: () => void): (() => void) => {
      const listeners = this.#captures.get(signal) ?? new Set<() => void>();
      listeners.add(handler);
      this.#captures.set(signal, listeners);
      return () => {
        listeners.delete(handler);
      };
    },
    raise: (signal: number): void => {
      this.stop(signal);
    },
  };
  send(signal: number): void {
    const captured = this.#captures.get(signal);
    if (signal !== 9 && captured !== undefined && captured.size > 0) {
      for (const handler of [...captured]) handler();
    } else this.stop(signal);
  }
  stop(signal: number): void {
    if (this.#signal !== undefined) return;
    this.#signal = signal;
    for (const ctx of this.#contexts) ctx.termination.request({ kind: 'signal', signal });
    this.#abort(signal);
    this.abort.abort();
  }
  termination(): RunOutcome | undefined {
    return this.#signal === undefined ? undefined : { kind: 'signaled', signal: this.#signal };
  }
  close(): void {
    this.abort.abort();
  }
  async drain(pending: Promise<void>[]): Promise<void> {
    await Promise.race([Promise.all(pending), this.#aborted]);
  }
  #check(ctx: RunContext): void {
    if (this.#signal !== undefined) {
      ctx.termination.request({ kind: 'signal', signal: this.#signal });
      throw new TerminationSignal();
    }
  }
  families(
    io: BrowserIo | undefined,
    bridges: Children,
    finishes: Promise<void>[],
  ): Readonly<Record<string, ImportFamily>> {
    const mapped = new Map<ByteWriter, Handle>();
    const writerHandle = (ctx: RunContext, writer: ByteWriter): Handle => {
      const known = mapped.get(writer);
      if (known !== undefined) return known;
      const [reader, handle] = ctx.asyncKernel.pipe(false, false);
      const end = ctx.asyncKernel.resources.pipe(reader);
      if (!end.ok) throw new Error('browser stdio pipe');
      finishes.push(
        new Promise<void>((resolve) => {
          const detach: (() => void)[] = [];
          const finish = (): void => {
            for (const off of detach.splice(0)) off();
            resolve();
          };
          feedChild(bridges, end.value, {
            ...writer,
            write: (b) => {
              try {
                return writer.write(b);
              } catch {
                writer.destroy();
                finish();
                return false;
              }
            },
            onDrain: (f) => {
              detach.push(writer.onDrain(f));
            },
            onClose: (f) => {
              detach.push(
                writer.onClose(() => {
                  f();
                  finish();
                }),
              );
            },
            end: finish,
            destroy: finish,
          });
        }),
      );
      ctx.asyncKernel.closeFd(reader);
      mapped.set(writer, handle);
      return handle;
    };
    return Object.fromEntries(
      Object.entries(FAMILIES).map(([name, family]) => [
        name,
        (ctx: RunContext) => {
          if (!this.#contexts.has(ctx)) {
            // Host-owned stdio adapters must not count as guest leaks on normal completion.
            ctx.onCompleted(() => {
              for (const handle of mapped.values()) ctx.asyncKernel.closeFd(handle);
              return undefined;
            });
            this.#contexts.add(ctx);
          }
          const defs: Record<string, ImportDef> = { ...family(ctx) };
          if (io !== undefined && name === 'moonbitlang/async') {
            const original = defs['stdio/get_stdio_handle'];
            defs['stdio/get_stdio_handle'] = fn(['i32'], 'u64', (id) => {
              if (id === 1 || id === 2) return writerHandle(ctx, id === 1 ? io.stdout : io.stderr);
              if (original?.kind !== 'function') throw new Error('missing stdio import');
              return (original.impl as (id: number) => bigint)(id);
            });
          }
          return Object.fromEntries(
            Object.entries(defs).map(([field, def]) => {
              const output =
                io !== undefined &&
                ((name === 'wasi_snapshot_preview1' && field === 'fd_write') ||
                  (name === 'spectest' && field === 'print_char') ||
                  (name === 'moonbit' && field === 'string_to_js_string') ||
                  (name === 'console' && field === 'log') ||
                  (name === '__moonbit_io_unstable' &&
                    (field === 'write_char' || field === 'flush')));
              return [
                field,
                def.kind !== 'function'
                  ? def
                  : ({
                      ...def,
                      suspends: def.suspends || output,
                      impl: (...args) => {
                        this.#check(ctx);
                        let result = def.impl(...args);
                        if (output) {
                          const pending = [io.stdout.ready(), io.stderr.ready()].filter(
                            (p) => p !== undefined,
                          );
                          if (pending.length > 0) {
                            const value = result;
                            result = Promise.all(pending).then(() => value);
                          }
                        }
                        if (!(result instanceof Promise)) return result;
                        return new Promise<unknown>((resolve, reject) => {
                          const abort = (): void => {
                            reject(new TerminationSignal());
                          };
                          this.abort.signal.addEventListener('abort', abort, { once: true });
                          result.then(
                            (value) => {
                              this.abort.signal.removeEventListener('abort', abort);
                              resolve(value);
                            },
                            (error: unknown) => {
                              this.abort.signal.removeEventListener('abort', abort);
                              reject(error);
                            },
                          );
                        });
                      },
                    } satisfies ImportDef),
              ];
            }),
          );
        },
      ]),
    );
  }
}

export async function runBrowserGuest(
  wasm: Uint8Array | WebAssembly.Module,
  name: string,
  args: readonly string[],
  host: BrowserHost,
  control: BrowserControl,
  io?: BrowserIo,
): Promise<RunOutcome> {
  const bridges = new Children();
  const finishes: Promise<void>[] = [];
  try {
    const stopped = control.termination();
    if (stopped !== undefined) return stopped;
    const loaded =
      wasm instanceof WebAssembly.Module
        ? { ok: true as const, value: fromCompiled(wasm, name, host.diagnostics) }
        : compileBytes(wasm, name, host.diagnostics);
    if (!loaded.ok) return { kind: 'host-failure', failure: loaded.error };
    const outcome = await run(loaded.value, host, {
      args,
      families: control.families(io, bridges, finishes),
    });
    // The engine closed the guest's pipe writers; drain buffered bytes before publishing exit.
    await control.drain(finishes);
    return control.termination() ?? outcome;
  } catch (e) {
    return { kind: 'host-failure', failure: { chain: [String(e)] } };
  } finally {
    control.close();
    bridges.teardown();
  }
}
