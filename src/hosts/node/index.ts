import { randomFillSync } from 'node:crypto';
import type { Host } from '../../ports/host.ts';
import { nodeFs } from './fs.ts';
import { nodeStdio } from './stdio.ts';

export interface NodeHostOptions {
  /** Absolute path of the wasm file, for `current_exe`. */
  readonly currentExe?: string | undefined;
}

/** The ambient host: real stdio, environment, clock, randomness and filesystem. */
export function nodeHost(options: NodeHostOptions = {}): Host {
  return {
    stdio: nodeStdio(),
    env: {
      get: (key) => process.env[key],
      entries: () =>
        Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const])),
      set: (key, value) => {
        process.env[key] = value;
      },
      unset: (key) => {
        delete process.env[key];
      },
    },
    clock: {
      nowMs: () => Date.now(),
      monotonicNs: () => process.hrtime.bigint(),
    },
    random: {
      fill: (buffer) => {
        randomFillSync(buffer);
      },
    },
    fs: nodeFs(),
    platform: { currentExe: options.currentExe, pid: process.pid },
  };
}
