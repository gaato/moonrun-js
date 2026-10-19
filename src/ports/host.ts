import type { ClockPort } from './clock.ts';
import type { EnvPort } from './env.ts';
import type { FilePort } from './files.ts';
import type { FsPort } from './fs.ts';
import type { RandomPort } from './random.ts';
import type { StdioPort } from './stdio.ts';

/** Everything a run may touch on the host. Missing capabilities use `unsupported` implementations, never `undefined`. */
export interface Host {
  readonly stdio: StdioPort;
  readonly env: EnvPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly fs: FsPort;
  readonly files: FilePort;
  readonly platform: HostPlatform;
}

export interface HostPlatform {
  /** Absolute path of the running wasm file, when it came from a file. */
  readonly currentExe: string | undefined;
  /** Process id shown where moonrun prints OS thread or process ids. */
  readonly pid: number;
}
