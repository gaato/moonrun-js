// `__moonbit_fs_unstable`: the V8 adapter half of moonrun's legacy filesystem imports
// (filesystem/v8/whole_file.rs, runtime.rs). The operations themselves, including policy
// checks and their texts, are the Host Filesystem and `Env` of the moonrun-policy
// component (ctx.policy()); this file only converts guest values and reports failures
// the way the adapter does (a Rust panic for the legacy imports, a status code otherwise).
import type { ImportFamily, RunContext } from '../context.ts';
import { fn, type ModuleImports } from '../define.ts';
import { rustPanic } from '../panic.ts';
import { lossyString, valueHelpers } from './fs-values.ts';

const WHOLE_FILE_RS = 'crates/moonrun/src/filesystem/v8/whole_file.rs';
const NOT_UINT8ARRAY = 'Failed to convert contents to Uint8Array';
/** `v8::Local::<v8::Uint8Array>::try_from(args.get(1)).unwrap()` on another value. */
const BAD_TYPE =
  'called `Result::unwrap()` on an `Err` value: BadType { actual: "v8::data::Value", expected: "v8::data::Uint8Array" }';

/** `args_get` and the environment imports (filesystem/v8/runtime.rs) over the run's `Env`. */
function runtimeImports(ctx: RunContext): ModuleImports {
  const env = () => ctx.policy().env();
  const getEnvVar = fn(['externref'], 'externref', (key) => env().get(lossyString(key)) ?? '');
  return {
    args_get: fn([], 'externref', () => [ctx.moduleName, ...ctx.args]),
    get_env_var: getEnvVar,
    env_get_var: getEnvVar,
    get_env_var_exists: fn(['externref'], 'i32', (key) =>
      env().get(lossyString(key)) === undefined ? 0 : 1,
    ),
    // `let _ = environment.set(...)`: invalid names and values are ignored.
    set_env_var: fn(['externref', 'externref'], 'void', (key, value) => {
      env().set(lossyString(key), lossyString(value));
    }),
    unset_env_var: fn(['externref'], 'void', (key) => {
      env().unset(lossyString(key));
    }),
    get_env_vars: fn([], 'externref', () => env().entries().flat()),
  };
}

/** The imports whose failure is a Rust panic (`whole_file.rs` line numbers). */
function legacyImports(ctx: RunContext): ModuleImports {
  const fs = () => ctx.policy();
  /** `.unwrap_or_else(|error| panic!("{error}"))` at `whole_file.rs:<line>:33`. */
  const orPanic = <T>(
    line: number,
    result: { ok: true; value: T } | { ok: false; error: string },
  ): T => {
    if (!result.ok) {
      return rustPanic(ctx, `${WHOLE_FILE_RS}:${line}:33`, result.error);
    }
    return result.value;
  };
  return {
    read_file_to_string: fn(['externref'], 'externref', (p) =>
      orPanic(63, fs().readFileToString(lossyString(p))),
    ),
    write_string_to_file: fn(['externref', 'externref'], 'void', (p, contents) => {
      orPanic(79, fs().writeStringToFile(lossyString(p), lossyString(contents)));
    }),
    write_bytes_to_file: fn(['externref', 'externref'], 'void', (p, contents) => {
      const result = fs().writeBytesToFile(
        lossyString(p),
        contents instanceof Uint8Array ? contents : undefined,
      );
      if (result === 'not-bytes') {
        rustPanic(ctx, `${WHOLE_FILE_RS}:93:76`, BAD_TYPE);
      }
      orPanic(96, result);
    }),
    create_dir: fn(['externref'], 'void', (p) => {
      orPanic(110, fs().createDir(lossyString(p)));
    }),
    read_dir: fn(['externref'], 'externref', (p) => orPanic(124, fs().readDir(lossyString(p)))),
    is_file: fn(['externref'], 'i32', (p) => (fs().isFile(lossyString(p)) ? 1 : 0)),
    is_dir: fn(['externref'], 'i32', (p) => (fs().isDir(lossyString(p)) ? 1 : 0)),
    remove_file: fn(['externref'], 'void', (p) => {
      orPanic(163, fs().removeFile(lossyString(p)));
    }),
    remove_dir: fn(['externref'], 'void', (p) => {
      orPanic(177, fs().removeDir(lossyString(p)));
    }),
    path_exists: fn(['externref'], 'i32', (p) => (fs().pathExists(lossyString(p)) ? 1 : 0)),
    current_dir: fn([], 'externref', () => fs().currentDir()),
  };
}

/** The `*_new` imports: a status code, with details fetched by the getters. */
function statusImports(ctx: RunContext): ModuleImports {
  const fs = () => ctx.policy();
  const status = (op: Parameters<ReturnType<typeof fs>['status']>[0]) =>
    fn(['externref'], 'i32', (p) => fs().status(op, lossyString(p)));
  return {
    read_file_to_bytes_new: status('read_file_to_bytes'),
    write_bytes_to_file_new: fn(['externref', 'externref'], 'i32', (p, contents) =>
      fs().writeBytesStatus(
        lossyString(p),
        contents instanceof Uint8Array ? contents : undefined,
        NOT_UINT8ARRAY,
      ),
    ),
    get_file_content: fn([], 'externref', () => fs().fileContent()),
    get_dir_files: fn([], 'externref', () => fs().dirFiles()),
    get_error_message: fn([], 'externref', () => fs().errorMessage()),
    create_dir_new: status('create_dir'),
    read_dir_new: status('read_dir'),
    is_file_new: status('is_file'),
    is_dir_new: status('is_dir'),
    remove_file_new: status('remove_file'),
    remove_dir_new: status('remove_dir'),
  };
}

/** `__moonbit_fs_unstable`: process arguments, environment, and whole-file filesystem access. */
export const fsUnstable: ImportFamily = (ctx) => ({
  ...valueHelpers(),
  ...runtimeImports(ctx),
  ...legacyImports(ctx),
  ...statusImports(ctx),
});
