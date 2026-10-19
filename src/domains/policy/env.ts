import { err, ok, type Result } from '../../ports/result.ts';
import { rustDebugStr } from './rust-fmt.ts';

export interface EnvConfig {
  readonly fromHost: readonly string[];
  readonly requiredFromHost: readonly string[];
  readonly set: ReadonlyMap<string, string>;
}

export type EnvEntries = ReadonlyArray<readonly [string, string]>;

function validName(name: string): boolean {
  // Unix `valid_initial_name`: a leading '=' is allowed, otherwise no '=' and no NUL.
  const body = name.startsWith('=') ? name.slice(1) : name;
  return (name.startsWith('=') || body !== '') && !body.includes('=') && !body.includes('\0');
}

/** Rust `OsString` ordering on Unix is byte order, i.e. UTF-8 / code point order. */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) {
      return x.done === y.done ? 0 : x.done ? -1 : 1;
    }
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
  }
}

/**
 * `EnvProvisioning::new` + `Env::owned`: the environment a policy run starts with.
 * `*` in `from_host` copies every host variable; named entries are copied next (a duplicate name
 * within one list is an error; a missing `required_from_host` name is an error); `set` overrides.
 * The result is sorted by name and has unique names. Errors are single-element anyhow chains.
 */
export function provisionEnv(
  config: EnvConfig,
  hostEnv: EnvEntries,
): Result<EnvEntries, readonly string[]> {
  const vars: Array<readonly [string, string]> = [];
  if (config.fromHost.includes('*')) {
    vars.push(...hostEnv);
  }
  const lookup = (name: string): string | undefined => hostEnv.find(([k]) => k === name)?.[1];
  const copy = (names: readonly string[], required: boolean): string | undefined => {
    const seen = new Set<string>();
    for (const name of names) {
      if (name === '*') {
        continue;
      }
      if (seen.has(name)) {
        return `duplicate environment policy entry ${rustDebugStr(name)}`;
      }
      seen.add(name);
      const value = lookup(name);
      if (value !== undefined) {
        vars.push([name, value]);
      } else if (required) {
        return `required host environment variable ${rustDebugStr(name)} is not set`;
      }
    }
    return undefined;
  };
  const first = copy(config.fromHost, false) ?? copy(config.requiredFromHost, true);
  if (first !== undefined) {
    return err([first]);
  }
  for (const [name, value] of [...config.set].sort(([a], [b]) => compareCodePoints(a, b))) {
    vars.push([name, value]);
  }
  for (const [name, value] of vars) {
    if (!validName(name)) {
      return err([`invalid environment variable name ${rustDebugStr(name)}`]);
    }
    if (value.includes('\0')) {
      return err([`environment variable ${rustDebugStr(name)} contains a NUL in its value`]);
    }
  }
  const unique = new Map<string, string>();
  for (const [name, value] of vars) {
    unique.set(name, value);
  }
  return ok([...unique].sort(([a], [b]) => compareCodePoints(a, b)));
}
