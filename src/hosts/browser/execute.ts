import type { RunOutcome } from '../../engine/run.ts';
import type { HostError, Result } from '../../ports/result.ts';
import { type BrowserHostOptions, type BrowserSignalOptions, createBrowserHost } from './host.ts';
import type { BrowserMemoryFs, MemoryFsRequest, MemoryFsValue } from './memory-fs.ts';
import type { BrowserMounts } from './mount-provider.ts';
import type { MountCall, MountDescriptions, MountValue } from './mount-rpc.ts';
import type { CommandContext, ResolveCommand } from './process.ts';
import type { BrowserStdin } from './streams.ts';

export interface BrowserRunRequest
  extends Omit<BrowserHostOptions, 'stdout' | 'stderr' | 'stdin' | 'resolveCommand' | 'mounts'> {
  readonly wasm: Uint8Array;
  readonly args?: readonly string[];
  readonly name?: string;
  readonly stdin?: Uint8Array;
  readonly streaming?: boolean;
  readonly commands?: boolean;
  readonly mounts?: MountDescriptions;
}
export type WorkerReply =
  | {
      readonly type: 'mount';
      readonly id: number;
      readonly mount: string;
      readonly request: MountCall;
    }
  | { readonly type: 'stdout' | 'stderr'; readonly bytes: Uint8Array }
  | { readonly type: 'outcome'; readonly outcome: RunOutcome }
  | { readonly type: 'input-ack'; readonly id: number }
  | {
      readonly type: 'fs-result';
      readonly id: number;
      readonly result: Result<MemoryFsValue, HostError>;
    }
  | { readonly type: 'signal-ack'; readonly id: number; readonly delivered: boolean }
  | {
      readonly type: 'resolve';
      readonly id: number;
      readonly program: string;
      readonly args: readonly string[];
      readonly context: CommandContext;
    };
export type WorkerMessage =
  | {
      readonly type: 'mounted';
      readonly id: number;
      readonly result: Result<MountValue, HostError>;
    }
  | { readonly type: 'run'; readonly request: BrowserRunRequest }
  | { readonly type: 'input'; readonly id: number; readonly bytes: Uint8Array }
  | { readonly type: 'input-end' }
  | { readonly type: 'fs'; readonly id: number; readonly request: MemoryFsRequest }
  | {
      readonly type: 'signal';
      readonly signal: number;
      readonly target?: 'group';
      readonly id?: number;
    }
  | {
      readonly type: 'resolved';
      readonly id: number;
      readonly wasm: Uint8Array | WebAssembly.Module | undefined;
      readonly failed: boolean;
    };

/** Worker body separated from transport for contract tests and non-browser embedders. */
export async function executeBrowserRun(
  request: BrowserRunRequest,
  send: (reply: WorkerReply) => void,
  capabilities: {
    readonly stdin?: BrowserStdin;
    readonly resolveCommand?: ResolveCommand;
    readonly mounts?: BrowserMounts;
    readonly ready?: (
      signal: (signal: number, options?: BrowserSignalOptions) => boolean,
      fs: BrowserMemoryFs,
    ) => void;
  } = {},
): Promise<void> {
  let outcome: RunOutcome;
  try {
    const { mounts: _mounts, ...hostOptions } = request;
    const host = await createBrowserHost({
      ...hostOptions,
      ...(capabilities.mounts === undefined ? {} : { mounts: capabilities.mounts }),
      ...(capabilities.stdin === undefined ? {} : { stdin: capabilities.stdin }),
      ...(capabilities.resolveCommand === undefined
        ? {}
        : { resolveCommand: capabilities.resolveCommand }),
      stdout: (bytes) => send({ type: 'stdout', bytes }),
      stderr: (bytes) => send({ type: 'stderr', bytes }),
    });
    capabilities.ready?.((signal, options) => {
      if (options !== undefined) return host.signal(signal, options);
      host.signal(signal);
      return true;
    }, host.memoryFs);
    outcome = await host.run(request.wasm, {
      name: request.name ?? '/work/program.wasm',
      args: request.args ?? [],
    });
  } catch (e) {
    outcome = { kind: 'host-failure', failure: { chain: [String(e)] } };
  }
  send({ type: 'outcome', outcome });
}
