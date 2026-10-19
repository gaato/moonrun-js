import type { Stdio, Utf16Writer } from '../domains/stdio.ts';
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
  /** argv[0]: the wasm path exactly as given. */
  readonly moduleName: string;
  readonly args: readonly string[];
}

/** A family builds the imports of one wasm import module for a run. */
export type ImportFamily = (ctx: RunContext) => ModuleImports;
