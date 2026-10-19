import { compileBytes } from '../../engine/load.ts';
import { type RunOutcome, run } from '../../engine/run.ts';
import { type BrowserHostOptions, createBrowserHost } from './host.ts';

export interface BrowserRunRequest extends Omit<BrowserHostOptions, 'stdout' | 'stderr' | 'stdin'> {
  readonly wasm: Uint8Array;
  readonly args?: readonly string[];
  readonly name?: string;
  readonly stdin?: Uint8Array;
}
export type WorkerReply =
  | { readonly type: 'stdout' | 'stderr'; readonly bytes: Uint8Array }
  | { readonly type: 'outcome'; readonly outcome: RunOutcome };

/** Worker body separated from its message transport for Node contract tests. */
export async function executeBrowserRun(
  request: BrowserRunRequest,
  send: (reply: WorkerReply) => void,
): Promise<void> {
  let outcome: RunOutcome;
  try {
    const host = await createBrowserHost({
      ...request,
      stdout: (bytes) => send({ type: 'stdout', bytes }),
      stderr: (bytes) => send({ type: 'stderr', bytes }),
    });
    const loaded = compileBytes(
      request.wasm,
      request.name ?? '/work/program.wasm',
      host.diagnostics,
    );
    outcome = loaded.ok
      ? await run(loaded.value, host, { args: request.args ?? [] })
      : { kind: 'host-failure', failure: loaded.error };
  } catch (e) {
    outcome = { kind: 'host-failure', failure: { chain: [String(e)] } };
  }
  send({ type: 'outcome', outcome });
}
