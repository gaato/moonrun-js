import type { Struct, Value } from './schema.ts';

/** `PolicyConfig` as deserialized (before canonicalization and validation). `null` = section absent. */
export interface PolicyConfig {
  readonly fs: { readonly read: readonly string[]; readonly write: readonly string[] } | null;
  readonly net: {
    readonly dns: readonly string[];
    readonly connect: readonly string[];
    readonly bind: readonly string[];
  } | null;
  readonly env: {
    readonly fromHost: readonly string[];
    readonly requiredFromHost: readonly string[];
    readonly set: ReadonlyMap<string, string>;
  } | null;
  readonly process: {
    readonly spawn: boolean;
    readonly allow: readonly { readonly program: string; readonly argsPrefix: readonly string[] }[];
  } | null;
}

const strings = (v: Value | undefined): string[] => (Array.isArray(v) ? (v as string[]) : []);
const section = (v: Value | undefined): Struct | null =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map)
    ? (v as Struct)
    : null;

/** Converts the schema output (which is shaped by `POLICY_SCHEMA`) into the typed config. */
export function toPolicyConfig(value: Value): PolicyConfig {
  const root = section(value) ?? {};
  const fs = section(root['fs']);
  const net = section(root['net']);
  const env = section(root['env']);
  const proc = section(root['process']);
  return {
    fs: fs && { read: strings(fs['read']), write: strings(fs['write']) },
    net: net && {
      dns: strings(net['dns']),
      connect: strings(net['connect']),
      bind: strings(net['bind']),
    },
    env: env && {
      fromHost: strings(env['from_host']),
      requiredFromHost: strings(env['required_from_host']),
      set: env['set'] instanceof Map ? env['set'] : new Map(),
    },
    process: proc && {
      spawn: proc['spawn'] === true,
      allow: (Array.isArray(proc['allow']) ? (proc['allow'] as Value[]) : []).map((rule) => {
        const r = section(rule) ?? {};
        return {
          program: typeof r['program'] === 'string' ? r['program'] : '',
          argsPrefix: strings(r['args_prefix']),
        };
      }),
    },
  };
}

/**
 * The payload moonrun publishes to children (`PolicyInheritance::from_config` +
 * `serde_json::to_vec_pretty`): the canonical config with `env` replaced by "copy everything from
 * the child's own environment". Field order and indentation match serde's derive output.
 */
export function serializeInheritedConfig(config: PolicyConfig): string {
  const doc = {
    fs: config.fs && { read: [...config.fs.read], write: [...config.fs.write] },
    net: config.net && {
      dns: [...config.net.dns],
      connect: [...config.net.connect],
      bind: [...config.net.bind],
    },
    env: {
      from_host: ['*'],
      required_from_host: [] as string[],
      set: {} as Record<string, string>,
    },
    process: config.process && {
      spawn: config.process.spawn,
      allow: config.process.allow.map((r) => ({
        program: r.program,
        args_prefix: [...r.argsPrefix],
      })),
    },
  };
  return JSON.stringify(doc, null, 2);
}
