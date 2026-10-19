import type { RunOutcome } from '../../engine/run.ts';
import type { BrowserRunRequest, WorkerReply } from './execute.ts';

export type { RunOutcome } from '../../engine/run.ts';
export type { BrowserRunRequest } from './execute.ts';
export { type BrowserHost, type BrowserHostOptions, createBrowserHost } from './host.ts';
export type { BrowserFiles } from './vfs.ts';

// Keep DOM declarations local: lib.dom would override the core's Wasm GC/JSPI typings.
interface ModuleWorker {
  onmessage: ((event: { readonly data: WorkerReply }) => void) | null;
  onerror: ((event: { readonly message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(value: BrowserRunRequest): void;
  terminate(): void;
}
const web = globalThis as unknown as {
  Worker: new (url: URL, options: { type: 'module' }) => ModuleWorker;
};

export interface WorkerRunOptions extends BrowserRunRequest {
  readonly stdout?: (bytes: Uint8Array) => void;
  readonly stderr?: (bytes: Uint8Array) => void;
}
/** A fresh module Worker per run. Streams bytes and terminates the Worker on every outcome. */
export function runInWorker(options: WorkerRunOptions): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new web.Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const finish = (outcome: RunOutcome): void => {
      worker.terminate();
      resolve(outcome);
    };
    worker.onmessage = (event: { readonly data: WorkerReply }) => {
      try {
        const reply = event.data;
        if (reply.type === 'outcome') finish(reply.outcome);
        else if (reply.type === 'stdout') options.stdout?.(reply.bytes);
        else options.stderr?.(reply.bytes);
      } catch (e) {
        worker.terminate();
        reject(e);
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
    const { stdout: _stdout, stderr: _stderr, ...request } = options;
    try {
      worker.postMessage(request);
    } catch (e) {
      worker.terminate();
      reject(e);
    }
  });
}
