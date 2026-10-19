import type { RunOutcome } from '../../engine/run.ts';
import type { BrowserRunRequest, WorkerMessage, WorkerReply } from './execute.ts';
import type { BrowserSignalOptions } from './host.ts';
import type { ResolveCommand } from './process.ts';

export type { RunOutcome } from '../../engine/run.ts';
export type { BrowserRunRequest } from './execute.ts';
export {
  type BrowserHost,
  type BrowserHostOptions,
  type BrowserSignalOptions,
  createBrowserHost,
} from './host.ts';
export type { CommandContext, ResolveCommand } from './process.ts';
export { BrowserStdin } from './streams.ts';
export type { BrowserFiles } from './vfs.ts';

interface ModuleWorker {
  onmessage: ((event: { readonly data: WorkerReply }) => void) | null;
  onerror: ((event: { readonly message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(value: WorkerMessage): void;
  terminate(): void;
}
const web = globalThis as unknown as {
  Worker: new (url: URL, options: { type: 'module' }) => ModuleWorker;
};
export interface WorkerRunOptions
  extends Omit<BrowserRunRequest, 'stdin' | 'commands' | 'streaming'> {
  readonly stdin?: Uint8Array | 'stream';
  readonly resolveCommand?: ResolveCommand;
  readonly stdout?: (bytes: Uint8Array) => void;
  readonly stderr?: (bytes: Uint8Array) => void;
}
/** Still awaitable as before; input methods are available immediately, before preparation finishes. */
export interface BrowserRunHandle extends Promise<RunOutcome> {
  write(bytes: Uint8Array): Promise<void>;
  end(): void;
  signal(signal: number): void;
  signal(signal: number, options: BrowserSignalOptions): Promise<boolean>;
}
export function runInWorker(options: WorkerRunOptions): BrowserRunHandle {
  let write: BrowserRunHandle['write'] = async () => {
    throw new Error('Worker unavailable');
  };
  let end = (): void => {};
  let signal = (_signal: number, options?: BrowserSignalOptions): void | Promise<boolean> =>
    options === undefined ? undefined : Promise.resolve(false);
  const promise = new Promise<RunOutcome>((resolve, reject) => {
    const worker = new web.Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    let done = false;
    let ended = false;
    let id = 0;
    let writeTail = Promise.resolve();
    const inputs = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
    const signals = new Map<number, (delivered: boolean) => void>();
    const stop = (): void => {
      done = true;
      worker.terminate();
      for (const input of inputs.values()) input.reject(new Error('Run has ended'));
      inputs.clear();
      for (const resolve of signals.values()) resolve(false);
      signals.clear();
    };
    const finish = (outcome: RunOutcome): void => {
      if (!done) {
        stop();
        resolve(outcome);
      }
    };
    const failure = (e: unknown): void => {
      if (!done) {
        stop();
        reject(e);
      }
    };
    worker.onmessage = ({ data: reply }) => {
      try {
        switch (reply.type) {
          case 'outcome':
            finish(reply.outcome);
            break;
          case 'stdout':
            options.stdout?.(reply.bytes);
            break;
          case 'stderr':
            options.stderr?.(reply.bytes);
            break;
          case 'input-ack':
            inputs.get(reply.id)?.resolve();
            inputs.delete(reply.id);
            break;
          case 'signal-ack':
            signals.get(reply.id)?.(reply.delivered);
            signals.delete(reply.id);
            break;
          case 'resolve': {
            void (async () => {
              try {
                const wasm = await options.resolveCommand?.(
                  reply.program,
                  reply.args,
                  reply.context,
                );
                if (!done)
                  worker.postMessage({ type: 'resolved', id: reply.id, wasm, failed: false });
              } catch {
                try {
                  if (!done)
                    worker.postMessage({
                      type: 'resolved',
                      id: reply.id,
                      wasm: undefined,
                      failed: true,
                    });
                } catch (e) {
                  failure(e);
                }
              }
            })();
            break;
          }
        }
      } catch (e) {
        failure(e);
      }
    };
    worker.onerror = (event) =>
      finish({
        kind: 'host-failure',
        failure: { chain: [event.message || 'browser Worker failed'] },
      });
    worker.onmessageerror = () =>
      finish({
        kind: 'host-failure',
        failure: { chain: ['browser Worker message could not be cloned'] },
      });
    write = (bytes) => {
      if (done || ended || options.stdin !== 'stream')
        return Promise.reject(new Error('stdin is not open for streaming'));
      const copy = bytes.slice();
      const queued = writeTail.then(async () => {
        for (let offset = 0; offset < copy.length; offset += 65536) {
          if (done) throw new Error('Run has ended');
          const key = ++id;
          await new Promise<void>((resolve, reject) => {
            inputs.set(key, { resolve, reject });
            worker.postMessage({
              type: 'input',
              id: key,
              bytes: copy.slice(offset, offset + 65536),
            });
          });
        }
      });
      writeTail = queued.catch(() => {});
      return queued;
    };
    end = () => {
      if (ended) return;
      ended = true;
      void writeTail
        .then(() => {
          if (!done) worker.postMessage({ type: 'input-end' });
        })
        .catch(failure);
    };
    signal = (s, options) => {
      if (options?.target !== 'children') {
        if (!done) worker.postMessage({ type: 'signal', signal: s });
        return;
      }
      if (done) return Promise.resolve(false);
      const key = ++id;
      return new Promise<boolean>((resolve, reject) => {
        signals.set(key, resolve);
        try {
          worker.postMessage({ type: 'signal', signal: s, target: 'children', id: key });
        } catch (e) {
          signals.delete(key);
          reject(e);
        }
      });
    };
    const {
      stdout: _stdout,
      stderr: _stderr,
      resolveCommand: resolver,
      stdin,
      ...request
    } = options;
    try {
      worker.postMessage({
        type: 'run',
        request: {
          ...request,
          ...(stdin instanceof Uint8Array ? { stdin } : {}),
          streaming: stdin === 'stream',
          commands: resolver !== undefined,
        },
      });
    } catch (e) {
      failure(e);
    }
  });
  function sendSignal(s: number): void;
  function sendSignal(s: number, options: BrowserSignalOptions): Promise<boolean>;
  function sendSignal(s: number, options?: BrowserSignalOptions): void | Promise<boolean> {
    return signal(s, options);
  }
  return Object.assign(promise, {
    write: (b: Uint8Array) => write(b),
    end: () => end(),
    signal: sendSignal,
  });
}
