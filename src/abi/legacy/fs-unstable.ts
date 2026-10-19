import { err, type HostError, hostError, ok, type Result } from '../../ports/result.ts';
import type { ImportFamily, RunContext } from '../context.ts';
import { fn, type ModuleImports } from '../define.ts';
import { rustIoErrorText } from '../errno.ts';
import { rustPanic } from '../panic.ts';
import { runtimeImports } from './fs-runtime.ts';
import { lossyString, valueHelpers } from './fs-values.ts';

const WHOLE_FILE_RS = 'crates/moonrun/src/filesystem/v8/whole_file.rs';
const NUL_IN_PATH = 'file name contained an unexpected NUL byte';
const NOT_UINT8ARRAY = 'Failed to convert contents to Uint8Array';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Failures are carried as Rust `io::Error` Display text. */
type Io<T> = Result<T, string>;

/** Runs a port call the way Rust's `std::fs` sees a path: no NUL, and `""` never exists. */
function io<T>(path: string, run: () => Result<T, HostError>): Io<T> {
  if (path.includes('\0')) {
    return err(NUL_IN_PATH);
  }
  const result = path === '' ? err(hostError('ENOENT')) : run();
  return result.ok ? result : err(rustIoErrorText(result.error));
}

/** Per-run results retained between an operation and its getter (moonrun `FsOperationResults`). */
interface OperationResults {
  fileContent: Uint8Array;
  dirFiles: string[];
  errorMessage: string;
}

function readString(ctx: RunContext, path: string): Io<string> {
  const bytes = io(path, () => ctx.host.fs.readFile(path));
  if (!bytes.ok) {
    return bytes;
  }
  try {
    return ok(utf8.decode(bytes.value));
  } catch {
    return err('stream did not contain valid UTF-8');
  }
}

function createDirAll(ctx: RunContext, path: string): Io<void> {
  // Rust `create_dir_all("")` succeeds; Node would fail.
  return path === '' ? ok(undefined) : io(path, () => ctx.host.fs.mkdirAll(path));
}

/** Rust `Path::is_file` / `is_dir` / `exists`: any error reads as false. */
function isKind(ctx: RunContext, path: string, kind: 'file' | 'dir' | undefined): number {
  const found = io(path, () => ctx.host.fs.kind(path));
  return found.ok && (kind === undefined || found.value === kind) ? 1 : 0;
}

/** The imports whose failure is a Rust panic (`whole_file.rs` line numbers). */
function legacyImports(ctx: RunContext): ModuleImports {
  const panicAt = (line: number, message: string): never =>
    rustPanic(ctx, `${WHOLE_FILE_RS}:${line}:33`, message);
  const orPanic = <T>(line: number, what: string, path: string, result: Io<T>): T => {
    if (!result.ok) {
      return panicAt(line, `${what}: ${path}`);
    }
    return result.value;
  };
  return {
    read_file_to_string: fn(['externref'], 'externref', (p) => {
      const path = lossyString(p);
      return orPanic(63, 'Failed to read file', path, readString(ctx, path));
    }),
    write_string_to_file: fn(['externref', 'externref'], 'void', (p, contents) => {
      const path = lossyString(p);
      const data = encoder.encode(lossyString(contents));
      orPanic(
        79,
        'Failed to write file',
        path,
        io(path, () => ctx.host.fs.writeFile(path, data)),
      );
    }),
    write_bytes_to_file: fn(['externref', 'externref'], 'void', (p, contents) => {
      const path = lossyString(p);
      if (!(contents instanceof Uint8Array)) {
        rustPanic(
          ctx,
          `${WHOLE_FILE_RS}:93:76`,
          'called `Result::unwrap()` on an `Err` value: BadType { actual: "v8::data::Value", expected: "v8::data::Uint8Array" }',
        );
      }
      const data = contents;
      orPanic(
        96,
        'Failed to write file',
        path,
        io(path, () => ctx.host.fs.writeFile(path, data)),
      );
    }),
    create_dir: fn(['externref'], 'void', (p) => {
      const path = lossyString(p);
      orPanic(110, 'Failed to create directory', path, createDirAll(ctx, path));
    }),
    read_dir: fn(['externref'], 'externref', (p) => {
      const path = lossyString(p);
      return orPanic(
        124,
        'Failed to read directory',
        path,
        io(path, () => ctx.host.fs.readDir(path)),
      );
    }),
    is_file: fn(['externref'], 'i32', (p) => isKind(ctx, lossyString(p), 'file')),
    is_dir: fn(['externref'], 'i32', (p) => isKind(ctx, lossyString(p), 'dir')),
    remove_file: fn(['externref'], 'void', (p) => {
      const path = lossyString(p);
      orPanic(
        163,
        'Failed to remove file',
        path,
        io(path, () => ctx.host.fs.removeFile(path)),
      );
    }),
    remove_dir: fn(['externref'], 'void', (p) => {
      const path = lossyString(p);
      orPanic(
        177,
        'Failed to remove directory',
        path,
        io(path, () => ctx.host.fs.removeDirAll(path)),
      );
    }),
    path_exists: fn(['externref'], 'i32', (p) => isKind(ctx, lossyString(p), undefined)),
  };
}

/** The `*_new` imports: a status code, with details fetched by the getters. */
function statusImports(ctx: RunContext): ModuleImports {
  const results: OperationResults = {
    fileContent: new Uint8Array(0),
    dirFiles: [],
    errorMessage: '',
  };
  const fail = (message: string): number => {
    results.errorMessage = message;
    return -1;
  };
  /** Runs `op` and maps its failure to `<what> <path>: <error>` (`prefix` None means `<error>: <path>`). */
  const status = <T>(
    path: string,
    what: string | undefined,
    op: () => Io<T>,
    onOk: (value: T) => number,
  ): number => {
    const result = op();
    if (result.ok) {
      return onOk(result.value);
    }
    return fail(
      what === undefined ? `${result.error}: ${path}` : `${what} ${path}: ${result.error}`,
    );
  };
  const done = (): number => 0;
  return {
    read_file_to_bytes_new: fn(['externref'], 'i32', (p) => {
      const path = lossyString(p);
      return status(
        path,
        'Failed to read file',
        () => io(path, () => ctx.host.fs.readFile(path)),
        (bytes) => {
          results.fileContent = bytes;
          return 0;
        },
      );
    }),
    write_bytes_to_file_new: fn(['externref', 'externref'], 'i32', (p, contents) => {
      const path = lossyString(p);
      if (!(contents instanceof Uint8Array)) {
        return fail(NOT_UINT8ARRAY);
      }
      const data = contents;
      return status(
        path,
        'Failed to write file',
        () => io(path, () => ctx.host.fs.writeFile(path, data)),
        done,
      );
    }),
    get_file_content: fn([], 'externref', () => results.fileContent.slice()),
    get_dir_files: fn([], 'externref', () => [...results.dirFiles]),
    get_error_message: fn([], 'externref', () => results.errorMessage),
    create_dir_new: fn(['externref'], 'i32', (p) => {
      const path = lossyString(p);
      return status(path, 'Failed to create directory', () => createDirAll(ctx, path), done);
    }),
    read_dir_new: fn(['externref'], 'i32', (p) => {
      const path = lossyString(p);
      return status(
        path,
        'Failed to read directory',
        () => io(path, () => ctx.host.fs.readDir(path)),
        (files) => {
          results.dirFiles = files;
          return 0;
        },
      );
    }),
    is_file_new: fn(['externref'], 'i32', (p) => kindStatus(p, 'file')),
    is_dir_new: fn(['externref'], 'i32', (p) => kindStatus(p, 'dir')),
    remove_file_new: fn(['externref'], 'i32', (p) => {
      const path = lossyString(p);
      return status(
        path,
        'Failed to remove file',
        () => io(path, () => ctx.host.fs.removeFile(path)),
        done,
      );
    }),
    remove_dir_new: fn(['externref'], 'i32', (p) => {
      const path = lossyString(p);
      return status(
        path,
        'Failed to remove directory',
        () => io(path, () => ctx.host.fs.removeDirAll(path)),
        done,
      );
    }),
  };

  function kindStatus(p: unknown, kind: 'file' | 'dir'): number {
    const path = lossyString(p);
    return status(
      path,
      undefined,
      () => io(path, () => ctx.host.fs.kind(path)),
      (found) => (found === kind ? 1 : 0),
    );
  }
}

/** `__moonbit_fs_unstable`: process arguments, environment, and whole-file filesystem access. */
export const fsUnstable: ImportFamily = (ctx) => ({
  ...valueHelpers(),
  ...runtimeImports(ctx),
  ...legacyImports(ctx),
  ...statusImports(ctx),
});
