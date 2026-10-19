import {
  type BrowserRunRequest,
  executeBrowserRun,
  type WorkerMessage,
  type WorkerReply,
} from './execute.ts';
import { BrowserStdin } from './streams.ts';

const scope = globalThis as unknown as {
  onmessage: (event: { readonly data: WorkerMessage }) => void;
  postMessage(reply: WorkerReply): void;
};
const stdin = new BrowserStdin();
const pending = new Map<
  number,
  { resolve: (wasm: Uint8Array | WebAssembly.Module | undefined) => void; reject: () => void }
>();
let nextRequest = 0;
let started = false;
let deliver: ((signal: number) => void) | undefined;
const signals: number[] = [];
function start(request: BrowserRunRequest): void {
  void executeBrowserRun(request, (reply) => scope.postMessage(reply), {
    ...(request.streaming === true ? { stdin } : {}),
    ...(request.commands === true
      ? {
          resolveCommand: (program, args, context) =>
            new Promise<Uint8Array | WebAssembly.Module | undefined>((resolve, reject) => {
              const id = ++nextRequest;
              pending.set(id, {
                resolve,
                reject: () => reject(new Error('command resolver failed')),
              });
              scope.postMessage({ type: 'resolve', id, program, args, context });
            }),
        }
      : {}),
    ready: (signal) => {
      deliver = signal;
      for (const s of signals.splice(0)) signal(s);
    },
  });
}
scope.onmessage = ({ data }) => {
  switch (data.type) {
    case 'run':
      if (!started) {
        started = true;
        start(data.request);
      }
      break;
    case 'input':
      void stdin.write(data.bytes).then(
        () => scope.postMessage({ type: 'input-ack', id: data.id }),
        () => scope.postMessage({ type: 'input-ack', id: data.id }),
      );
      break;
    case 'input-end':
      stdin.end();
      break;
    case 'signal':
      if (deliver === undefined) signals.push(data.signal);
      else deliver(data.signal);
      break;
    case 'resolved': {
      const callback = pending.get(data.id);
      pending.delete(data.id);
      if (data.failed) callback?.reject();
      else callback?.resolve(data.wasm);
      break;
    }
  }
};
