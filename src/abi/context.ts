import type { Diagnostics } from '../diagnostics/diag.ts';
import type { PolicyComponent } from '../domains/policy/component.ts';
import type { Stdio, Utf16Writer } from '../domains/stdio.ts';
import type { AsyncKernel } from '../kernel/async-kernel.ts';
import type { TerminationCell } from '../kernel/termination.ts';
import type { Host } from '../ports/host.ts';
import type { ModuleImports } from './define.ts';
import type { GuestMemory } from './memory.ts';

/** Per-run state shared by import families. Nothing here is module-global. */
export interface RunContext {
  readonly host: Host;
  readonly stdio: Stdio;
  readonly printWriter: Utf16Writer;
  readonly memory: GuestMemory;
  readonly termination: TerminationCell;
  /** The `moonbitlang/async` host state (shared with `moonbitlang/core`'s c_buffers). */
  readonly asyncKernel: AsyncKernel;
  /** Trap rendering and the memory sanitizer (moonrun-diag). */
  readonly diagnostics: Diagnostics;
  /**
   * The Run's policy, environment and Host Filesystem (moonrun-policy). Instantiated on
   * first use when no policy was loaded (an unchecked Host Filesystem).
   */
  policy(): PolicyComponent;
  /** argv[0]: the wasm path exactly as given. */
  readonly moduleName: string;
  readonly args: readonly string[];
  /** Registers a cleanup (e.g. closing host fds) that runs once when the run ends. */
  onTeardown(cleanup: () => void): void;
  /**
   * Registers a check that runs only when the run completes normally; a returned
   * message turns the outcome into a host failure (moonrun's memory-sanitizer leak check).
   */
  onCompleted(check: () => string | undefined): void;
  /**
   * Registers a host-state summary for `MOONBIT_ASYNC_CHECK_FD_LEAK` (moonrun's
   * `Drop for Runtime`): `undefined` when nothing leaked, else e.g. `sqlite(databases=1)`.
   * Summaries follow the async one in registration order.
   */
  onLeakCheck(summary: () => string | undefined): void;
}

/** A family builds the imports of one wasm import module for a run. */
export type ImportFamily = (ctx: RunContext) => ModuleImports;
