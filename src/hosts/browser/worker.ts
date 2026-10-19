import { type BrowserRunRequest, executeBrowserRun, type WorkerReply } from './execute.ts';

// This entry runs once per dedicated Worker. No ambient DOM access is needed.
const scope = globalThis as unknown as {
  onmessage: (event: { readonly data: BrowserRunRequest }) => void;
  postMessage(reply: WorkerReply): void;
};
scope.onmessage = (event) => {
  scope.onmessage = () => {};
  void executeBrowserRun(event.data, (reply) => scope.postMessage(reply));
};
