import type { ImportFamily } from './context.ts';
import { exception } from './legacy/exception.ts';
import { ffiBytes } from './legacy/ffi-bytes.ts';
import { fsUnstable } from './legacy/fs-unstable.ts';
import { io } from './legacy/io.ts';
import { consoleLog, moonbit, spectest } from './legacy/print.ts';
import { sys } from './legacy/sys.ts';
import { time } from './legacy/time.ts';

/** Every wasm import module moonrun provides, keyed by module name. */
export const FAMILIES: Readonly<Record<string, ImportFamily>> = {
  spectest,
  moonbit,
  console: consoleLog,
  __moonbit_time_unstable: time,
  __moonbit_sys_unstable: sys,
  __moonbit_io_unstable: io,
  __moonbit_fs_unstable: fsUnstable,
  exception,
  'ffi-bytes': ffiBytes,
};
