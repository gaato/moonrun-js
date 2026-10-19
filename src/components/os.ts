// The `host` (and `libc`) import modules of the wasm components: the OS-equivalent layer
// of crates/os, implemented over capabilities the ABI layer builds from the run's ports
// (src/abi/os-capabilities.ts). Paths arrive as raw bytes and are decoded as UTF-8 with
// replacement (D4). Failures are Linux errno numbers.

/** `{ ok: true, value }` or a Linux errno. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errno: number };

export type PathKind = 'file' | 'dir' | 'symlink' | 'other';

export interface OsCapabilities {
  readFile(path: string): Outcome<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Outcome<void>;
  /** UTF-8 names in directory order, without `.` and `..`. */
  readDir(path: string): Outcome<readonly string[]>;
  stat(path: string, follow: boolean): Outcome<PathKind>;
  mkdir(path: string): Outcome<void>;
  removeFile(path: string): Outcome<void>;
  /** Rust `remove_dir_all`: a symlink is unlinked, anything else must be a directory. */
  removeDirAll(path: string): Outcome<void>;
  realpath(path: string): Outcome<string>;
  cwd(): Outcome<string>;
  envEntries(): ReadonlyArray<readonly [string, string]>;
  getenv(name: string): string | undefined;
  setenv(name: string, value: string): void;
  unsetenv(name: string): void;
  strerror(errno: number): string;
  /** Synchronous, unbuffered (moonrun's `eprintln!`). */
  writeStderr(bytes: Uint8Array): void;
}

/** The component exports the imports need; bound after instantiation. */
export interface OsBinding {
  readonly memory: WebAssembly.Memory;
  os_result_alloc(len: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENOENT = 2;
const KIND: Readonly<Record<PathKind, number>> = { other: 0, file: 1, dir: 2, symlink: 3 };

/** Builds the import object; `binding()` must work by the time an import is called. */
export function osImports(caps: OsCapabilities, binding: () => OsBinding): WebAssembly.Imports {
  const bytesAt = (ptr: number, len: number): Uint8Array =>
    new Uint8Array(binding().memory.buffer, ptr, len);
  const text = (ptr: number, len: number): string => decoder.decode(bytesAt(ptr, len));
  /** C string at `ptr` (the `libc` imports). */
  const cString = (ptr: number): string => {
    const memory = new Uint8Array(binding().memory.buffer);
    const end = memory.indexOf(0, ptr);
    return decoder.decode(memory.subarray(ptr, end < 0 ? memory.length : end));
  };
  const give = (bytes: Uint8Array): number => {
    const target = binding();
    const ptr = target.os_result_alloc(bytes.length);
    new Uint8Array(target.memory.buffer, ptr, bytes.length).set(bytes);
    return 0;
  };
  const reply = <T>(outcome: Outcome<T>, encode: (value: T) => Uint8Array | undefined): number => {
    if (!outcome.ok) {
      return outcome.errno;
    }
    const bytes = encode(outcome.value);
    return bytes === undefined ? 0 : give(bytes);
  };
  const none = (): undefined => undefined;
  const list = (items: readonly string[]): Uint8Array =>
    encoder.encode(items.map((i) => `${i}\0`).join(''));
  return {
    host: {
      read_file: (p: number, l: number) => reply(caps.readFile(text(p, l)), (b) => b),
      write_file: (p: number, l: number, d: number, dl: number) =>
        reply(caps.writeFile(text(p, l), bytesAt(d, dl).slice()), none),
      read_dir: (p: number, l: number) => reply(caps.readDir(text(p, l)), list),
      stat: (p: number, l: number, follow: number) =>
        reply(caps.stat(text(p, l), follow !== 0), (k) => Uint8Array.of(KIND[k])),
      mkdir: (p: number, l: number) => reply(caps.mkdir(text(p, l)), none),
      remove_file: (p: number, l: number) => reply(caps.removeFile(text(p, l)), none),
      remove_dir_all: (p: number, l: number) => reply(caps.removeDirAll(text(p, l)), none),
      realpath: (p: number, l: number) =>
        reply(caps.realpath(text(p, l)), (s) => encoder.encode(s)),
      getcwd: () => reply(caps.cwd(), (s) => encoder.encode(s)),
      environ: () => give(list(caps.envEntries().map(([k, v]) => `${k}=${v}`))),
      getenv: (p: number, l: number) => {
        const value = caps.getenv(text(p, l));
        return value === undefined ? ENOENT : give(encoder.encode(value));
      },
      strerror: (errno: number) => give(encoder.encode(caps.strerror(errno))),
      write_stderr: (p: number, l: number) => {
        caps.writeStderr(bytesAt(p, l).slice());
      },
    },
    libc: {
      setenv: (name: number, value: number) => {
        caps.setenv(cString(name), cString(value));
        return 0;
      },
      unsetenv: (name: number) => {
        caps.unsetenv(cString(name));
        return 0;
      },
    },
  };
}

/** Capabilities that fail every call (for components that never touch the OS). */
export const NO_OS: OsCapabilities = {
  readFile: () => ({ ok: false, errno: ENOENT }),
  writeFile: () => ({ ok: false, errno: ENOENT }),
  readDir: () => ({ ok: false, errno: ENOENT }),
  stat: () => ({ ok: false, errno: ENOENT }),
  mkdir: () => ({ ok: false, errno: ENOENT }),
  removeFile: () => ({ ok: false, errno: ENOENT }),
  removeDirAll: () => ({ ok: false, errno: ENOENT }),
  realpath: () => ({ ok: false, errno: ENOENT }),
  cwd: () => ({ ok: false, errno: ENOENT }),
  envEntries: () => [],
  getenv: () => undefined,
  setenv: () => {},
  unsetenv: () => {},
  strerror: (errno) => `Unknown error ${errno}`,
  writeStderr: () => {},
};
