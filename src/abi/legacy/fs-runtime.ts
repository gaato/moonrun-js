import type { RunContext } from '../context.ts';
import { fn, type ModuleImports } from '../define.ts';
import { lossyString } from './fs-values.ts';

/** Linux `valid_name`: non-empty, no `=` and no NUL. */
function validName(name: string): boolean {
  return name !== '' && !name.includes('=') && !name.includes('\0');
}

/** Lookup also accepts a leading `=` (`valid_initial_name`). */
function validLookupName(name: string): boolean {
  return name.startsWith('=') ? !/[=\0]/.test(name.slice(1)) : validName(name);
}

function lookup(ctx: RunContext, key: unknown): string | undefined {
  const name = lossyString(key);
  return validLookupName(name) ? ctx.host.env.get(name) : undefined;
}

/** `args_get`, the environment imports and `current_dir`. */
export function runtimeImports(ctx: RunContext): ModuleImports {
  const getEnvVar = fn(['externref'], 'externref', (key) => lookup(ctx, key) ?? '');
  return {
    args_get: fn([], 'externref', () => [ctx.moduleName, ...ctx.args]),
    get_env_var: getEnvVar,
    env_get_var: getEnvVar,
    get_env_var_exists: fn(['externref'], 'i32', (key) => (lookup(ctx, key) === undefined ? 0 : 1)),
    // The legacy ABI has no error channel: invalid names and values are ignored.
    set_env_var: fn(['externref', 'externref'], 'void', (key, value) => {
      const name = lossyString(key);
      const text = lossyString(value);
      if (validName(name) && !text.includes('\0')) {
        ctx.host.env.set(name, text);
      }
    }),
    unset_env_var: fn(['externref'], 'void', (key) => {
      const name = lossyString(key);
      if (validName(name)) {
        ctx.host.env.unset(name);
      }
    }),
    get_env_vars: fn([], 'externref', () => ctx.host.env.entries().flat()),
    current_dir: fn([], 'externref', () => {
      const cwd = ctx.host.fs.cwd();
      return cwd.ok ? cwd.value : '';
    }),
  };
}
